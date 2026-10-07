const SCANNED_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "sol", "go", "rs", "java", "kt", "swift", "cs", "tact", "tolk"]);
const TEST_PATH = /(\.(test|spec)\.[^/]+$)|(^|\/)__tests__\//;
const DIRECTIVE = /^(\/\/\/?|\/\*+)\s*(eslint-|@ts-|prettier-|biome-|istanbul\b|c8\b|<reference\b|@vitest-environment\b|[@#]__PURE__|webpack[A-Z]|@jsx)/;
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const VALUE_END = new Set([")", "]", "}", '"', "'", "`"]);

export function isScannedFile(path) {
  const extension = path.split(".").pop().toLowerCase();
  return SCANNED_EXTENSIONS.has(extension) && !TEST_PATH.test(path);
}

function regexAllowedAt(source, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  const previous = source[cursor];
  if (/[\w$]/.test(previous)) {
    let start = cursor;
    while (start > 0 && /[\w$]/.test(source[start - 1])) start -= 1;
    return REGEX_AFTER_WORD.has(source.slice(start, cursor + 1));
  }
  return !VALUE_END.has(previous);
}

export function findComments(source) {
  const comments = [];
  let index = 0;
  let line = 1;
  const advance = (count = 1) => {
    for (let step = 0; step < count && index < source.length; step += 1) {
      if (source[index] === "\n") line += 1;
      index += 1;
    }
  };
  const skipQuoted = (quote) => {
    advance();
    while (index < source.length && source[index] !== quote) {
      if (source[index] === "\\") advance();
      if (source[index] === "\n" && quote !== "`") return;
      if (quote === "`" && source[index] === "$" && source[index + 1] === "{") {
        advance(2);
        let depth = 1;
        while (index < source.length && depth > 0) {
          const char = source[index];
          if (char === '"' || char === "'" || char === "`") {
            skipQuoted(char);
            continue;
          }
          if (char === "{") depth += 1;
          if (char === "}") depth -= 1;
          advance();
        }
        continue;
      }
      advance();
    }
    advance();
  };
  const skipRegex = () => {
    advance();
    let inClass = false;
    while (index < source.length && source[index] !== "\n") {
      const char = source[index];
      if (char === "\\") {
        advance(2);
        continue;
      }
      if (char === "[") inClass = true;
      if (char === "]") inClass = false;
      if (char === "/" && !inClass) break;
      advance();
    }
    advance();
    while (index < source.length && /[a-z]/i.test(source[index])) advance();
  };
  const record = (startLine, text) => {
    if (!DIRECTIVE.test(text.trim())) comments.push({ line: startLine, text: text.trim() });
  };

  if (source.startsWith("#!")) {
    while (index < source.length && source[index] !== "\n") advance();
  }
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '"' || char === "'" || char === "`") {
      skipQuoted(char);
    } else if (char === "/" && next === "/") {
      const startLine = line;
      const start = index;
      while (index < source.length && source[index] !== "\n") advance();
      record(startLine, source.slice(start, index));
    } else if (char === "/" && next === "*") {
      const startLine = line;
      const start = index;
      advance(2);
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) advance();
      advance(2);
      record(startLine, source.slice(start, index));
    } else if (char === "/" && regexAllowedAt(source, index)) {
      skipRegex();
    } else {
      advance();
    }
  }
  return comments;
}

export function newComments(before, after) {
  const remaining = new Map();
  for (const comment of findComments(before)) remaining.set(comment.text, (remaining.get(comment.text) ?? 0) + 1);
  return findComments(after).filter((comment) => {
    const count = remaining.get(comment.text) ?? 0;
    if (count === 0) return true;
    remaining.set(comment.text, count - 1);
    return false;
  });
}
