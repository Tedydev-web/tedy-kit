import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SHELL_WRAPPER = /^(?:bash|sh|zsh|dash|ksh)\s+(?:--login\s+)?-[a-zA-Z]*c[a-zA-Z]*\s+(?:--\s+)?(['"])([\s\S]*)\1$/;
const HEREDOC = /(?<!<)<<(?!<)(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;

function skipHeredocs(command, index, line) {
  let at = index;
  for (const [, dash, , tag] of line.matchAll(HEREDOC)) {
    while (at < command.length) {
      const end = command.indexOf("\n", at + 1);
      const body = command.slice(at + 1, end === -1 ? command.length : end);
      at = end === -1 ? command.length : end;
      if ((dash ? body.replace(/^\t+/, "") : body) === tag) break;
    }
  }
  return at;
}

export function splitParts(command, unwrap = true) {
  const segments = [];
  let current = "";
  let line = "";
  let quote = null;
  let piped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const pair = command.slice(index, index + 2);
    if (quote) {
      if (char === "\\" && quote === '"') {
        current += char + (command[index + 1] ?? "");
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      current += char;
      line += /[\w'"]/.test(char) ? char : " ";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      line += char;
      continue;
    }
    if (char === "\\" && command[index + 1] === "\n") {
      index += 1;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      current += pair;
      line += pair;
      index += 1;
      continue;
    }
    if (pair === "&&" || pair === "||") {
      line += pair;
      segments.push({ text: current, piped });
      current = "";
      piped = false;
      index += 1;
      continue;
    }
    if (char === "\n") {
      index = skipHeredocs(command, index, line);
      line = "";
      segments.push({ text: current, piped });
      current = "";
      piped = false;
      continue;
    }
    if (char === ";" || char === "|") {
      line += char;
      segments.push({ text: current, piped });
      current = "";
      piped = char === "|";
      continue;
    }
    line += char;
    current += char;
  }
  segments.push({ text: current, piped });
  return segments
    .map((part) => ({ text: part.text.trim(), piped: part.piped }))
    .filter((part) => part.text)
    .flatMap((part) => {
      const wrapped = unwrap && part.text.match(SHELL_WRAPPER);
      if (!wrapped) return [part];
      const inner = splitParts(wrapped[2]);
      return inner.map((item, index) => (index === 0 && part.piped ? { ...item, piped: true } : item));
    });
}

export function splitSegments(command, unwrap = true) {
  return splitParts(command, unwrap).map((part) => part.text);
}

export function tokenize(segment) {
  const tokens = [];
  let current = "";
  let quote = null;
  let started = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && /["\\$`]/.test(segment[index + 1] ?? "")) current += segment[(index += 1)];
      else current += char;
      continue;
    }
    if (char === "\\") {
      const next = segment[(index += 1)];
      if (next !== undefined && next !== "\n") {
        current += next;
        started = true;
      }
      continue;
    }
    if (char === "$" && (segment[index + 1] === "'" || segment[index + 1] === '"')) {
      quote = segment[(index += 1)];
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    if ((char === "<" || char === ">") && segment[index + 1] !== "(" && started && !/^(\d*|&)$|[<>]$/.test(current)) {
      tokens.push(current);
      current = "";
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

export const shellWords = (segment) => tokenize(segment).join(" ");

const MAX_SUBSTITUTION_DEPTH = 20;

export function substitutions(command) {
  const bodies = [];
  const open = [];
  let quote = null;
  let tick = -1;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "'" && !quote) quote = "'";
    else if (char === '"') quote = quote ? null : '"';
    else if (char === "`") {
      if (tick === -1) tick = index + 1;
      else {
        bodies.push(command.slice(tick, index));
        tick = -1;
      }
    } else if (command[index + 1] === "(" && (char === "$" || char === "<" || char === ">")) {
      open.push(index + 2);
      if (open.length > MAX_SUBSTITUTION_DEPTH) return null;
      index += 1;
    } else if (char === ")" && open.length) bodies.push(command.slice(open.pop(), index));
  }
  if (tick !== -1) bodies.push(command.slice(tick));
  for (const start of open) bodies.push(command.slice(start));
  return bodies;
}

export const expandHome = (path) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);

export function* walkSegments(command, cwd) {
  let dir = cwd;
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    if (tokens[0] === "cd") {
      dir = resolve(dir, expandHome(tokens[1] ?? "~"));
      continue;
    }
    yield { dir, tokens };
  }
}
