import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runWithFakeGh } from "./fake-gh-for-tests.mjs";
import { git, siblingRepo } from "./git-sibling-for-tests.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const LINT = new URL("../lib/draft-lint.mjs", import.meta.url).pathname;
const WRITE = new URL("../lib/github-write.mjs", import.meta.url).pathname;
const CLEAN_DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -9,2 +10,2 @@\n context line\n+added line\n";
const HEAD = "abc1234" + "0".repeat(33);
const DRAFT = "# PR #701: comment line by line (head abc1234)\n\n## 1. `src/a.ts:10`\nThe label is wrong.\n";
const POSTED = { diff: CLEAN_DIFF, head: HEAD, write: { id: 9, html_url: "https://x/review/9" }, reviewComments: [{ id: 1, path: "src/a.ts", line: 10, commit_id: HEAD }] };

function project({ findings = { "261022-1314": "Writer `src/a.ts:1@dev`, read at the remote ref.\n" } } = {}) {
  const sibling = siblingRepo();
  const fe = tempDir("tedy-fe-");
  const profileDir = profileWith({ language: { chat: "en" } });
  mkdirSync(join(profileDir, "projects"));
  const map = { name: "p", paths: [fe], repos: [{ path: sibling.clone, role: "backend", branch: "dev" }], language: { pr_review: "en" } };
  writeFileSync(join(profileDir, "projects", "p.md"), `\`\`\`json\n${JSON.stringify(map)}\n\`\`\`\n`);
  mkdirSync(join(fe, "plans", "reports"), { recursive: true });
  for (const [stamp, text] of Object.entries(findings)) writeFileSync(join(fe, "plans", "reports", `review-${stamp}-pr701-findings.md`), text);
  writeFileSync(join(fe, "pr.diff"), CLEAN_DIFF);
  writeFileSync(join(fe, "d.md"), DRAFT);
  const options = { cwd: fe, stateDir: tempDir("tedy-pinstate-"), profileDir };
  return {
    sibling,
    fe,
    sha: git(sibling.clone, "rev-parse", "refs/remotes/origin/dev"),
    lint: (...args) => runWithFakeGh(LINT, args, options),
    write: (args, fixture = POSTED) => runWithFakeGh(WRITE, args, { ...options, fixture }),
  };
}

test("draft-lint pins the sibling the newest findings file cites, at the local remote ref, and prints the pin", () => {
  const p = project({ findings: { "261022-0900": "Old `src/b.ts:1@dev`.\n", "261022-1314": "Writer `src/a.ts:1@dev`.\n" } });
  const result = p.lint("pr-comment", "d.md", "--diff", "pr.diff");
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /^clean: 1 comments, PR #701, head abc1234$/m);
  assert.ok(result.out.includes(`pinned: ${p.sibling.clone} origin/dev@${p.sha.slice(0, 8)} · src/a.ts\n`), result.out);
  assert.doesNotMatch(result.out, /src\/b\.ts/);
});

