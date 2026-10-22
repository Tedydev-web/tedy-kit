import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir-for-tests.mjs";
import { runWithFakeGh } from "./fake-gh-for-tests.mjs";

const SCRIPT = new URL("../lib/github-write.mjs", import.meta.url).pathname;

const run = (args, options) => runWithFakeGh(SCRIPT, args, options);

const CLEAN_DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -9,2 +10,2 @@\n context line\n+added line\n";
const COPY_DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -9,2 +10,2 @@\n context line\n+The label reads Ask the family\n";
const OTHER_DIFF = "diff --git a/other.ts b/other.ts\n--- a/other.ts\n+++ b/other.ts\n@@ -1,1 +1,1 @@\n+x\n";
const HEAD_MATCH = "abc1234" + "0".repeat(33);
const HEAD_MOVED = "0".repeat(40);

function draft(comment, pr = 701, sha = "abc1234") {
  return `# PR #${pr}: comment line by line (head ${sha})\n\n## 1. \`src/a.ts:10\`\n${comment}\n`;
}

function writeDraft(comment, pr, sha) {
  const dir = tempDir("tedy-ghcwd-");
  const file = join(dir, "d.md");
  writeFileSync(file, draft(comment, pr, sha));
  return { dir, file };
}

function snapshotInto(stateDir, file, text) {
  const path = join(stateDir, "drafts", file.replace(/\//g, "_"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

test("post refuses when the draft now names a different PR or head than the frozen snapshot", () => {
  const { dir, file } = writeDraft("The label is wrong.");
  const stateDir = tempDir("tedy-ghstate-");
  snapshotInto(stateDir, file, draft("old.", 999, "fff0000"));
  const result = run(["post", file, "--repo", "o/r"], { fixture: { diff: CLEAN_DIFF, head: HEAD_MATCH }, cwd: dir, stateDir });
  assert.notEqual(result.status, 0);
  assert.match(result.out, /different PR or head than the frozen original/);
  assert.equal(result.writes.length, 0);
});

test("post refuses when the draft still has lint problems", () => {
  const { dir, file } = writeDraft("The label is wrong.");
  const result = run(["post", file, "--repo", "o/r"], { fixture: { diff: OTHER_DIFF, head: HEAD_MATCH }, cwd: dir });
  assert.notEqual(result.status, 0);
  assert.match(result.out, /not in the PR diff/);
  assert.equal(result.writes.length, 0);
});

test("post refuses when the PR head moved off the drafted sha", () => {
  const { dir, file } = writeDraft("The label is wrong.");
  const result = run(["post", file, "--repo", "o/r"], { fixture: { diff: CLEAN_DIFF, head: HEAD_MOVED }, cwd: dir });
  assert.notEqual(result.status, 0);
  assert.match(result.out, /PR head moved/);
  assert.equal(result.writes.length, 0);
});

test("post refuses and writes nothing when a comment fails verification", () => {
  const { dir, file } = writeDraft("The label is wrong.\n\nPRD EPIC 09 · UC_SW_08 step 3:\n> button Ask the group.");
  const result = run(["post", file, "--repo", "o/r"], { fixture: { diff: CLEAN_DIFF, head: HEAD_MATCH }, cwd: dir });
  assert.notEqual(result.status, 0);
  assert.match(result.out, /has no source in the project map/);
  assert.equal(result.writes.length, 0);
});

test("post refuses and writes nothing when a comment is already on the PR", () => {
  const { dir, file } = writeDraft('The label reads "Ask the family".');
  const comments = [{ id: 555, path: "src/a.ts", line: 10, body: 'The label reads "Ask the family".' }];
  const result = run(["post", file, "--repo", "o/r"], { fixture: { diff: COPY_DIFF, head: HEAD_MATCH, comments }, cwd: dir });
  assert.notEqual(result.status, 0);
  assert.match(result.out, /already on the PR as comment 555/);
  assert.equal(result.writes.length, 0);
});

test("edit refuses an empty body before writing anything", () => {
  const dir = tempDir("tedy-ghcwd-");
  const body = join(dir, "b.txt");
  writeFileSync(body, "   \n");
  const result = run(["edit", "123", "--repo", "o/r", "--body-file", body], { cwd: dir });
  assert.notEqual(result.status, 0);
  assert.match(result.out, /body not posted/);
  assert.equal(result.writes.length, 0);
});

test("edit throws when the comment body differs after the PATCH read-back", () => {
  const dir = tempDir("tedy-ghcwd-");
  const body = join(dir, "b.txt");
  writeFileSync(body, "Fixed the label.\n");
  const stateDir = tempDir("tedy-ghstate-");
  assert.equal(runWithFakeGh(new URL("../lib/draft-lint.mjs", import.meta.url).pathname, ["pr-reply", body], { cwd: dir, stateDir }).status, 0);
  const result = run(["edit", "123", "--repo", "o/r", "--body-file", body], { fixture: { write: { body: "something else", html_url: "u" } }, cwd: dir, stateDir });
  assert.notEqual(result.status, 0);
  assert.match(result.out, /body differs after PATCH/);
  assert.equal(result.writes.length, 1);
});

test("minimize throws when the comment did not become minimized", () => {
  const result = run(["minimize", "NODE_1"], { fixture: { graphql: { data: { minimizeComment: { minimizedComment: { isMinimized: false } } } } } });
  assert.notEqual(result.status, 0);
  assert.match(result.out, /is not minimized/);
  assert.equal(result.writes.length, 1);
});

test("resolve throws when the thread did not read back as resolved", () => {
  const result = run(["resolve", "THREAD_1"], { fixture: { graphql: { data: { resolveReviewThread: { thread: { isResolved: false } } } } } });
  assert.notEqual(result.status, 0);
  assert.match(result.out, /is not resolved/);
  assert.equal(result.writes.length, 1);
});

test("reply refuses when the same reply already sits under the comment", () => {
  const dir = tempDir("tedy-ghcwd-");
  const body = join(dir, "r.txt");
  writeFileSync(body, "Fixed it.\n");
  const comments = [{ id: 777, in_reply_to_id: 123, body: "Fixed it." }];
  const result = run(["reply", "701", "123", "--repo", "o/r", "--body-file", body], { fixture: { comments }, cwd: dir });
  assert.notEqual(result.status, 0);
  assert.match(result.out, /already says this/);
  assert.equal(result.writes.length, 0);
});

test("pr-body throws when --body-file is missing", () => {
  const result = run(["pr-body", "744", "--repo", "o/r"], {});
  assert.notEqual(result.status, 0);
  assert.match(result.out, /pr-body needs --body-file/);
  assert.equal(result.writes.length, 0);
});

test("pr-body refuses a body with no OP link and writes nothing", () => {
  const dir = tempDir("tedy-ghcwd-");
  const body = join(dir, "b.md");
  writeFileSync(body, "just a body\n");
  const fixture = { prView: { number: 744, isDraft: true, author: { login: "tedy" }, body: "old" }, login: "tedy" };
  const result = run(["pr-body", "744", "--repo", "o/r", "--body-file", body], { fixture, cwd: dir });
  assert.notEqual(result.status, 0);
  assert.match(result.out, /the body has no OP#<id>/);
  assert.equal(result.writes.length, 0);
});

test("--dry-run is refused on a verb that does not support it, and a valued --dry-run on any verb", () => {
  const dir = tempDir("tedy-ghcwd-");
  writeFileSync(join(dir, "b.md"), "ok a\n");
  writeFileSync(join(dir, "d.md"), draft("body one"));
  for (const args of [["reply", "1", "2", "--body-file", "b.md", "--dry-run"], ["edit", "5", "--body-file", "b.md", "--dry-run"], ["minimize", "IC_x", "--dry-run"], ["resolve", "PRRT_x", "--dry-run"], ["unresolve", "PRRT_x", "--dry-run"], ["reply", "1", "2", "--body-file", "b.md", "--dry-run=no"], ["post", "d.md", "--dry-run=no"], ["pr-body", "3", "--body-file", "b.md", "--dry-run=yes"]]) {
    const result = run(args, { cwd: dir });
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.out, /--dry-run/, args.join(" "));
    assert.equal(result.writes.length, 0, args.join(" "));
  }
});
