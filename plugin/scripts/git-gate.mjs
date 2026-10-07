import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isScannedFile, newComments } from "./comment-scan.mjs";
import { deny, logGate, readHookInput } from "./hook-io.mjs";

const SHELL_WRAPPER = /^(?:bash|sh|zsh)\s+-c\s+(['"])([\s\S]*)\1$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const BASE_CANDIDATES = ["origin/dev", "origin/develop", "origin/main", "origin/master"];
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "fetch", "rev-parse", "branch", "ls-files", "remote", "describe", "blame", "reflog"]);
const READ_ONLY_GH_ACTIONS = new Set(["view", "list", "diff", "checks", "status", "watch", "download"]);
const READ_ONLY_GH_AREAS = new Set(["search", "status", "browse", "help", "--version", "--help", undefined]);
const LOCAL_GH = new Set(["pr checkout", "repo clone", "auth", "config", "alias", "extension", "completion"]);
const MAX_FINDINGS = 5;

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
  if (tokens[0] === "rtk") tokens = tokens.slice(1);
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

export function hasFileRedirect(segment) {
  let quote = null;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== ">") continue;
    const target = segment.slice(index + 1).replace(/^>/, "").trimStart();
    if (target.startsWith("&") || target.startsWith("/dev/null")) continue;
    return true;
  }
  return false;
}

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

function tryGit(dir, args) {
  try {
    return git(dir, args);
  } catch {
    return null;
  }
}

