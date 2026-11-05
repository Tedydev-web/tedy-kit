import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
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
const MAKES = new Set(["make", "gmake"]);
const MAKE_FILE_FLAGS = new Set(["-f", "--file", "--makefile"]);
const NODE_PRELOAD_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]);
const GLOB_CHAR = /[*?[{]/;
const STAT_MISSES = new Set(["ENOENT", "ENOTDIR", "EACCES", "ENAMETOOLONG", "ELOOP"]);
const NODE = /^node(?:js)?[\d.]*$/;
const NODE_VERSION = new Set(["-v", "--version"]);
const MANAGER_FILE = /\/node_modules\/(?:npm|pnpm|yarn|corepack|bun)\//;
const VOLTA_VALUE_FLAGS = new Set(["--node", "--npm", "--pnpm", "--yarn", "--env"]);
const REVIEW_FOLDER = /\/(?:\.claude\/worktrees|\.worktrees)\/pr-\d+$/;
const CHECKOUT = fileURLToPath(new URL("../skills/review-pr/references/checkout.md", import.meta.url));
const PLUGIN_ROOT = realPath(fileURLToPath(new URL("..", import.meta.url)));

function realPath(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (STAT_MISSES.has(error.code)) return resolve(path);
    throw error;
  }
}

function existingDir(path) {
  let dir = resolve(path.split(GLOB_CHAR)[0]);
  while (dirname(dir) !== dir) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch (error) {
      if (!STAT_MISSES.has(error.code)) throw error;
    }
    dir = dirname(dir);
  }
  return dir;
}

function flagValues(tokens, flags, dir, read = (value) => value) {
  const dirs = [];
  for (let index = 0; index < tokens.length && tokens[index] !== "--"; index += 1) {
    const token = tokens[index];
    const equals = token.indexOf("=");
    let [flag, value] = equals > 0 ? [token.slice(0, equals), token.slice(equals + 1)] : [token, tokens[index + 1]];
    if (/^-[^-]./.test(token) && !flags(flag) && flags(token.slice(0, 2))) [flag, value] = [token.slice(0, 2), token.slice(2)];
    if (flags(flag) && value) dirs.push(resolve(dir, expandHome(read(value))));
  }
  return dirs;
}

function fileUrlPath(value) {
  if (!/^file:/i.test(value)) return value;
  try {
    const path = fileURLToPath(value);
    return path.includes("\0") ? value : path;
  } catch {
    return value;
  }
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
    const inner = index < args.length ? runner(basename(args[index]), args.slice(index + 1)) : null;
    return inner && { word: args[index], ...inner };
  }
  return MANAGERS.has(program) || MAKES.has(program) || NODE.test(program) ? { program, args } : null;
}

function programDirs(words, prefix, here) {
  const entries = prefix
    .filter((token) => token.startsWith("PATH="))
    .flatMap((token) => token.slice(5).split(":"))
    .map((entry) => entry.replace(/^(?:\$PWD|\$\{PWD\}|\$\(pwd\))(?=\/|$)/, here) || here)
    .filter((entry) => !entry.includes("$"));
  return [...words.filter((word) => word?.includes("/")), ...entries].map((path) => existingDir(resolve(here, expandHome(path))));
}

function nodeDirs(args, dirs, here) {
  if (args.length === 1 && NODE_VERSION.has(args[0])) return [];
  const preloads = flagValues(args, (flag) => NODE_PRELOAD_FLAGS.has(flag), here, fileUrlPath).map(existingDir);
  const { script, inline } = scriptOperand("node", args);
  if (inline || script === undefined || script === "-") {
    const tested = args.includes("--test") ? args.filter((arg) => !arg.startsWith("-")).map((arg) => existingDir(resolve(here, expandHome(arg)))) : [];
    return [...dirs, ...preloads, ...tested];
  }
  const file = realPath(resolve(here, expandHome(script)));
  if (MANAGER_FILE.test(file)) return [...dirs, dirname(file), ...preloads];
  return file.startsWith(`${PLUGIN_ROOT}${sep}`) ? preloads : [dirname(file), ...preloads];
}

function targetDirs(text, cwd) {
  const raw = tokenize(text);
  const tokens = commandTokens(text, MANAGERS);
  const found = runner(tokens[0], tokens.slice(1));
  if (!found) return [];
  const prefix = raw.slice(0, raw.length - tokens.length);
  const moved = chdirs(prefix, cwd);
  const here = moved.at(-1) ?? cwd;
  const programs = programDirs([raw[prefix.length]?.replace(/^[({!]+/, ""), found.word], prefix, here);
  if (NODE.test(found.program)) return [...programs, ...nodeDirs(found.args, [cwd, ...moved], here)];
  const makefiles = MAKES.has(found.program) ? flagValues(found.args, (flag) => MAKE_FILE_FLAGS.has(flag), here).map(existingDir) : [];
  return [cwd, ...moved, ...programs, ...flagValues(found.args, (flag) => DIR_FLAGS.has(flag), here), ...makefiles];
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
