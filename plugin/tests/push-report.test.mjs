import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pushFailed, pushFindings, pushTargets, reportText } from "../lib/push-report.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function makeRepo() {
  const root = tempDir("tedy-push-");
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, work], { stdio: "ignore" });
  git(work, "config", "user.email", "t@t");
  git(work, "config", "user.name", "t");
  mkdirSync(join(work, "src"));
  writeFileSync(join(work, "src", "a.ts"), "// legacy note\nexport const a = 1;\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "init");
  git(work, "push", "-q", "origin", "main");
  return work;
}

test("pushTargets finds every push and gh pr create, following cd and -C", () => {
  assert.deepEqual(pushTargets("cd app && npm test && git push -u origin x", "/w"), ["/w/app"]);
  assert.deepEqual(pushTargets("git -C sub push && gh pr create --draft --fill", "/w"), ["/w/sub", "/w"]);
  assert.deepEqual(pushTargets("git status && git commit -m x", "/w"), []);
});

test("a first push of a branch reports comments it adds against the integration branch", () => {
  const repo = makeRepo();
  git(repo, "checkout", "-qb", "feat");
  writeFileSync(join(repo, "src", "a.ts"), "// legacy note\nexport const a = 2; // explain\n");
  git(repo, "commit", "-qam", "change");
  git(repo, "push", "-q", "-u", "origin", "feat");
  const findings = pushFindings(repo);
  assert.equal(findings.comments.length, 1);
  assert.match(findings.comments[0], /src\/a\.ts:2 .*explain/);
  assert.deepEqual(findings.dirty, []);
});

test("a later push reports only what that push added, plus tracked files left dirty", () => {
  const repo = makeRepo();
  git(repo, "checkout", "-qb", "feat");
  writeFileSync(join(repo, "src", "a.ts"), "// legacy note\nexport const a = 2; // kept by the user\n");
  git(repo, "commit", "-qam", "first");
  git(repo, "push", "-q", "-u", "origin", "feat");
  writeFileSync(join(repo, "src", "b.ts"), "export const b = 1;\n");
  git(repo, "add", "src/b.ts");
  git(repo, "commit", "-qm", "second");
  git(repo, "push", "-q");
  writeFileSync(join(repo, "src", "b.ts"), "export const b = 2;\n");
  const findings = pushFindings(repo);
  assert.deepEqual(findings.comments, []);
  assert.deepEqual(findings.dirty, ["M src/b.ts"]);
  assert.match(reportText(repo, findings), /left uncommitted[\s\S]*src\/b\.ts/);
});

test("a clean push produces no report", () => {
  const repo = makeRepo();
  git(repo, "checkout", "-qb", "feat");
  writeFileSync(join(repo, "src", "c.ts"), "// eslint-disable-next-line\nexport const c = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "c");
  git(repo, "push", "-q", "-u", "origin", "feat");
  assert.equal(reportText(repo, pushFindings(repo)), null);
});

test("a rejected or fatal push is recognised so the previous push is not reported again", () => {
  assert.equal(pushFailed(" ! [rejected]        feat -> feat (non-fast-forward)\nerror: failed to push some refs"), true);
  assert.equal(pushFailed("fatal: The current branch feat has no upstream branch."), true);
  assert.equal(pushFailed("To github.com:o/r.git\n   1a2b3c4..5d6e7f8  feat -> feat"), false);
});

test("a command that pushes nothing is not logged, even when its output carries a fatal line", () => {
  const state = tempDir("tedy-push-");
  const input = { tool_name: "Bash", cwd: state, tool_input: { command: "git show origin/dev:src/a.ts && git grep -n x" }, tool_response: { stdout: "", stderr: "fatal: invalid object name 'origin/dev'." } };
  const stdout = execFileSync("node", [new URL("../lib/push-report.mjs", import.meta.url).pathname], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, TEDY_STATE_DIR: state } });
  assert.equal(stdout, "");
  assert.equal(existsSync(join(state, "gate-log.jsonl")), false);
});

test("with the comment gate off a push is checked for uncommitted files only", () => {
  const repo = makeRepo();
  git(repo, "checkout", "-qb", "feat");
  writeFileSync(join(repo, "src", "d.ts"), "// explains d\nexport const d = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "d");
  git(repo, "push", "-q", "-u", "origin", "feat");
  assert.equal(pushFindings(repo).comments.length, 1);
  assert.deepEqual(pushFindings(repo, { comments: false }).comments, []);
});

test("a push sent through a context-mode tool is reported like a Bash push, and a failed one is not", () => {
  const repo = makeRepo();
  git(repo, "checkout", "-qb", "feat");
  writeFileSync(join(repo, "src", "e.ts"), "export const e = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "e");
  git(repo, "push", "-q", "-u", "origin", "feat");
  writeFileSync(join(repo, "src", "e.ts"), "export const e = 2;\n");
  const run = (tool_name, tool_input, text) => {
    const input = { tool_name, cwd: "/tmp", tool_input, tool_response: [{ type: "text", text }] };
    const env = { ...process.env, TEDY_STATE_DIR: tempDir("tedy-state-"), TEDY_PROFILE_DIR: tempDir("tedy-profile-") };
    return execFileSync("node", [new URL("../lib/push-report.mjs", import.meta.url).pathname], { input: JSON.stringify(input), encoding: "utf8", env });
  };
  const pushed = "To remote\n   1a2b3c4..5d6e7f8  feat -> feat";
  assert.match(run("mcp__plugin_context-mode_context-mode__ctx_execute", { language: "shell", code: "git push", cwd: repo }, pushed), /left uncommitted[\s\S]*src\/e\.ts/);
  assert.match(run("mcp__context-mode__ctx_batch_execute", { commands: [{ label: "p", command: `git -C ${repo} push` }] }, pushed), /left uncommitted/);
  assert.equal(run("mcp__plugin_context-mode_context-mode__ctx_execute", { language: "shell", code: "git push", cwd: repo }, "error: failed to push some refs"), "");
  assert.equal(run("mcp__plugin_context-mode_context-mode__ctx_execute", { language: "python", code: "print(1)" }, "1"), "");
});
