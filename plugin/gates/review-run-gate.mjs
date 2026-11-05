import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bashInputs, commandTokens } from "./git-gate.mjs";
import { deny, logGate, readHookInput } from "../lib/hook-io.mjs";
import { hasRunApproval, runApprovalsDir } from "../lib/publish-approval-ticket.mjs";
import { scriptOperand } from "../lib/shell-program-arguments.mjs";
import { expandHome, tokenize, walkCommands } from "../lib/shell-segments.mjs";

const MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "bunx", "pnpx"]);
const DIR_FLAGS = new Set(["-C", "--prefix", "--dir", "--cwd", "--directory"]);
const CHDIR_FLAGS = new Map([["env", ["-C", "--chdir"]], ["sudo", ["-D", "--chdir"]]]);
const NODE = /^node(?:js)?[\d.]*$/;
const MANAGER_FILE = /\/node_modules\/(?:npm|pnpm|yarn|corepack|bun)\//;
const VOLTA_VALUE_FLAGS = new Set(["--node", "--npm", "--pnpm", "--yarn", "--env"]);
const REVIEW_FOLDER = /\/(?:\.claude\/worktrees|\.worktrees)\/pr-\d+$/;
const CHECKOUT = fileURLToPath(new URL("../skills/review-pr/references/checkout.md", import.meta.url));
const PLUGIN_ROOT = realPath(fileURLToPath(new URL("..", import.meta.url)));

function realPath(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return resolve(path);
    throw error;
  }
}

function flagValues(tokens, flags, dir) {
  const dirs = [];
  for (let index = 0; index < tokens.length && tokens[index] !== "--"; index += 1) {
    const equals = tokens[index].indexOf("=");
    const [flag, value] = equals > 0 ? [tokens[index].slice(0, equals), tokens[index].slice(equals + 1)] : [tokens[index], tokens[index + 1]];
    if (flags(flag) && value) dirs.push(resolve(dir, expandHome(value)));
  }
  return dirs;
}

function chdirs(prefix, dir) {
  let names = [];
  return flagValues(prefix, (flag) => {
    names = CHDIR_FLAGS.get(basename(flag)) ?? names;
    return names.includes(flag);
  }, dir);
}

function runner(program, args) {
  if (program === "corepack" && MANAGERS.has(args[0]?.split("@")[0])) return { program: args[0].split("@")[0], args: args.slice(1) };
  if (program === "volta" && args[0] === "run") {
    let index = 1;
    while (index < args.length && args[index].startsWith("-")) index += VOLTA_VALUE_FLAGS.has(args[index]) ? 2 : 1;
    return index < args.length ? runner(basename(args[index]), args.slice(index + 1)) : null;
  }
  return MANAGERS.has(program) || program === "make" || NODE.test(program) ? { program, args } : null;
}

function nodeDirs(args, dirs, here) {
  const { script, inline } = scriptOperand("node", args);
  if (inline || script === undefined || script === "-") return dirs;
  const file = realPath(resolve(here, expandHome(script)));
  if (MANAGER_FILE.test(file)) return [...dirs, dirname(file)];
  return file.startsWith(`${PLUGIN_ROOT}${sep}`) ? [] : [dirname(file)];
}

function targetDirs(text, cwd) {
  const raw = tokenize(text);
  const tokens = commandTokens(text, MANAGERS);
  const found = runner(tokens[0], tokens.slice(1));
  if (!found) return [];
  const moved = chdirs(raw.slice(0, raw.length - tokens.length), cwd);
  const here = moved.at(-1) ?? cwd;
  if (NODE.test(found.program)) return nodeDirs(found.args, [cwd, ...moved], here);
  return [cwd, ...moved, ...flagValues(found.args, (flag) => DIR_FLAGS.has(flag), here)];
}

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });

function reviewCheckout(dir) {
  let lines;
  try {
    lines = git(dir, "rev-parse", "--show-toplevel", "HEAD", "--symbolic-full-name", "HEAD").trim().split("\n");
  } catch (error) {
    if (error.status === 128) return null;
    throw error;
  }
  const [top, sha, symbolic] = lines;
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) return null;
  const refs = symbolic === "HEAD" ? git(dir, "for-each-ref", "--points-at", sha, "--format=%(refname)", "refs/pr/").split("\n").filter(Boolean) : [];
  return refs.length || REVIEW_FOLDER.test(top) ? { top, sha, refs } : null;
}

const refusal = ({ top, sha, refs }) =>
  `tedy review-run gate: ${top} is a PR review checkout at head ${sha}${refs.length ? ` (${refs.join(", ")})` : ""}, and the user has not approved running its code at that head, so this command, which runs code from the checkout, is refused. Follow step 3 of /tedy:review-pr (${CHECKOUT}): run pr-execution-surface.mjs origin/<base> refs/pr/<n>, quote it, and ask one AskUserQuestion with header \`run.header\` naming that full head sha; then run only what the answer allows. A new head asks again.`;

export function reviewRunVerdict(input, { dir = runApprovalsDir() } = {}) {
  const checked = new Map();
  for (const item of bashInputs(input).inputs ?? []) {
    for (const { text, dir: cwd } of walkCommands(item.tool_input?.command ?? "", item.cwd ?? process.cwd()).parts) {
      for (const target of targetDirs(text, cwd)) {
        if (!checked.has(target)) checked.set(target, reviewCheckout(target));
        const checkout = checked.get(target);
        if (checkout && !hasRunApproval(checkout.sha, dir)) return { ...checkout, reason: refusal(checkout) };
      }
    }
  }
  return null;
}

export function run() {
  const input = readHookInput({ askOnFailure: true });
  try {
    const verdict = reviewRunVerdict(input);
    if (!verdict) return;
    logGate({ hook: "review-run-gate", decision: "deny", head: verdict.sha, dir: verdict.top });
    deny(verdict.reason);
  } catch (error) {
    logGate({ hook: "review-run-gate", decision: "deny-on-error", error: error.message });
    deny(`tedy review-run gate: could not check whether this command runs a PR's code in a review checkout (${error.message}), so it is refused. Run it from a directory git can read, or follow step 3 of /tedy:review-pr (${CHECKOUT}).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
