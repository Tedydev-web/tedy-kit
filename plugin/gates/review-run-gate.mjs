import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bashInputs, commandTokens } from "./git-gate.mjs";
import { deny, logGate, readHookInput } from "../lib/hook-io.mjs";
import { hasRunApproval, runApprovalsDir } from "../lib/publish-approval-ticket.mjs";
import { expandHome, walkCommands } from "../lib/shell-segments.mjs";

const MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "bunx", "pnpx"]);
const DIR_FLAGS = new Set(["-C", "--prefix", "--dir", "--cwd"]);
const REVIEW_FOLDER = /\/(?:\.claude\/worktrees|\.worktrees)\/pr-\d+$/;
const CHECKOUT = fileURLToPath(new URL("../skills/review-pr/references/checkout.md", import.meta.url));

function targetDir(args, dir) {
  for (let index = 0; index < args.length; index += 1) {
    const equals = args[index].indexOf("=");
    const [flag, value] = equals > 0 ? [args[index].slice(0, equals), args[index].slice(equals + 1)] : [args[index], args[index + 1]];
    if (DIR_FLAGS.has(flag) && value) return resolve(dir, expandHome(value));
  }
  return dir;
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
  `tedy review-run gate: ${top} is a PR review checkout at head ${sha}${refs.length ? ` (${refs.join(", ")})` : ""}, and the user has not approved running its code at that head, so this package-manager command is refused. Follow step 3 of /tedy:review-pr (${CHECKOUT}): run pr-execution-surface.mjs origin/<base> refs/pr/<n>, quote it, and ask one AskUserQuestion with header \`run.header\` naming that full head sha; then run only what the answer allows. A new head asks again.`;

export function reviewRunVerdict(input, { dir = runApprovalsDir() } = {}) {
  const checked = new Map();
  for (const item of bashInputs(input).inputs ?? []) {
    for (const { text, dir: cwd } of walkCommands(item.tool_input?.command ?? "", item.cwd ?? process.cwd()).parts) {
      const [program, ...args] = commandTokens(text, MANAGERS);
      if (!MANAGERS.has(program)) continue;
      const target = targetDir(args, cwd);
      if (!checked.has(target)) checked.set(target, reviewCheckout(target));
      const checkout = checked.get(target);
      if (checkout && !hasRunApproval(checkout.sha, dir)) return { ...checkout, reason: refusal(checkout) };
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
