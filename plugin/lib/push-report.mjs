import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isScannedFile, newComments } from "./comment-scan.mjs";
import { CTX_TOOL, bashInputs, classify } from "../gates/git-gate.mjs";
import { walkParts } from "./shell-segments.mjs";
import { strings } from "../gates/tracker-token-gate.mjs";
import { gateSwitches, logGate, readHookInput } from "./hook-io.mjs";

const BASE_CANDIDATES = ["origin/dev", "origin/develop", "origin/main", "origin/master"];
const MAX_SHOWN = 5;

const git = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

function tryGit(dir, args) {
  try {
    return git(dir, args);
  } catch {
    return null;
  }
}

const lines = (output) => (output ?? "").split("\n").map((line) => line.trim()).filter(Boolean);

export function pushTargets(command, cwd) {
  const targets = [];
  for (const { text: segment, dir } of walkParts(command, cwd)) {
    const action = classify(segment, dir);
    if (action.kind === "push" || action.kind === "pr-create") targets.push(action.dir);
  }
  return [...new Set(targets)];
}

function rangeStart(dir) {
  const previous = tryGit(dir, ["rev-parse", "--verify", "--quiet", "@{u}@{1}"])?.trim();
  if (previous) return previous;
  const remoteHead = tryGit(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.trim();
  const upstream = tryGit(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])?.trim();
  let best = null;
  for (const ref of new Set([...BASE_CANDIDATES, remoteHead].filter(Boolean))) {
    if (ref === upstream || tryGit(dir, ["rev-parse", "--verify", "--quiet", ref]) === null) continue;
    const ahead = Number(tryGit(dir, ["rev-list", "--count", `${ref}..HEAD`]) ?? Infinity);
    if (best === null || ahead < best.ahead) best = { ref, ahead };
  }
  return best && git(dir, ["merge-base", best.ref, "HEAD"]).trim();
}

export function pushFindings(dir, { comments: checkComments = true } = {}) {
  const dirty = lines(git(dir, ["status", "--porcelain", "--untracked-files=no"]));
  const start = rangeStart(dir);
  const comments = [];
  if (start && checkComments) {
    for (const file of lines(git(dir, ["diff", "--name-only", "--diff-filter=ACMR", start, "HEAD"])).filter(isScannedFile)) {
      for (const comment of newComments(tryGit(dir, ["show", `${start}:${file}`]) ?? "", tryGit(dir, ["show", `HEAD:${file}`]) ?? "")) {
        comments.push(`${file}:${comment.line} ${comment.text.split("\n")[0].slice(0, 100)}`);
      }
    }
  }
  return { dirty, comments };
}

const listed = (items) => items.slice(0, MAX_SHOWN).map((item) => `  - ${item}`).join("\n") + (items.length > MAX_SHOWN ? `\n  - … ${items.length - MAX_SHOWN} more` : "");

export const pushFailed = (output) => /failed to push|\[rejected\]|^fatal:/m.test(output);

export function reportText(dir, { dirty, comments }) {
  if (!dirty.length && !comments.length) return null;
  const parts = [`tedy report: what was just pushed from ${dir} needs a line in this reply to the user.`];
  if (comments.length) parts.push(`- It adds code comments:\n${listed(comments)}\n  Move each explanation into the commit message or PR description and push a follow-up commit, unless the user keeps them.`);
  if (dirty.length) parts.push(`- Tracked files were left uncommitted, so the pushed commit may differ from what was built and tested:\n${listed(dirty)}`);
  return parts.join("\n");
}

export function run() {
  const input = readHookInput();
  const { inputs = [] } = bashInputs(input);
  const command = inputs.map((item) => item.tool_input?.command ?? "").join("\n");
  try {
    const targets = [...new Set(inputs.flatMap((item) => pushTargets(item.tool_input?.command ?? "", item.cwd ?? process.cwd())))];
    if (!targets.length) process.exit(0);
    const output = CTX_TOOL.test(String(input.tool_name ?? "")) ? strings(input.tool_response).join("\n") : `${input.tool_response?.stdout ?? ""}\n${input.tool_response?.stderr ?? ""}`;
    if (pushFailed(output)) {
      logGate({ hook: "push-report", decision: "skipped-failed-push", command: command.slice(0, 200), cwd: input.cwd });
      process.exit(0);
    }
    const reports = targets
      .filter((dir) => tryGit(dir, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true")
      .map((dir) => reportText(dir, pushFindings(dir, { comments: gateSwitches().noComments })))
      .filter(Boolean);
    logGate({ hook: "push-report", decision: reports.length ? "reported" : "clean", command: command.slice(0, 200), cwd: input.cwd });
    if (reports.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: reports.join("\n\n") } }));
  } catch (error) {
    logGate({ hook: "push-report", decision: "error", command: command.slice(0, 200), error: error.message });
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `tedy report could not check this push (${error.message}). Tell the user, and check \`git status\` and the pushed diff by hand.` } }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
