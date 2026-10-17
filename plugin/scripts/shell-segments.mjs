const SHELL_WRAPPER = /^(?:bash|sh|zsh)\s+-c\s+(['"])([\s\S]*)\1$/;
const HEREDOC = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;

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

export function splitSegments(command, unwrap = true) {
  const segments = [];
  let current = "";
  let line = "";
  let quote = null;
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
      line += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      line += char;
      continue;
    }
    if (pair === "&&" || pair === "||") {
      line += pair;
      segments.push(current);
      current = "";
      index += 1;
      continue;
    }
    if (char === "\n") {
      index = skipHeredocs(command, index, line);
      line = "";
      segments.push(current);
      current = "";
      continue;
    }
    if (char === ";" || char === "|") {
      line += char;
      segments.push(current);
      current = "";
      continue;
    }
    line += char;
    current += char;
  }
  segments.push(current);
  return segments
    .map((segment) => segment.trim())
    .filter(Boolean)
    .flatMap((segment) => {
      const wrapped = unwrap && segment.match(SHELL_WRAPPER);
      return wrapped ? splitSegments(wrapped[2]) : [segment];
    });
}

export function tokenize(segment) {
  const tokens = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
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
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}
