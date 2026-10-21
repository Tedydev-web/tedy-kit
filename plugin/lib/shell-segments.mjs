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
  let depth = 0;
  let nested = 0;
  let tick = false;
  const end = (next = false) => {
    segments.push({ text: current, piped, depth });
    current = "";
    piped = next;
  };
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
    if (/^[$<>]\($/.test(pair)) {
      nested += 1;
      current += pair;
      line += pair;
      index += 1;
      continue;
    }
    if (char === "`") {
      tick = !tick;
      current += char;
      line += char;
      continue;
    }
    if (nested > 0 && (char === "(" || char === ")")) {
      nested += char === "(" ? 1 : -1;
      current += char;
      line += char;
      continue;
    }
    if (nested > 0 || tick) {
      current += char;
      line = char === "\n" ? "" : line + char;
      continue;
    }
    const definition = char === "(" && current.trim() ? command.slice(index).match(/^\(\s*\)/) : null;
    if (definition) {
      current += definition[0];
      line += definition[0];
      index += definition[0].length - 1;
      continue;
    }
    if (char === "(" || char === ")") {
      line += char;
      end();
      depth = Math.max(0, depth + (char === "(" ? 1 : -1));
      continue;
    }
    if (pair === "&&" || pair === "||") {
      line += pair;
      end();
      index += 1;
      continue;
    }
    if (char === "\n") {
      index = skipHeredocs(command, index, line);
      line = "";
      end();
      continue;
    }
    if (char === "&" && command[index - 1] === "|") continue;
    if (char === "&" && !/[<>]/.test(command[index - 1] ?? "") && command[index + 1] !== ">") {
      line += char;
      end();
      continue;
    }
    if (char === ";" || char === "|") {
      line += char;
      end(char === "|");
      continue;
    }
    line += char;
    current += char;
  }
  end();
  return segments
    .map((part) => ({ ...part, text: part.text.trim() }))
    .filter((part) => part.text)
    .flatMap((part) => {
      const wrapped = unwrap && part.text.match(SHELL_WRAPPER);
      if (!wrapped) return [part];
      const inner = splitParts(wrapped[2]);
      return inner.map((item, index) => ({ ...item, depth: item.depth + part.depth, piped: item.piped || (index === 0 && part.piped) }));
    });
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const LEADING_WORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "{", "!", "builtin", "command"]);

export function* walkParts(command, cwd, unwrap = true) {
  const scopes = [{ dir: cwd, stack: [] }];
  for (const part of splitParts(command, unwrap)) {
    while (scopes.length > part.depth + 1) scopes.pop();
    while (scopes.length < part.depth + 1) scopes.push({ dir: scopes.at(-1).dir, stack: [...scopes.at(-1).stack] });
    const scope = scopes.at(-1);
    if (!/\b(?:cd|pushd|popd)\b/.test(part.text)) {
      yield { ...part, dir: scope.dir, changesDir: false };
      continue;
    }
    const tokens = tokenize(part.text);
    let at = 0;
    for (;;) {
      if (at < tokens.length && (ASSIGNMENT.test(tokens[at]) || LEADING_WORDS.has(tokens[at]))) at += 1;
      else if (tokens[at] === "time") {
        at += 1;
        while (tokens[at]?.startsWith("-")) at += 1;
      } else break;
    }
    const [word, ...args] = tokens.slice(at);
    const target = args.find((arg) => !/^[-+<>]|^\d+[<>]/.test(arg));
    const changesDir = word === "cd" || word === "popd" || (word === "pushd" && target !== undefined);
    yield { ...part, dir: scope.dir, changesDir };
    if (word === "cd") scope.dir = resolve(scope.dir, expandHome(args.filter((arg) => arg !== "--").find((arg) => !/^-[LPe@]+$/.test(arg)) ?? "~"));
    else if (word === "popd") scope.dir = scope.stack.pop() ?? scope.dir;
    else if (changesDir) {
      scope.stack.push(scope.dir);
      scope.dir = resolve(scope.dir, expandHome(target));
    }
  }
}

export function walkCommands(command, cwd) {
  const parts = [...walkParts(command, cwd)];
  let tooDeep = false;
  const nested = parts.flatMap((part) => {
    const bodies = substitutions(part.text);
    if (bodies === null) tooDeep = true;
    return (bodies ?? []).flatMap((body) => [...walkParts(body, part.dir)]);
  });
  return { parts: [...parts, ...nested], tooDeep };
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
  for (const { text, dir, changesDir } of walkParts(command, cwd)) if (!changesDir) yield { dir, tokens: tokenize(text) };
}
