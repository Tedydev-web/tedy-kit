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
const draftWith = (body) => `# PR #701: comment line by line (head abc1234)\n\n## 1. \`src/a.ts:10\`\n${body}\n`;
const DRAFT = draftWith("The label is wrong.");
const POSTED = { diff: CLEAN_DIFF, head: HEAD, write: { id: 9, html_url: "https://x/review/9" }, reviewComments: [{ id: 1, path: "src/a.ts", line: 10, commit_id: HEAD }] };
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function project(draft = DRAFT) {
  const be = siblingRepo();
  const fe = siblingRepo();
  const prSha = fe.pr(701);
  const profileDir = profileWith({ language: { chat: "en" } });
  mkdirSync(join(profileDir, "projects"));
  const map = { name: "p", paths: [fe.clone], repos: [{ path: ".", role: "FE", branch: "dev" }, { path: be.clone, role: "BE", branch: "dev" }], language: { pr_review: "en" } };
  writeFileSync(join(profileDir, "projects", "p.md"), `\`\`\`json\n${JSON.stringify(map)}\n\`\`\`\n`);
  const work = tempDir("tedy-work-");
  writeFileSync(join(work, "pr.diff"), CLEAN_DIFF);
  writeFileSync(join(work, "d.md"), draft);
  const options = { cwd: fe.clone, stateDir: tempDir("tedy-pinstate-"), profileDir };
  const at = (name) => join(work, name);
  return {
    be,
    fe,
    at,
    prSha,
    beSha: git(be.clone, "rev-parse", "refs/remotes/origin/dev"),
    feSha: git(fe.clone, "rev-parse", "refs/remotes/origin/dev"),
    lint: (...args) => runWithFakeGh(LINT, args, options),
    write: (args, fixture = POSTED) => runWithFakeGh(WRITE, args, { ...options, fixture }),
    rewrite: (name, text) => writeFileSync(join(work, name), text),
  };
}

test("draft-lint pins the FE and the BE repo of the map and the PR head, with full shas, and says they were pinned at lint", () => {
  const p = project();
  const pushed = p.be.push("src/c.ts", "c1\n", "feat: pushed after the clone fetched");
  const result = p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff"));
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /^clean: 1 comments, PR #701, head abc1234$/m);
  assert.ok(result.out.includes(`pinned: . origin/dev@${p.feSha} (at lint)\npinned: ${p.be.clone} origin/dev@${pushed} (at lint)\npinned: . pull/701/head@${p.prSha} (at lint)\n`), result.out);
  assert.equal(git(p.be.clone, "rev-parse", "refs/remotes/origin/dev"), pushed);
  assert.equal(git(p.fe.clone, "rev-parse", "refs/pr/701"), p.prSha);
});

