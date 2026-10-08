import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ask, deny, logGate, readHookInput } from "./hook-io.mjs";

const SHELL_WRAPPER = /^(?:bash|sh|zsh)\s+-c\s+(['"])([\s\S]*)\1$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "fetch", "rev-parse", "branch", "ls-files", "remote", "describe", "blame", "reflog"]);
const READ_ONLY_GH_ACTIONS = new Set(["view", "list", "diff", "checks", "status", "watch", "download"]);
const READ_ONLY_GH_AREAS = new Set(["search", "status", "browse", "help", "--version", "--help", undefined]);
const LOCAL_GH = new Set(["pr checkout", "repo clone", "auth", "config", "alias", "extension", "completion"]);
const PROTECTED_BRANCHES = new Set(["main", "master", "dev", "develop", "production", "staging"]);
const KIT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REWRITING_PUSH = /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|--mirror|--all|--prune|-d|--delete)$/;

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
    if (subcommand === "push") return { kind: "push", dir, args: args.slice(index + 1) };
    if (subcommand === "add") return { kind: "add", dir, args: args.slice(index + 1) };
    if (subcommand === "commit") {
      const all = args.slice(index + 1).some((token) => token === "--all" || /^-[^-]*a/.test(token));
      return { kind: "commit", dir, all };
    }
    return { kind: READ_ONLY_GIT.has(subcommand) ? "read" : "other", dir };
  }
  if (program === "gh") {
    const [area, action] = args;
    if (area === "pr" && action === "create") return { kind: "pr-create", dir: cwd, args: args.slice(2) };
    if (area === "api") return { kind: classifyGitHubApi(args.slice(1)) ?? "read", dir: cwd };
    if (READ_ONLY_GH_AREAS.has(area) || READ_ONLY_GH_ACTIONS.has(action)) return { kind: "read", dir: cwd };
    if (LOCAL_GH.has(area) || LOCAL_GH.has(`${area} ${action}`)) return { kind: "other", dir: cwd };
    return { kind: "github-write", dir: cwd };
  }
  return { kind: "other", dir: cwd };
}

function tryGit(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

export function pushRisk(args, dir) {
  const rewriting = args.find((arg) => REWRITING_PUSH.test(arg));
  if (rewriting) return `\`${rewriting}\` can rewrite or delete remote branches`;
  const guarded = (target) => PROTECTED_BRANCHES.has(target) && tryGit(dir, ["rev-parse", "--show-toplevel"]) !== KIT_ROOT;
  const refspecs = args.filter((arg) => !arg.startsWith("-")).slice(1);
  if (!refspecs.length) {
    const upstream = tryGit(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    const target = upstream ? upstream.replace(/^[^/]+\//, "") : tryGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return guarded(target) ? `it pushes to \`${target}\`` : null;
  }
  for (const refspec of refspecs) {
    if (refspec.startsWith("+")) return `\`${refspec}\` forces the update`;
    const [source, destination = source] = refspec.split(":");
    if (!source) return `\`${refspec}\` deletes a remote branch`;
    const target = destination === "HEAD" ? tryGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) : destination.replace(/^refs\/heads\//, "");
    if (guarded(target)) return `it pushes to \`${target}\``;
  }
  return null;
}

export function evaluate(command, cwd) {
  let dir = cwd;
  for (const segment of splitSegments(command)) {
    const action = classify(segment, dir);
    if (action.kind === "cd") {
      dir = action.dir;
      continue;
    }
    if (action.kind === "push") {
      const risk = pushRisk(action.args, action.dir);
      if (risk) return { allow: false, ask: true, reason: `tedy gate: ${risk}, which belongs to the user (working-style rule 5). Allow it only if the user asked for this push.` };
      continue;
    }
    if (action.kind === "pr-create") {
      if (!action.args.some((arg) => arg === "--draft" || arg === "-d")) return { allow: false, reason: "tedy gate: open the PR as a draft with `--draft`; the user marks it ready (working-style rule 5)." };
      continue;
    }
    if (action.kind !== "github-write") continue;
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
    logGate({ hook: "git-gate", decision: result.allow ? "allow" : result.ask ? "ask" : "deny", command: command.slice(0, 200), cwd: input.cwd, reason: result.reason });
    if (result.ask) ask(result.reason);
    else if (!result.allow) deny(result.reason);
  } catch (error) {
    logGate({ hook: "git-gate", decision: "allow-on-error", command: command.slice(0, 200), error: error.message });
    process.stderr.write(`tedy gate could not classify this command: ${error.message}\n`);
  }
}
