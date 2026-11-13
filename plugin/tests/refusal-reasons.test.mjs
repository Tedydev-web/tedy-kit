import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runWithFakeGh } from "./fake-gh-for-tests.mjs";
import { world } from "./fake-services-for-tests.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const GITHUB_WRITE = new URL("../lib/github-write.mjs", import.meta.url).pathname;
const SCRIPTS = new URL("../scripts/", import.meta.url).pathname.replace(/\/$/, "");
const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -9,2 +10,2 @@\n context line\n+added line\n";

const logged = (state) => (existsSync(join(state, "gate-log.jsonl")) ? readFileSync(join(state, "gate-log.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

test("a github-write refusal ends with the layer that refused and says nothing was written, and the gate log holds its reason", () => {
  const dir = tempDir("tedy-refusal-cwd-");
  writeFileSync(join(dir, "d.md"), "# PR #701: comment line by line (head abc1234)\n\n## 1. `src/a.ts:10`\nThe label is wrong.\n");
  const state = tempDir("tedy-refusal-state-");
  const result = runWithFakeGh(GITHUB_WRITE, ["post", "d.md", "--repo", "o/r"], { fixture: { diff: DIFF, head: "0".repeat(40) }, cwd: dir, stateDir: state });
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /^refused: PR head moved from abc1234 to 00000000;.*\nrefused by github-write: nothing was written$/m);
  const [entry] = logged(state).filter((line) => line.decision === "refused");
  assert.equal(entry.hook, "github-write");
  assert.match(entry.reason, /PR head moved from abc1234 to 00000000/);
});

test("a pin refusal names the pins layer, and the gate log holds it", async () => {
  const w = world({ pr: 701, gh: { diff: DIFF, reviewComments: [{ id: 1, path: "src/a.ts", line: 10, side: "RIGHT", commit_id: "0".repeat(40) }] } });
  const head = w.checkout.pr(701);
  w.file("d.md", `# PR #701: comment line by line (head ${head.slice(0, 7)})\n\n## 1. \`src/a.ts:10\`\nThe label is wrong.\n`);
  assert.equal((await w.run("draft-lint", ["pr-comment", "d.md", "--repo", "o/r"])).code, 0);
  writeFileSync(join(w.dir, "d.md"), readFileSync(join(w.dir, "d.md"), "utf8").replace("wrong.", "wrong here."));
  const refused = await w.run("github-write", ["post", "d.md", "--repo", "o/r"]);
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /^refused: .*d\.md changed after its sources were pinned.*\nrefused by pins: nothing was written$/m);
  const entry = logged(join(w.dir, "state")).find((line) => line.decision === "refused" && line.hook === "pins");
  assert.match(entry.reason, /changed after its sources were pinned/);
});

test("a lock refusal is logged under the lock layer, for every writer that takes records", async () => {
  const w = world({ pr: 701, gh: { diff: DIFF, reviewComments: [{ id: 1, path: "src/a.ts", line: 10, side: "RIGHT", commit_id: "0".repeat(40) }] } });
  const head = w.checkout.pr(701);
  w.file("d.md", `# PR #701: comment line by line (head ${head.slice(0, 7)})\n\n## 1. \`src/a.ts:10\`\nThe label is wrong.\n`);
  assert.equal((await w.run("draft-lint", ["pr-comment", "d.md", "--repo", "o/r"])).code, 0);
  w.holdRecord("github:o/r#701");
  const refused = await w.run("github-write", ["post", "d.md", "--repo", "o/r"]);
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /^github-write: nothing was written$/m);
  const entry = logged(join(w.dir, "state")).find((line) => line.decision === "refused" && line.hook === "lock");
  assert.match(entry.reason, /github:o\/r#701 is being written by pid/);
});

