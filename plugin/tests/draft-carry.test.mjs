import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../gates/publish-quote-gate.mjs";
import { world } from "./fake-services-for-tests.mjs";

const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -9,2 +10,2 @@\n context line\n+added line\n";
const BODY = "The label is wrong.";

async function reviewWorld() {
  const w = world({ pr: 701, gh: { diff: DIFF, reviewComments: [{ id: 1, path: "src/a.ts", line: 10, side: "RIGHT", commit_id: "0".repeat(40) }] } });
  const head = w.checkout.pr(701);
  const file = w.file("d.md", `# PR #701: comment line by line (head ${head.slice(0, 7)})\n\n## 1. \`src/a.ts:10\`\n${BODY}\n`);
  const lint = await w.run("draft-lint", ["pr-comment", "d.md", "--repo", "o/r"]);
  assert.equal(lint.code, 0, lint.out);
  return { w, head, file };
}

const snapshot = (w, file) => join(w.dir, "state", "drafts", file.replace(/\//g, "_"));
const record = (w, file) => JSON.parse(readFileSync(`${snapshot(w, file)}.sources.json`, "utf8"));

function shownAt(w, ms) {
  const path = join(w.dir, "transcript.jsonl");
  writeFileSync(path, `${JSON.stringify({ type: "assistant", timestamp: new Date(ms).toISOString(), message: { content: [{ type: "text", text: `\`\`\`\n${BODY}\n\`\`\`` }] } })}\n`);
  return path;
}

test("carry moves a review draft to the PR's new head when the new commits change no commented file, and the post then goes out", async () => {
  const { w, head, file } = await reviewWorld();
  const before = statSync(file).mtimeMs;
  const moved = w.checkout.pushPr("src/b.ts", "b2\n", "style: spacing");
  const refused = await w.run("github-write", ["post", "d.md", "--repo", "o/r"]);
  assert.match(refused.out, new RegExp(`refused: PR head moved from ${head.slice(0, 7)} to ${moved.slice(0, 8)}; if the new commits change no commented file, run draft-lint\\.mjs carry d\\.md --repo o/r, otherwise review them and redraft`));
  assert.deepEqual(w.writes(), []);
  const carried = await w.run("draft-lint", ["carry", "d.md", "--repo", "o/r"]);
  assert.equal(carried.code, 0, carried.out);
  assert.match(carried.out, new RegExp(`^carried: d\\.md from ${head.slice(0, 8)} to ${moved.slice(0, 8)}; the new commits change no commented file \\(src/a\\.ts\\)$`, "m"));
  assert.match(readFileSync(file, "utf8"), new RegExp(`^# PR #701: comment line by line \\(head ${moved.slice(0, 7)}\\)$`, "m"));
  assert.match(readFileSync(snapshot(w, file), "utf8"), new RegExp(`\\(head ${moved.slice(0, 7)}\\)`));
  assert.equal(record(w, file).sources.find((pin) => pin.pr === 701).sha, moved);
  assert.equal(statSync(file).mtimeMs, before);
  const posted = await w.run("github-write", ["post", "d.md", "--repo", "o/r"]);
  assert.equal(posted.code, 0, posted.out);
  assert.equal(w.writes().length, 1);
});

test("after a carry the body the chat showed before still counts as shown, and a real body edit does not", async () => {
  const { w, file } = await reviewWorld();
  const transcript = shownAt(w, statSync(file).mtimeMs + 1000);
  w.checkout.pushPr("src/b.ts", "b2\n", "style: spacing");
  assert.equal((await w.run("draft-lint", ["carry", "d.md", "--repo", "o/r"])).code, 0);
  const input = { tool_name: "Bash", tool_input: { command: `node /k/github-write.mjs post ${file} --repo o/r` }, cwd: w.dir, transcript_path: transcript };
  assert.equal(check(input), null);
  writeFileSync(file, readFileSync(file, "utf8").replace(BODY, "The label is wrong here."));
  assert.match(check(input)?.reason ?? "", /\(publishQuote\)/);
});