test("draft-lint says when nothing is pinned, and fails on a cite no map repo holds", () => {
  const none = project({ findings: {} });
  assert.match(none.lint("pr-comment", "d.md", "--diff", "pr.diff").out, /^pinned: no path:line@branch cite in the draft or a findings file for PR #701$/m);
  const bad = project({ findings: { "261022-1314": "Writer `src/zzz.ts:4@dev`.\n" } });
  const result = bad.lint("pr-comment", "d.md", "--diff", "pr.diff");
  assert.equal(result.status, 1);
  assert.match(result.out, /^sources: `src\/zzz\.ts@dev` is cited, but no repo in the project map has src\/zzz\.ts at origin\/dev; fetch that repo or fix the cite$/m);
});

test("post refuses a draft that was never linted, and one edited after its pins were taken", () => {
  const p = project();
  const unlinted = p.write(["post", "d.md", "--repo", "o/r"]);
  assert.equal(unlinted.status, 1);
  assert.match(unlinted.out, /^refused: d\.md has no pinned sources; run draft-lint\.mjs pr-comment d\.md, then ask the user again$/m);
  assert.equal(unlinted.writes.length, 0);
  assert.equal(p.lint("pr-comment", "d.md", "--diff", "pr.diff").status, 0);
  writeFileSync(join(p.fe, "d.md"), DRAFT.replace("wrong", "off"));
  const edited = p.write(["post", "d.md", "--repo", "o/r"]);
  assert.match(edited.out, /^refused: d\.md changed after its sources were pinned; run draft-lint\.mjs pr-comment d\.md, then ask the user again$/m);
  assert.equal(edited.writes.length, 0);
});

test("post goes ahead when the pinned sibling is unchanged", () => {
  const p = project();
  assert.equal(p.lint("pr-comment", "d.md", "--diff", "pr.diff").status, 0);
  const result = p.write(["post", "d.md", "--repo", "o/r"]);
  assert.equal(result.status, 0, result.out);
  assert.doesNotMatch(result.out, /notice|refused/);
  assert.equal(result.writes.length, 1);
});

test("post goes ahead with a notice when the sibling moved without touching a cited path", () => {
  const p = project();
  assert.equal(p.lint("pr-comment", "d.md", "--diff", "pr.diff").status, 0);
  const moved = p.sibling.push("src/b.ts", "b2\n", "chore: unrelated");
  const result = p.write(["post", "d.md", "--repo", "o/r"]);
  assert.equal(result.status, 0, result.out);
  assert.ok(result.out.includes(`notice: ${p.sibling.clone} origin/dev moved from ${p.sha.slice(0, 8)} to ${moved.slice(0, 8)} since the draft was linted; no cited path changed, so it posts as drafted\n`), result.out);
  assert.equal(result.writes.length, 1);
});

test("post refuses, naming the commits and files, when the sibling changed a cited path after the read", () => {
  const p = project();
  assert.equal(p.lint("pr-comment", "d.md", "--diff", "pr.diff").status, 0);
  const moved = p.sibling.push("src/a.ts", "a2\n", "fix: writer sets the field");
  const result = p.write(["post", "d.md", "--repo", "o/r"]);
  assert.equal(result.status, 1);
  assert.ok(result.out.includes(`refused: ${p.sibling.clone} origin/dev moved from ${p.sha.slice(0, 8)} to ${moved.slice(0, 8)} since the draft was linted and changed what the draft cites\n  files: src/a.ts\n  commit ${moved.slice(0, 7)} fix: writer sets the field\n  re-read the changed sources, fix the draft, lint it again and ask the user again\n`), result.out);
  assert.equal(result.writes.length, 0);
});

test("reply and edit need a pr-reply lint, then recheck the pins it took from the evidence file", () => {
  const p = project();
  writeFileSync(join(p.fe, "r.txt"), "The label is still wrong.\n");
  writeFileSync(join(p.fe, "evidence.md"), "Still `src/a.ts:1@dev`.\n");
  const reply = ["reply", "701", "123", "--repo", "o/r", "--body-file", "r.txt"];
  const unlinted = p.write(reply, { write: { id: 5, html_url: "u" } });
  assert.match(unlinted.out, /^refused: r\.txt has no pinned sources; run draft-lint\.mjs pr-reply r\.txt, then ask the user again$/m);
  assert.equal(unlinted.writes.length, 0);
  const lint = p.lint("pr-reply", "r.txt", "--findings", "evidence.md");
  assert.equal(lint.status, 0, lint.out);
  assert.ok(lint.out.includes(`clean: pr-reply\npinned: ${p.sibling.clone} origin/dev@${p.sha.slice(0, 8)} · src/a.ts\n`), lint.out);
  const posted = p.write(reply, { write: { id: 5, html_url: "u" } });
  assert.equal(posted.status, 0, posted.out);
  assert.equal(posted.writes.length, 1);
  p.sibling.push("src/a.ts", "a3\n", "fix: again");
  const edit = p.write(["edit", "123", "--repo", "o/r", "--body-file", "r.txt"], { write: { body: "The label is still wrong.", html_url: "u" } });
  assert.equal(edit.status, 1);
  assert.match(edit.out, /^refused: .* and changed what the draft cites$/m);
  assert.equal(edit.writes.length, 0);
});

test("pr-reply lints the body like a review comment and writes no pin when it fails", () => {
  const p = project();
  writeFileSync(join(p.fe, "r.txt"), "thanks, still wrong\n");
  const result = p.lint("pr-reply", "r.txt");
  assert.equal(result.status, 1);
  assert.match(result.out, /the first line must end with "\."/);
  writeFileSync(join(p.fe, "r.txt"), "The label is still wrong.\n");
  assert.match(p.write(["reply", "701", "123", "--repo", "o/r", "--body-file", "r.txt"]).out, /^refused: r\.txt has no pinned sources/m);
});
