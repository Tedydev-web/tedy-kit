import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";

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

export const t3Strategy = ({ branch, base }) => ({ type: "worktree", baseRef: `origin/${base}`, branch, startFromOrigin: true });