test("with read pins from pin-sources, a carried draft posts, and a body edited after the carry lints again without a new pin-sources", async () => {
  const w = world({ pr: 701, gh: { diff: DIFF, reviewComments: [{ id: 1, path: "src/a.ts", line: 10, side: "RIGHT", commit_id: "0".repeat(40) }] } });
  const head = w.checkout.pr(701);
  const pinned = await w.run("draft-lint", ["pin-sources", "d.md", "--pr", "701", "--repo", "o/r"]);
  assert.equal(pinned.code, 0, pinned.out);
  const file = w.file("d.md", `# PR #701: comment line by line (head ${head.slice(0, 7)})\n\n## 1. \`src/a.ts:10\`\n${BODY}\n`);
  assert.equal((await w.run("draft-lint", ["pr-comment", "d.md", "--repo", "o/r"])).code, 0);
  w.checkout.pushPr("src/b.ts", "b2\n", "style: spacing");
  assert.equal((await w.run("draft-lint", ["carry", "d.md", "--repo", "o/r"])).code, 0);
  writeFileSync(file, readFileSync(file, "utf8").replace(BODY, "The label is wrong here."));
  const relint = await w.run("draft-lint", ["pr-comment", "d.md", "--repo", "o/r"]);
  assert.equal(relint.code, 0, relint.out);
  const posted = await w.run("github-write", ["post", "d.md", "--repo", "o/r"]);
  assert.equal(posted.code, 0, posted.out);
  assert.equal(w.writes().length, 1);
});

test("carry refuses, and changes nothing, when the new commits change a commented file", async () => {
  const { w, file } = await reviewWorld();
  const text = readFileSync(file, "utf8");
  w.checkout.pushPr("src/a.ts", "a2\n", "fix: label");
  const refused = await w.run("draft-lint", ["carry", "d.md", "--repo", "o/r"]);
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /^refused: carry: o\/r#701 moved from [0-9a-f]{8} to [0-9a-f]{8} and the new commits change files the draft comments on or names: src\/a\.ts; review them and redraft$/m);
  assert.equal(readFileSync(file, "utf8"), text);
});

test("carry refuses when the new commits change a file a comment body names, not only a commented path", async () => {
  const w = world({ pr: 701, gh: { diff: DIFF, reviewComments: [] } });
  const head = w.checkout.pr(701);
  const file = w.file("d.md", `# PR #701: comment line by line (head ${head.slice(0, 7)})\n\n## 1. \`src/a.ts:10\`\nThe label differs from \`src/b.ts\`.\n`);
  assert.equal((await w.run("draft-lint", ["pr-comment", "d.md", "--repo", "o/r"])).code, 0);
  const text = readFileSync(file, "utf8");
  w.checkout.pushPr("src/b.ts", "b2\n", "fix: label source");
  const refused = await w.run("draft-lint", ["carry", "d.md", "--repo", "o/r"]);
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /^refused: carry: o\/r#701 moved from [0-9a-f]{8} to [0-9a-f]{8} and the new commits change files the draft comments on or names: src\/b\.ts; review them and redraft$/m);
  assert.equal(readFileSync(file, "utf8"), text);
});

test("carry refuses a draft edited since its lint, a PR that has not moved and a repo the draft was not linted for", async () => {
  const { w, file } = await reviewWorld();
  const same = await w.run("draft-lint", ["carry", "d.md", "--repo", "o/r"]);
  assert.equal(same.code, 1);
  assert.match(same.out, /^refused: carry: o\/r#701 is still at [0-9a-f]{8}, the head the draft names; nothing to carry$/m);
  const other = await w.run("draft-lint", ["carry", "d.md", "--repo", "o/x"]);
  assert.match(other.out, /^refused: carry: d\.md was linted for o\/r#701, not o\/x#701/m);
  w.checkout.pushPr("src/b.ts", "b2\n", "style: spacing");
  writeFileSync(file, readFileSync(file, "utf8").replace(BODY, "Edited after the lint."));
  const edited = await w.run("draft-lint", ["carry", "d.md", "--repo", "o/r"]);
  assert.equal(edited.code, 1);
  assert.match(edited.out, /refused: .*d\.md changed after its sources were pinned/);
  assert.match(readFileSync(file, "utf8"), /Edited after the lint\./);
});
