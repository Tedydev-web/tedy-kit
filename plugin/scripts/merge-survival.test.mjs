import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hiddenPublish } from "./git-gate.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "git-gate.mjs");

function runGate(command, env = {}) {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "/tmp" });
  return spawnSync("node", [GATE], { input, encoding: "utf8", env: { ...process.env, TEDY_STATE_DIR: tempDir("tedy-state-"), ...env } });
}

const PUBLISH_SAMPLES = [
  "x/github-write.mjs post d.md",
  "x/github-write.mjs reply 1 --body b",
  "x/github-write.mjs edit 1 --body b",
  "x/github-write.mjs minimize 1",
  "x/github-write.mjs resolve 1",
  "x/github-write.mjs unresolve 1",
  "x/github-write.mjs pr-body 1 --body-file b.md",
  "x/openproject.mjs apply d.json",
  "x/openproject.mjs set 1 --status S --apply",
  "x/openproject.mjs comment 1 --apply",
  "x/openproject.mjs comment-edit 1 --apply",
  "x/openproject.mjs relation 1 2 --apply",
  "x/openproject.mjs relation-delete 1 2 --apply",
  "x/openproject.mjs rollback --apply",
  "x/figma-comments.mjs post f",
  "x/figma-comments.mjs reply f",
  "x/figma-comments.mjs delete f",
  "x/gdoc-comments.mjs reply f",
  "x/gdoc-comments.mjs anchor f",
  "x/gdoc-comments.mjs edit f",
  "x/gdoc-comments.mjs delete f",
  "x/doc-comment-file.mjs post f --apply",
];

test("hiddenPublish flags every publish subcommand main gates", () => {
  const missed = PUBLISH_SAMPLES.filter((sample) => hiddenPublish("sh " + sample) === null);
  assert.deepEqual(missed, []);
});

test("git-gate denies a shell read of the tracker token file", () => {
  const result = runGate("cat ~/" + ".config/op/" + "config.json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("git-gate entry passes the profile's gates to evaluate", () => {
  const draftOnly = runGate("gh pr create --fill", { TEDY_PROFILE_DIR: profileWith({ gates: { draftPrOnly: true } }) });
  assert.equal(draftOnly.status, 0, draftOnly.stderr);
  assert.equal(JSON.parse(draftOnly.stdout).hookSpecificOutput.permissionDecision, "deny");
  const open = runGate("gh pr create --fill", { TEDY_PROFILE_DIR: profileWith({ gates: { draftPrOnly: false } }) });
  assert.equal(open.status, 0, open.stderr);
  assert.equal(open.stdout, "");
});