test("draft-lint fails when a map repo or the PR head cannot be pinned, and passes a bare cite now that cites are not parsed", () => {
  const p = project(draftWith("The label is wrong, the writer at src/a.ts:1-3@dev sets it."));
  assert.equal(p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff")).status, 0);
  git(p.be.clone, "remote", "set-url", "origin", join(p.be.root, "gone.git"));
  const result = p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff"));
  assert.equal(result.status, 1);
  assert.match(result.out, new RegExp(`^sources: cannot pin ${escape(p.be.clone)} origin/dev: `, "m"));
  assert.doesNotMatch(result.out, /^clean:/m);
  const noPr = project(draftWith("The label is wrong.").replace("#701", "#702"));
  const missing = noPr.lint("pr-comment", noPr.at("d.md"), "--diff", noPr.at("pr.diff"));
  assert.equal(missing.status, 1);
  assert.match(missing.out, /^sources: cannot pin the head of PR #702: origin of \. has no refs\/pull\/702\/head$/m);
});

test("post refuses a draft that was never linted, and one edited after its pins were taken", () => {
  const p = project();
  const unlinted = p.write(["post", p.at("d.md"), "--repo", "o/r"]);
  assert.equal(unlinted.status, 1);
  assert.ok(unlinted.out.includes(`refused: ${p.at("d.md")} has no pinned sources; run draft-lint.mjs pr-comment ${p.at("d.md")}, then ask the user again\n`), unlinted.out);
  assert.equal(unlinted.writes.length, 0);
  assert.equal(p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff")).status, 0);
  writeFileSync(p.at("d.md"), DRAFT.replace("wrong", "off"));
  const edited = p.write(["post", p.at("d.md"), "--repo", "o/r"]);
  assert.match(edited.out, /^refused: .*d\.md changed after its sources were pinned; run draft-lint\.mjs pr-comment .*d\.md, then ask the user again$/m);
  assert.equal(edited.writes.length, 0);
});

test("post goes ahead silently when no pinned repo moved", () => {
  const p = project();
  assert.equal(p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff")).status, 0);
  const result = p.write(["post", p.at("d.md"), "--repo", "o/r"]);
  assert.equal(result.status, 0, result.out);
  assert.doesNotMatch(result.out, /notice|refused/);
  assert.equal(result.writes.length, 1);
});

test("post goes ahead with a notice when a repo moved but no changed file is named in the comments", () => {
  const p = project(draftWith("The label is wrong, the writer `src/a.ts:1@dev` sets it."));
  assert.equal(p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff")).status, 0);
  const moved = p.be.push("src/b.ts", "b2\n", "chore: unrelated");
  const result = p.write(["post", p.at("d.md"), "--repo", "o/r"]);
  assert.equal(result.status, 0, result.out);
  assert.ok(result.out.includes(`notice: ${p.be.clone} origin/dev moved from ${p.beSha.slice(0, 8)} to ${moved.slice(0, 8)} since it was pinned; no changed file is named in the text being posted, so it posts as drafted\n`), result.out);
  assert.equal(result.writes.length, 1);
});

test("post refuses when a changed file is named in a comment, however it is cited, in the FE or the BE repo", () => {
  const bodies = [
    "The label is wrong, `see src/a.ts:3,5@dev for the writer` sets it.",
    "The label is wrong, https://github.com/o/be/blob/dev/src/a.ts#L3 sets it.",
    "The label is wrong, a.ts sets it.",
    "The label is wrong, `src/a.ts#L10@dev` sets it.",
  ];
  for (const body of bodies) {
    const p = project(draftWith(body));
    assert.equal(p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff")).status, 0, body);
    const moved = p.be.push("src/a.ts", "a2\n", "fix: writer sets the field");
    const result = p.write(["post", p.at("d.md"), "--repo", "o/r"]);
    assert.equal(result.status, 1, body);
    assert.ok(result.out.includes(`refused: ${p.be.clone} origin/dev moved from ${p.beSha.slice(0, 8)} to ${moved.slice(0, 8)} since it was pinned and changed a file the text being posted names\n  files: src/a.ts\n  commit ${moved.slice(0, 7)} fix: writer sets the field\n`), `${body}\n${result.out}`);
    assert.equal(result.writes.length, 0, body);
  }
  const fe = project(draftWith("The label is wrong, `src/b.ts:1@dev` sets it."));
  assert.equal(fe.lint("pr-comment", fe.at("d.md"), "--diff", fe.at("pr.diff")).status, 0);
  fe.fe.push("src/b.ts", "b2\n", "fix: merged into dev");
  const result = fe.write(["post", fe.at("d.md"), "--repo", "o/r"]);
  assert.equal(result.status, 1);
  assert.match(result.out, /^refused: \. origin\/dev moved from .* and changed a file the text being posted names\n {2}files: src\/b\.ts$/m);
});

test("reply and edit need a pr-reply lint with --pr, then refuse when a changed file is named in the body or the PR head moved", () => {
  const p = project();
  writeFileSync(p.at("r.txt"), "The label is still wrong, see src/a.ts.\n");
  const reply = ["reply", "701", "123", "--repo", "o/r", "--body-file", p.at("r.txt")];
  const unlinted = p.write(reply, { write: { id: 5, html_url: "u" } });
  assert.match(unlinted.out, /^refused: .*r\.txt has no pinned sources; run draft-lint\.mjs pr-reply .*r\.txt, then ask the user again$/m);
  assert.equal(unlinted.writes.length, 0);
  assert.match(p.lint("pr-reply", p.at("r.txt")).out, /pr-reply and pin-sources for a review need --pr <number>/);
  const lint = p.lint("pr-reply", p.at("r.txt"), "--pr", "701");
  assert.equal(lint.status, 0, lint.out);
  assert.ok(lint.out.includes(`clean: pr-reply\npinned: . origin/dev@${p.feSha} (at lint)\npinned: ${p.be.clone} origin/dev@${p.beSha} (at lint)\npinned: . pull/701/head@${p.prSha} (at lint)\n`), lint.out);
  const posted = p.write(reply, { write: { id: 5, html_url: "u" } });
  assert.equal(posted.status, 0, posted.out);
  assert.equal(posted.writes.length, 1);
  p.be.push("src/a.ts", "a3\n", "fix: again");
  const edit = p.write(["edit", "123", "--repo", "o/r", "--body-file", p.at("r.txt")], { write: { body: "The label is still wrong, see src/a.ts.", html_url: "u" } });
  assert.equal(edit.status, 1);
  assert.match(edit.out, /^refused: .* and changed a file the text being posted names$/m);
  assert.equal(edit.writes.length, 0);
  const head = project();
  writeFileSync(head.at("r.txt"), "The label is still wrong.\n");
  assert.equal(head.lint("pr-reply", head.at("r.txt"), "--pr", "701").status, 0);
  head.fe.push("src/z.ts", "z\n", "fix: the author pushed");
  head.fe.pr(701);
  const stale = head.write(["reply", "701", "123", "--repo", "o/r", "--body-file", head.at("r.txt")], { write: { id: 5, html_url: "u" } });
  assert.equal(stale.status, 1);
  assert.match(stale.out, /^refused: \. pull\/701\/head moved from [0-9a-f]{8} to [0-9a-f]{8} since it was pinned, so the PR under review changed$/m);
  assert.equal(stale.writes.length, 0);
});

test("without a read pin the lint pins at lint time and its warning names what it pinned", () => {
  const p = project();
  const result = p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff"));
  assert.equal(result.status, 0, result.out);
  assert.ok(result.out.includes(`warning: no read pins for ${p.at("d.md")}, so these were pinned now, at lint, and a change made while you read them is not seen: . origin/dev; ${p.be.clone} origin/dev; . pull/701/head; next time run draft-lint.mjs pin-sources ${p.at("d.md")} before reading\n`), result.out);
});

test("a read pin taken before the read holds: a push before the lint fails it when the draft names a changed file, else prints a notice, and post diffs from the read", () => {
  const draft = draftWith("The label is wrong, `src/a.ts:1@dev` sets it.");
  const p = project(draft);
  const pinned = p.lint("pin-sources", p.at("d.md"), "--pr", "701");
  assert.equal(pinned.status, 0, pinned.out);
  assert.match(pinned.out, new RegExp(`^read pins for ${escape(p.at("d.md"))}:\\npinned: \\. origin/dev@${p.feSha} \\(read \\S+\\)\\npinned: ${escape(p.be.clone)} origin/dev@${p.beSha} \\(read \\S+\\)\\npinned: \\. pull/701/head@${p.prSha} \\(read \\S+\\)$`, "m"));
  const early = p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff"));
  assert.equal(early.status, 1, early.out);
  assert.match(early.out, /^sources: the read pins for .*d\.md were taken at \S+, after .*d\.md was last written: pin-sources ran again but the draft was not re-read and rewritten; re-read the sources, update .*d\.md, then lint it again$/m);
  p.rewrite("d.md", draft);
  const other = p.be.push("src/b.ts", "b2\n", "chore: unrelated, pushed during the read");
  const noted = p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff"));
  assert.equal(noted.status, 0, noted.out);
  assert.ok(noted.out.includes(`notice: ${p.be.clone} origin/dev moved from ${p.beSha.slice(0, 8)} to ${other.slice(0, 8)} since it was pinned; no changed file is named in the text being posted, so it posts as drafted\n`), noted.out);
  assert.match(noted.out, new RegExp(`^pinned: ${escape(p.be.clone)} origin/dev@${p.beSha} \\(read \\S+\\)$`, "m"));
  assert.doesNotMatch(noted.out, /warning:/);
  const posted = p.write(["post", p.at("d.md"), "--repo", "o/r"]);
  assert.equal(posted.status, 0, posted.out);
  assert.match(posted.out, new RegExp(`^notice: .* moved from ${p.beSha.slice(0, 8)} to ${other.slice(0, 8)} since it was pinned;`, "m"));
  const cited = p.be.push("src/a.ts", "a2\n", "fix: writer sets the field");
  const failed = p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff"));
  assert.equal(failed.status, 1, failed.out);
  assert.ok(failed.out.includes(`sources: refused: ${p.be.clone} origin/dev moved from ${p.beSha.slice(0, 8)} to ${cited.slice(0, 8)} since it was pinned and changed a file the text being posted names\n`), failed.out);
  assert.ok(failed.out.includes(`sources: a source changed while it was being read; run draft-lint.mjs pin-sources ${p.at("d.md")} again, re-read what changed, fix the draft and lint it again\n`), failed.out);
  assert.doesNotMatch(failed.out, /^clean:/m);
  assert.equal(p.lint("pin-sources", p.at("d.md"), "--pr", "701").status, 0);
  assert.equal(p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff")).status, 1);
  p.rewrite("d.md", draft);
  assert.equal(p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff")).status, 0);
});

test("a push to the PR head during the read fails the lint", () => {
  const p = project();
  assert.equal(p.lint("pin-sources", p.at("d.md"), "--pr", "701").status, 0);
  p.rewrite("d.md", DRAFT);
  p.fe.push("src/z.ts", "z\n", "fix: the author pushed during the review");
  p.fe.pr(701);
  const result = p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff"));
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /^sources: refused: \. pull\/701\/head moved from .* since it was pinned, so the PR under review changed$/m);
});

test("a reply lint reads the read pins of another file with --pinned-at", () => {
  const p = project();
  assert.equal(p.lint("pin-sources", p.at("ledger.md"), "--pr", "701").status, 0);
  p.rewrite("r.txt", "The label is still wrong, see src/a.ts.\n");
  p.be.push("src/a.ts", "a2\n", "fix: writer sets the field");
  const result = p.lint("pr-reply", p.at("r.txt"), "--pr", "701", "--pinned-at", p.at("ledger.md"));
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /^sources: refused: .* since it was pinned and changed a file the text being posted names$/m);
  assert.ok(result.out.includes(`run draft-lint.mjs pin-sources ${p.at("ledger.md")} again`), result.out);
});

test("pr-reply lints the body like a review comment and writes no pin when it fails", () => {
  const p = project();
  writeFileSync(p.at("r.txt"), "thanks, still wrong\n");
  const result = p.lint("pr-reply", p.at("r.txt"), "--pr", "701");
  assert.equal(result.status, 1);
  assert.match(result.out, /the first line must end with "\."/);
  writeFileSync(p.at("r.txt"), "The label is still wrong.\n");
  assert.match(p.write(["reply", "701", "123", "--repo", "o/r", "--body-file", p.at("r.txt")]).out, /^refused: .*r\.txt has no pinned sources/m);
});