function isRepository(dir) {
  return tryGit(dir, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

function lines(output) {
  return (output ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
}

function commentFindings(files, readBefore, readAfter) {
  const findings = [];
  for (const file of files.filter(isScannedFile)) {
    for (const comment of newComments(readBefore(file), readAfter(file))) findings.push(`${file}:${comment.line} ${comment.text.split("\n")[0].slice(0, 100)}`);
  }
  return findings;
}

function commentReason(findings, action) {
  const shown = findings.slice(0, MAX_FINDINGS).map((finding) => `- ${finding}`).join("\n");
  const more = findings.length > MAX_FINDINGS ? `\n- … ${findings.length - MAX_FINDINGS} more` : "";
  return `tedy gate: the code being ${action} adds comments:\n${shown}${more}\nMove each explanation into the commit message or PR description and keep only code and tool directives in source (working-style rule 10). If a teammate's comment must stay, the user can run the command manually with \`! git ...\`.`;
}

function pendingAddedFiles(root, pendingAdds) {
  return pendingAdds.flatMap((add) => {
    if (git(add.dir, ["rev-parse", "--show-toplevel"]).trim() !== root) return [];
    return lines(git(add.dir, ["add", "--dry-run", ...add.args]))
      .map((line) => line.match(/^add '(.+)'$/)?.[1])
      .filter(Boolean);
  });
}

function checkCommit(dir, all, pendingAdds) {
  const root = git(dir, ["rev-parse", "--show-toplevel"]).trim();
  const staged = lines(git(dir, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]));
  const unstaged = all ? lines(git(dir, ["diff", "--name-only", "--diff-filter=ACMR"])) : [];
  const fromWorkingTree = new Set([...unstaged, ...pendingAddedFiles(root, pendingAdds)]);
  const files = [...new Set([...staged, ...fromWorkingTree])];
  const findings = commentFindings(
    files,
    (file) => tryGit(dir, ["show", `HEAD:${file}`]) ?? "",
    (file) => (fromWorkingTree.has(file) ? readFileSync(resolve(root, file), "utf8") : tryGit(dir, ["show", `:${file}`]) ?? ""),
  );
  return findings.length ? { allow: false, reason: commentReason(findings, "committed") } : { allow: true };
}

function runSeparately(what) {
  return {
    allow: false,
    reason: `tedy gate: run \`${what}\` as its own command, after the commands chained before it have finished, so the gate checks the tree it will really ${what.startsWith("git commit") ? "commit" : "push"}. Before it in this command: a file-changing command, \`git add\` or \`git commit\` (working-style rules 10–11).`,
  };
}

function pickBase(dir) {
  const upstream = tryGit(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])?.trim();
  const remoteHead = tryGit(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.trim();
  const candidates = [upstream, ...BASE_CANDIDATES, remoteHead].filter(Boolean).filter((ref) => tryGit(dir, ["rev-parse", "--verify", "--quiet", ref]) !== null);
  let best = null;
  for (const ref of new Set(candidates)) {
    const ahead = Number(tryGit(dir, ["rev-list", "--count", `${ref}..HEAD`]) ?? Infinity);
    if (best === null || ahead < best.ahead) best = { ref, ahead };
  }
  return best?.ref ?? null;
}

function checkPush(dir, action) {
  const dirty = lines(git(dir, ["status", "--porcelain", "--untracked-files=no"]));
  if (dirty.length) {
    return { allow: false, reason: `tedy gate: tracked files have uncommitted changes:\n${dirty.slice(0, 10).map((line) => `- ${line}`).join("\n")}\nCommit or restore them so \`git status\` is clean, then ${action} (working-style rule 11).` };
  }
  const base = pickBase(dir);
  if (!base) return { allow: true, note: "no base branch to compare" };
  const mergeBase = git(dir, ["merge-base", base, "HEAD"]).trim();
  const files = lines(git(dir, ["diff", "--name-only", "--diff-filter=ACMR", mergeBase, "HEAD"]));
  const findings = commentFindings(
    files,
    (file) => tryGit(dir, ["show", `${mergeBase}:${file}`]) ?? "",
    (file) => tryGit(dir, ["show", `HEAD:${file}`]) ?? "",
  );
  return findings.length ? { allow: false, reason: commentReason(findings, "pushed"), base } : { allow: true, base };
}

export function evaluate(command, cwd) {
  let dir = cwd;
  let mutated = false;
  let committed = false;
  const pendingAdds = [];
  for (const segment of splitSegments(command)) {
    const action = classify(segment, dir);
    const redirects = hasFileRedirect(segment);
    if (action.kind === "cd") {
      dir = action.dir;
      continue;
    }
    if (action.kind === "github-write" && /\bgh\s+(pr|issue)\s+(merge|close|reopen|ready|edit|lock|unlock)\b/.test(segment)) {
      return { allow: false, reason: "tedy gate: merging, closing or editing a PR or issue belongs to the user (working-style rule 4). Tell the user what is ready and let them do it." };
    }
    if (action.kind === "github-write") {
      return { allow: false, reason: "tedy gate: publish to GitHub through github-write.mjs after the user approves the draft (working-style rule 3). Reading with gh (view, diff, list, GET, GraphQL queries) stays open." };
    }
    if (action.kind === "read" && !redirects) continue;
    if (action.kind === "add" && !redirects) {
      pendingAdds.push(action);
      continue;
    }
    if (action.kind === "commit") {
      if (mutated || redirects) return runSeparately("git commit");
      if (isRepository(action.dir)) {
        try {
          const result = checkCommit(action.dir, action.all, pendingAdds);
          if (!result.allow) return result;
        } catch {
          return runSeparately("git commit");
        }
      }
      committed = true;
      continue;
    }
    if (action.kind === "push" || action.kind === "pr-create") {
      const what = action.kind === "push" ? "git push" : "gh pr create";
      if (mutated || redirects || committed || pendingAdds.length) return runSeparately(what);
      if (!isRepository(action.dir)) continue;
      try {
        const result = checkPush(action.dir, action.kind === "push" ? "push" : "open the PR");
        if (!result.allow) return result;
      } catch (error) {
        return { allow: false, reason: `tedy gate could not verify the ${what} (${error.message}). Check \`git status\` and the diff by hand; the user can run it manually with \`! ${segment}\`.` };
      }
      continue;
    }
    mutated = true;
  }
  return { allow: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = readHookInput();
  const command = input.tool_input?.command ?? "";
  try {
    const result = evaluate(command, input.cwd ?? process.cwd());
    logGate({ hook: "git-gate", decision: result.allow ? "allow" : "deny", command: command.slice(0, 200), cwd: input.cwd, reason: result.allow ? undefined : result.reason.split("\n")[0] });
    if (!result.allow) deny(result.reason);
  } catch (error) {
    const guarded = /\b(push|pr\s+create)\b/.test(command);
    logGate({ hook: "git-gate", decision: guarded ? "deny-on-error" : "allow-on-error", command: command.slice(0, 200), error: error.message });
    if (guarded) deny(`tedy gate could not verify this command (${error.message}). Check \`git status\` and the diff by hand; the user can run it manually with \`! ${command.slice(0, 80)}\`.`);
  }
}
