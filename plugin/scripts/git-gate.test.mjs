import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, splitSegments, classify, hasFileRedirect } from "./git-gate.mjs";

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "tedy-gate-"));
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

let repo;
before(() => {
  repo = makeRepo();
});

test("splitSegments handles chains, pipes, newlines and shell wrappers", () => {
  assert.deepEqual(splitSegments("cd x && git push; echo ok | cat\ngit status"), ["cd x", "git push", "echo ok", "cat", "git status"]);
  assert.deepEqual(splitSegments("bash -c 'git add . && git push'"), ["git add .", "git push"]);
  assert.deepEqual(splitSegments('echo "a && b"'), ['echo "a && b"']);
});

test("classify recognises git and gh actions through rtk, env vars and -C", () => {
  assert.deepEqual(classify("rtk git push origin x", "/w"), { kind: "push", dir: "/w" });
  assert.deepEqual(classify("FOO=1 git -C sub commit -am msg", "/w"), { kind: "commit", dir: "/w/sub", all: true });
  assert.deepEqual(classify("git -c core.x=y push", "/w"), { kind: "push", dir: "/w" });
  assert.equal(classify("gh pr create --fill", "/w").kind, "pr-create");
  assert.equal(classify("gh pr review 12 --comment -b hi", "/w").kind, "github-write");
  assert.equal(classify("gh api -X POST repos/o/r/pulls/1/reviews", "/w").kind, "github-write");
  assert.equal(classify("gh api repos/o/r/pulls/1/comments -f body=x", "/w").kind, "github-write");
  assert.equal(classify("gh api graphql -f query='mutation { minimizeComment }'", "/w").kind, "github-write");
  assert.equal(classify("gh api graphql -f query='query { repository { name } }'", "/w").kind, "read");
  assert.equal(classify("gh api repos/o/r/pulls/1", "/w").kind, "read");
  assert.equal(classify("gh pr view 12 --json body", "/w").kind, "read");
  assert.equal(classify("gh search prs --review-requested=@me", "/w").kind, "read");
  assert.equal(classify("gh run list", "/w").kind, "read");
  assert.equal(classify("gh auth status", "/w").kind, "read");
  for (const command of ["gh pr merge 12", "gh pr edit 12 --title x", "gh pr close 12", "gh pr ready 12", "gh issue create -t x", "gh release create v1", "gh repo delete o/r"]) {
    assert.equal(classify(command, "/w").kind, "github-write", command);
  }
  assert.equal(classify("gh pr checkout 12", "/w").kind, "other");
  assert.equal(classify("gh api graphql -f query=@m.graphql", "/w").kind, "github-write");
  assert.equal(classify("gh api graphql -F query=@-", "/w").kind, "github-write");
  assert.equal(classify("git status --short", "/w").kind, "read");
  assert.deepEqual(classify("git add -A", "/w"), { kind: "add", dir: "/w", args: ["-A"] });
  assert.equal(classify("npm test", "/w").kind, "other");
});

test("hasFileRedirect ignores quoted text, stderr merges and /dev/null", () => {
  assert.equal(hasFileRedirect("echo x >> notes.txt"), true);
  assert.equal(hasFileRedirect("git log > out.txt"), true);
  assert.equal(hasFileRedirect("git status 2>&1"), false);
  assert.equal(hasFileRedirect("git fetch > /dev/null"), false);
  assert.equal(hasFileRedirect('git commit -m "a > b"'), false);
});

test("push is denied while tracked files are dirty", () => {
  writeFileSync(join(repo, "src", "a.ts"), "// legacy note\nexport const a = 2;\n");
  const result = evaluate("git push", repo);
  assert.equal(result.allow, false);
  assert.match(result.reason, /src\/a\.ts/);
  git(repo, "checkout", "--", "src/a.ts");
});

test("push is allowed when clean and commits add no comments", () => {
  writeFileSync(join(repo, "src", "a.ts"), "// legacy note\nexport const a = 3;\n");
  git(repo, "commit", "-qam", "change value");
  assert.equal(evaluate("cd . && rtk git push", repo).allow, true);
  git(repo, "push", "-q", "origin", "main");
});

