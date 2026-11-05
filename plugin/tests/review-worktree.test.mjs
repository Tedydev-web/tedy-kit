import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewRunVerdict } from "../gates/review-run-gate.mjs";
import { commitFile, git } from "./git-sibling-for-tests.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/review-worktree.mjs", import.meta.url));
const LEFT_OUT = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "pkg/AGENTS.md", "pkg/deep/CLAUDE.md", ".claude/skills/x/SKILL.md", ".claude/settings.json", "pkg/.claude/rules/r.md"];
const KEPT = ["package.json", "src/a.ts", "pkg/index.ts", "docs/CLAUDE.md.txt", "claude/notes.md", "pkg/deep/b.ts"];

function prRepo() {
  const repo = tempDir("tedy-review-worktree-");
  git(repo, "init", "-q", "-b", "main");
  commitFile(repo, "package.json", '{"scripts":{"test":"node --test"}}\n');
  commitFile(repo, ".gitignore", ".claude/worktrees/\n");
  git(repo, "checkout", "-q", "-b", "teammate");
  for (const path of [...LEFT_OUT, ...KEPT.slice(1)]) commitFile(repo, path, `${path}\n`);
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  git(repo, "update-ref", "refs/pr/12", head);
  return { repo, head, worktree: join(repo, ".claude", "worktrees", "pr-12") };
}

const add = (repo, ...args) => spawnSync("node", [SCRIPT, ...args], { cwd: repo, encoding: "utf8" });

test("a review worktree leaves every CLAUDE.md, AGENTS.md and .claude/ folder of the PR head off disk at any depth, and git still reads them", () => {
  const { repo, head, worktree } = prRepo();
  const mainBefore = git(repo, "status", "--porcelain");
  const result = add(repo, worktree, "refs/pr/12");
  assert.equal(result.status, 0, result.stderr);
  for (const path of LEFT_OUT) assert.equal(existsSync(join(worktree, path)), false, path);
  for (const path of KEPT) assert.equal(existsSync(join(worktree, path)), true, path);
  assert.equal(git(worktree, "rev-parse", "HEAD"), head);
  assert.equal(git(worktree, "status", "--porcelain"), "");
  assert.equal(git(worktree, "show", "HEAD:CLAUDE.md"), "CLAUDE.md");
  assert.equal(git(worktree, "show", "HEAD:pkg/.claude/rules/r.md"), "pkg/.claude/rules/r.md");
  for (const path of LEFT_OUT) assert.ok(result.stdout.includes(path), path);
  assert.ok(result.stdout.includes(head));
  assert.equal(git(repo, "status", "--porcelain"), mainBefore);
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(existsSync(join(repo, "package.json")), true);
  assert.equal(spawnSync("git", ["-C", repo, "config", "--file", join(repo, ".git", "config"), "--get", "core.sparseCheckout"], { encoding: "utf8" }).stdout, "");
  assert.equal(git(repo, "config", "--file", join(repo, ".git", "config"), "--get", "extensions.worktreeConfig"), "true");
});

test("the review-run gate still treats the sparse worktree as a review checkout, and a plain worktree remove cleans it up", () => {
  const { repo, worktree } = prRepo();
  assert.equal(add(repo, worktree, "refs/pr/12").status, 0);
  const verdict = reviewRunVerdict({ tool_name: "Bash", cwd: worktree, tool_input: { command: "npm test" } }, { dir: tempDir("tedy-review-worktree-approvals-") });
  assert.ok(verdict?.reason.includes("pr-12"));
  git(repo, "worktree", "remove", worktree);
  assert.equal(existsSync(worktree), false);
});

test("a ref that is not a commit, an existing folder or a missing argument fails loudly and leaves no worktree behind", () => {
  const { repo, worktree } = prRepo();
  const missing = add(repo, worktree, "refs/pr/99");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /refs\/pr\/99 is not a commit/);
  assert.equal(existsSync(worktree), false);
  assert.equal(add(repo, worktree, "refs/pr/12").status, 0);
  const again = add(repo, worktree, "refs/pr/12");
  assert.equal(again.status, 1);
  assert.match(again.stderr, /^review-worktree: /);
  assert.equal(git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length, 2);
  const usage = add(repo, worktree);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /^usage: review-worktree\.mjs/);
});
