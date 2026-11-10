import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export function git(dir, ...args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 120_000 });
  if (result.error) throw new Error(`git ${args[0]} in ${dir}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function linkedWorktree(dir) {
  const [gitDir, common] = git(dir, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir").split("\n");
  return gitDir !== common;
}

function integrationBranch(repo, entry) {
  if (entry?.branch) return entry.branch;
  try {
    return git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, "");
  } catch (error) {
    throw new Error(`${repo} has no integration branch: the map names none and origin/HEAD is unset (${error.message})`);
  }
}

export function planWorktree(map, repo, { branch, slug }) {
  const name = branch ?? `feat/${slug}`;
  if (spawnSync("git", ["-C", repo, "check-ref-format", "--branch", name], { encoding: "utf8" }).status !== 0) throw new Error(`--branch ${name} is not a valid branch name`);
  const entry = (map.repos ?? []).find((item) => resolve(map.paths[0], item.path) === repo);
  const root = map.worktree_root ? resolve(map.paths[0], map.worktree_root) : join(dirname(repo), ".worktrees");
  return { repo, branch: name, base: integrationBranch(repo, entry), path: join(root, `${basename(repo)}-${slug}`) };
}

export function addWorktree({ repo, branch, base, path }) {
  git(repo, "fetch", "-q", "origin", base);
  try {
    git(repo, "worktree", "add", "--no-track", "-b", branch, path, `origin/${base}`);
  } catch (error) {
    throw new Error(`git worktree add failed: ${error.message}`);
  }
}

export const merged = ({ repo, branch, base }) => spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", `refs/heads/${branch}`, `refs/remotes/origin/${base}`], { encoding: "utf8" }).status === 0;

const REGENERABLE = new Set(["node_modules", "dist", "build", "out", ".next", ".nuxt", ".turbo", ".cache", "coverage", ".parcel-cache", ".vite", "target"]);

const regenerable = (path) => path.endsWith("/") && REGENERABLE.has(path.slice(0, -1));

function blocker(tree) {
  if (!linkedWorktree(tree)) return "it is not a linked worktree";
  const entries = git(tree, "status", "--porcelain", "-z", "--untracked-files=normal", "--ignored=matching").split("\0").filter(Boolean);
  if (entries.some((entry) => !entry.startsWith("!! "))) return "it has uncommitted changes";
  const kept = entries.map((entry) => entry.slice(3)).filter((path) => !regenerable(path));
  if (kept.length) return `it holds ignored files that removing it would delete: ${kept.join(", ")}`;
  const ahead = Number(git(tree, "rev-list", "--count", "HEAD", "--not", "--remotes"));
  if (ahead) return `it has ${ahead} commit${ahead === 1 ? "" : "s"} on no remote`;
  return null;
}

const inside = (dir, tree) => relative(realpathSync(tree), realpathSync(dir)).split(sep)[0] !== "..";

function registered(repo, tree, branch) {
  const real = realpathSync(tree);
  return git(repo, "worktree", "list", "--porcelain").split("\n\n").some((block) => {
    const lines = block.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    return Boolean(path) && existsSync(path) && realpathSync(path) === real && lines.includes(`branch refs/heads/${branch}`);
  });
}

export function removeWorktree({ repo, worktree, branch }, reason, dryRun = false) {
  if (inside(process.cwd(), worktree)) return `kept ${worktree}: this command runs inside it; run job.mjs prune from elsewhere to remove it`;
  try {
    if (!registered(repo, worktree, branch)) return `kept ${worktree}: it is not a worktree of ${repo} on ${branch ?? "(no branch recorded)"}`;
  } catch (error) {
    return `kept ${worktree}: ${error.message}`;
  }
  const why = blocker(worktree);
  if (why) return `kept ${worktree}: ${why}`;
  if (dryRun) return `would remove ${worktree} (${reason})`;
  try {
    git(repo, "worktree", "remove", worktree);
  } catch (error) {
    return `kept ${worktree}: ${error.message}`;
  }
  return `removed ${worktree} (${reason})`;
}

export const t3Strategy =({ branch, base }) => ({ type: "worktree", baseRef: `origin/${base}`, branch, startFromOrigin: true });