test("untracked files do not block a push", () => {
  writeFileSync(join(repo, "notes.md"), "scratch");
  assert.equal(evaluate("git push", repo).allow, true);
});

test("push is denied when unpushed commits add a comment, even if written outside Edit", () => {
  writeFileSync(join(repo, "src", "a.ts"), "// legacy note\nexport const a = 4; // explain\n");
  git(repo, "commit", "-qam", "add comment");
  const result = evaluate("git push origin main", repo);
  assert.equal(result.allow, false);
  assert.match(result.reason, /explain/);
  git(repo, "reset", "-q", "--hard", "origin/main");
});

test("commit is denied when the staged diff adds a comment", () => {
  writeFileSync(join(repo, "src", "b.ts"), "export const b = 1; /* why */\n");
  git(repo, "add", "src/b.ts");
  const result = evaluate("git commit -m add", repo);
  assert.equal(result.allow, false);
  assert.match(result.reason, /why/);
  git(repo, "reset", "-q", "--hard", "origin/main");
});

test("commit -a checks tracked working-tree changes", () => {
  writeFileSync(join(repo, "src", "a.ts"), "// legacy note\n// fresh\nexport const a = 1;\n");
  assert.equal(evaluate("git commit -am x", repo).allow, false);
  git(repo, "checkout", "--", "src/a.ts");
});

test("commit allows test files and tool directives", () => {
  writeFileSync(join(repo, "src", "a.test.ts"), "// test note\n");
  writeFileSync(join(repo, "src", "c.ts"), "// eslint-disable-next-line\nexport const c = 1;\n");
  git(repo, "add", "-A");
  assert.equal(evaluate("git commit -m ok", repo).allow, true);
  git(repo, "reset", "-q", "--hard", "origin/main");
});

test("git add chained before commit is simulated, so new untracked comments are caught", () => {
  writeFileSync(join(repo, "src", "d.ts"), "export const d = 1; // note\n");
  const result = evaluate("git add -A && git commit -m 'add d'", repo);
  assert.equal(result.allow, false);
  assert.match(result.reason, /src\/d\.ts:1/);
});

test("git add of a clean path is allowed even when another file has a comment", () => {
  writeFileSync(join(repo, "src", "e.ts"), "export const e = 1;\n");
  assert.equal(evaluate("git add src/e.ts && git commit -m 'add e'", repo).allow, true);
});

test("a bad pathspec in a chained git add asks to run the commit separately", () => {
  const result = evaluate("git add nope.ts && git commit -m x", repo);
  assert.equal(result.allow, false);
  assert.match(result.reason, /own command/);
  git(repo, "clean", "-fdq");
});

test("push chained after a file-changing command, git add or git commit must run separately", () => {
  for (const command of ["echo x >> src/a.ts && git push", "npm test && git push", "git add -A && git commit -m x && git push", "git commit -m x && gh pr create --fill"]) {
    const result = evaluate(command, repo);
    assert.equal(result.allow, false, command);
    assert.match(result.reason, /own command/, command);
  }
});

test("push chained after cd or read-only commands is still checked normally", () => {
  assert.equal(evaluate("cd . && git status && git fetch > /dev/null && git push", repo).allow, true);
});

test("commit messages with quoted redirects are not treated as file changes", () => {
  assert.equal(evaluate('git commit -m "why > because"', repo).allow, true);
});

test("direct GitHub writes are denied with the approved path in the reason", () => {
  const result = evaluate("gh api -X POST repos/o/r/pulls/1/reviews --input r.json", repo);
  assert.equal(result.allow, false);
  assert.match(result.reason, /github-write\.mjs/);
});

test("merging or closing a PR is denied as the user's call, not routed to github-write.mjs", () => {
  const result = evaluate("rtk gh pr merge 12 --squash", repo);
  assert.equal(result.allow, false);
  assert.match(result.reason, /belongs to the user/);
});

test("directories outside git are allowed", () => {
  assert.equal(evaluate("git push", tmpdir()).allow, true);
});
