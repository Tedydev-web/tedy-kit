import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deny, logGate, readHookInput } from "./hook-io.mjs";

const SHELL_WRAPPER = /^(?:bash|sh|zsh)\s+-c\s+(['"])([\s\S]*)\1$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "fetch", "rev-parse", "branch", "ls-files", "remote", "describe", "blame", "reflog"]);
const READ_ONLY_GH_ACTIONS = new Set(["view", "list", "diff", "checks", "status", "watch", "download"]);
const READ_ONLY_GH_AREAS = new Set(["search", "status", "browse", "help", "--version", "--help", undefined]);
const LOCAL_GH = new Set(["pr checkout", "repo clone", "auth", "config", "alias", "extension", "completion"]);

export function splitSegments(command) {
  const segments = [];
  let current = "";
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
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (pair === "&&" || pair === "||") {
      segments.push(current);
      current = "";
      index += 1;
      continue;
    }
    if (char === ";" || char === "|" || char === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments
    .map((segment) => segment.trim())
    .filter(Boolean)
    .flatMap((segment) => {
      const wrapped = segment.match(SHELL_WRAPPER);
      return wrapped ? splitSegments(wrapped[2]) : [segment];
    });
}

function tokenize(segment) {
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

function classifyGitHubApi(args) {
  let method = null;
  let hasFields = false;
  let endpoint = null;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "-X" || token === "--method") {
      method = (args[index + 1] ?? "").toUpperCase();
      index += 1;
    } else if (token.startsWith("--method=")) {
      method = token.slice("--method=".length).toUpperCase();
    } else if (["-f", "-F", "--field", "--raw-field", "--input"].includes(token)) {
      hasFields = true;
      index += 1;
    } else if (/^--(raw-)?field=/.test(token)) {
      hasFields = true;
    } else if (!token.startsWith("-") && endpoint === null) {
      endpoint = token;
    }
  }
  if (endpoint === "graphql") return args.includes("--input") || args.some((token) => /\bmutation\b|=@/.test(token)) ? "github-write" : null;
  if (method) return method === "GET" ? null : "github-write";
  return hasFields ? "github-write" : null;
}

export function classify(segment, cwd) {
  let tokens = tokenize(segment);
  while (tokens.length && ENV_ASSIGNMENT.test(tokens[0])) tokens = tokens.slice(1);
  const [program, ...args] = tokens;
  if (program === "cd") return { kind: "cd", dir: resolve(cwd, args[0] ?? homedir()) };
  if (program === "git") {
    let dir = cwd;
    let index = 0;
    while (index < args.length && args[index].startsWith("-")) {
      if (args[index] === "-C") {
        dir = resolve(dir, args[index + 1] ?? ".");
        index += 2;
      } else if (args[index] === "-c") {
        index += 2;
      } else {
        index += 1;
      }
    }
    const subcommand = args[index];
    if (subcommand === "push") return { kind: "push", dir };
    if (subcommand === "add") return { kind: "add", dir, args: args.slice(index + 1) };
    if (subcommand === "commit") {
      const all = args.slice(index + 1).some((token) => token === "--all" || /^-[^-]*a/.test(token));
      return { kind: "commit", dir, all };
    }
    return { kind: READ_ONLY_GIT.has(subcommand) ? "read" : "other", dir };
  }
  if (program === "gh") {
    const [area, action] = args;
    if (area === "pr" && action === "create") return { kind: "pr-create", dir: cwd };
    if (area === "api") return { kind: classifyGitHubApi(args.slice(1)) ?? "read", dir: cwd };
    if (READ_ONLY_GH_AREAS.has(area) || READ_ONLY_GH_ACTIONS.has(action)) return { kind: "read", dir: cwd };
    if (LOCAL_GH.has(area) || LOCAL_GH.has(`${area} ${action}`)) return { kind: "other", dir: cwd };
    return { kind: "github-write", dir: cwd };
  }
  return { kind: "other", dir: cwd };
}

export function evaluate(command, cwd) {
  for (const segment of splitSegments(command)) {
    if (classify(segment, cwd).kind !== "github-write") continue;
    if (/\bgh\s+(pr|issue)\s+(merge|close|reopen|ready|edit|lock|unlock)\b/.test(segment)) {
      return { allow: false, reason: "tedy gate: merging, closing or editing a PR or issue belongs to the user (working-style rule 4). Tell the user what is ready and let them do it." };
    }
    return { allow: false, reason: "tedy gate: publish to GitHub through github-write.mjs after the user approves the draft (working-style rule 3). Reading with gh (view, diff, list, GET, GraphQL queries) stays open." };
  }
  return { allow: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = readHookInput();
  const command = input.tool_input?.command ?? "";
  try {
    const result = evaluate(command, input.cwd ?? process.cwd());
    logGate({ hook: "git-gate", decision: result.allow ? "allow" : "deny", command: command.slice(0, 200), cwd: input.cwd, reason: result.allow ? undefined : result.reason });
    if (!result.allow) deny(result.reason);
  } catch (error) {
    logGate({ hook: "git-gate", decision: "allow-on-error", command: command.slice(0, 200), error: error.message });
    process.stderr.write(`tedy gate could not classify this command: ${error.message}\n`);
  }
}
