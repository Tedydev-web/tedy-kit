import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ask, logGate, readHookInput } from "../lib/hook-io.mjs";
import { profileDir } from "../lib/profile.mjs";
import { bashInputs } from "./git-gate.mjs";
import { expandHome, walkSegments } from "../lib/shell-segments.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const GUARDED_FILES = ["config.json", "rules.md"];
const HEAD_MOVES = new Set(["checkout", "switch", "reset", "pull", "merge", "rebase"]);

export const releaseDir = (env = process.env) => env.TEDY_RELEASE_DIR || join(homedir(), "Documents", "workspace", "tedy-kit-release");

export const REASON =
  "tedy gate: this changes the profile config or rules, or moves the release worktree the live plugin runs from. Allow it only if the user asked for this exact change in this turn.";

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const inside = (dir, path) => path === dir || path.startsWith(dir + sep);

function movesRelease(dir, tokens, release) {
  if (tokens[0] !== "git") return false;
  let target = dir;
  let index = 1;
  while (index < tokens.length && tokens[index].startsWith("-")) {
    if (tokens[index] === "-C") target = resolve(target, expandHome(tokens[index + 1] ?? "."));
    index += tokens[index] === "-C" || tokens[index] === "-c" ? 2 : 1;
  }
  return HEAD_MOVES.has(tokens[index]) && inside(release, real(target));
}

export function evaluate(input, { profile = profileDir(), release = releaseDir() } = {}) {
  const cwd = input.cwd ?? process.cwd();
  const guarded = new Set(GUARDED_FILES.map((name) => real(join(profile, name))));
  const releaseRoot = real(release);
  const names = (path) => guarded.has(real(resolve(cwd, expandHome(path))));
  if (EDIT_TOOLS.has(input.tool_name)) {
    const path = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    return typeof path === "string" && names(path) ? REASON : null;
  }
  for (const item of bashInputs(input).inputs ?? []) {
    if (item.tool_name !== "Bash" || typeof item.tool_input?.command !== "string") continue;
    for (const { dir, tokens } of walkSegments(item.tool_input.command, item.cwd ?? cwd)) {
      if (movesRelease(dir, tokens, releaseRoot)) return REASON;
      if (tokens.some((token, at) => /(?:^|\/)profile\.mjs$/.test(token) && tokens[at + 1] === "publish-approval" && tokens[at + 2] !== undefined)) return REASON;
      if (tokens.some((token) => guarded.has(real(resolve(dir, expandHome(token)))))) return REASON;
    }
  }
  return null;
}

export function run() {
  const input = readHookInput({ askOnFailure: true });
  try {
    const reason = evaluate(input);
    if (reason) {
      logGate({ hook: "profile-guard-gate", decision: "ask", tool: input.tool_name, cwd: input.cwd });
      ask(reason);
    }
  } catch (error) {
    logGate({ hook: "profile-guard-gate", decision: "ask-on-error", error: error.message });
    ask(REASON);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
