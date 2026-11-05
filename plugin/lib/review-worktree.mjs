import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SPARSE_PATTERNS = ["/*", "!CLAUDE.md", "!CLAUDE.local.md", "!AGENTS.md", "!.claude/"];
const LEFT_OUT = /(?:^|\/)(?:CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md)$|(?:^|\/)\.claude\//;
const MIN_GIT = [2, 35];

const reasonOf = (error) => error.stderr?.toString().trim() || error.message;

const gitIn = (dir) => (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

function onDisk(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

function requireGitVersion() {
  const text = execFileSync("git", ["--version"], { encoding: "utf8" });
  const match = /(\d+)\.(\d+)/.exec(text);
  if (!match) throw new Error(`cannot read the git version from "${text.trim()}"`);
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])) throw new Error(`git ${MIN_GIT.join(".")} or newer is needed for a per-worktree sparse checkout; this is ${text.trim()}`);
}

function commitOf(git, ref) {
  try {
    return git("rev-parse", "--verify", "-q", `${ref}^{commit}`).trim();
  } catch {
    throw new Error(`${ref} is not a commit in this repository`);
  }
}

export function addReviewWorktree(repo, folder, ref) {
  requireGitVersion();
  const git = gitIn(repo);
  const sha = commitOf(git, ref);
  const path = resolve(repo, folder);
  git("worktree", "add", "-q", "--no-checkout", "--detach", path, sha);
  try {
    const inside = gitIn(path);
    inside("sparse-checkout", "set", "--no-cone", ...SPARSE_PATTERNS);
    inside("checkout", "-q", "--detach", sha);
    const leftOut = inside("ls-files", "-z").split("\0").filter((file) => LEFT_OUT.test(file));
    const present = leftOut.filter((file) => onDisk(join(path, file)));
    if (present.length) throw new Error(`the sparse checkout left these on disk: ${present.join(", ")}`);
    return { path, sha, leftOut };
  } catch (error) {
    try {
      if (existsSync(path)) git("worktree", "remove", "--force", path);
    } catch (cleanup) {
      throw new Error(`${reasonOf(error)}; the worktree at ${path} could not be removed: ${reasonOf(cleanup)}`);
    }
    throw error;
  }
}

export function formatReviewWorktree({ path, sha, leftOut }) {
  const lines = [`review worktree: ${path} at ${sha}`, `left out, read with git show ${sha}:<path>: ${leftOut.length ? "" : "none"}`];
  return [...lines, ...leftOut.map((file) => `  ${file}`)].join("\n");
}

export function run() {
  const [folder, ref, ...rest] = process.argv.slice(2);
  if (!folder || !ref || rest.length) {
    console.error("usage: review-worktree.mjs <folder>/pr-<n> refs/pr/<n>   (run in the reviewed repository)");
    process.exit(2);
  }
  try {
    console.log(formatReviewWorktree(addReviewWorktree(process.cwd(), folder, ref)));
  } catch (error) {
    console.error(`review-worktree: ${reasonOf(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
