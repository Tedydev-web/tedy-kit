import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runWithFakeGh } from "./fake-gh-for-tests.mjs";
import { world } from "./fake-services-for-tests.mjs";
import { mappedProfile, tempDir } from "./temp-dir-for-tests.mjs";

const GITHUB_WRITE = new URL("../lib/github-write.mjs", import.meta.url).pathname;
const JOB = new URL("../scripts/job.mjs", import.meta.url).pathname;
const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -9,2 +10,2 @@\n context line\n+added line\n";
const BODY = "The label is wrong.";

async function linted(gh) {
  const w = world({ pr: 701, gh: { diff: DIFF, ...gh } });
  const head = w.checkout.pr(701);
  w.file("d.md", `# PR #701: comment line by line (head ${head.slice(0, 7)})\n\n## 1. \`src/a.ts:10\`\n${BODY}\n`);
  assert.equal((await w.run("draft-lint", ["pr-comment", "d.md", "--repo", "o/r"])).code, 0);
  return { w };
}

test("post prints each posted comment's line, taking the drafted line when the API reply has none", async () => {
  const { w } = await linted({ reviewComments: [{ id: 41, path: "src/a.ts", body: BODY, commit_id: "c".repeat(40) }], write: { id: 9, html_url: "https://x/9" } });
  const posted = await w.run("github-write", ["post", "d.md", "--repo", "o/r"]);
  assert.equal(posted.code, 0, posted.out);
  assert.match(posted.out, /^41 src\/a\.ts:10 RIGHT cccccccc$/m);
  assert.doesNotMatch(posted.out, /undefined/);
});

test("a failure says whether anything was written: nothing before the first write call, and a check on GitHub once one was sent", () => {
  const dir = tempDir("tedy-gw-fail-");
  const sent = runWithFakeGh(GITHUB_WRITE, ["minimize", "IC_x"], { fixture: { graphql: { errors: [{ message: "fetch failed" }] } }, cwd: dir });
  assert.equal(sent.status, 1, sent.out);
  assert.match(sent.out, /^github-write: IC_x is not minimized: .*fetch failed.*$/m);
  assert.match(sent.out, /^github-write: a write was sent before this failed; check on GitHub what it changed before running this again$/m);
  const failing = runWithFakeGh(GITHUB_WRITE, ["reply", "701", "5", "--body", "fixed", "--repo", "o/r"], { cwd: dir });
  assert.equal(failing.status, 1, failing.out);
  assert.match(failing.out, /^github-write: nothing was written$/m);
  assert.deepEqual(failing.writes, []);
});

test("job.mjs run outside every mapped folder names the mapped project roots", () => {
  const root = tempDir("tedy-job-root-");
  const outside = tempDir("tedy-job-outside-");
  const result = spawnSync("node", [JOB, "list"], { cwd: outside, encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: mappedProfile(root) } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), `job: no project map covers ${outside}; run job.mjs from the root of a mapped project: ${root} (w)`);
});
