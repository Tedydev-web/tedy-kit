import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const STUDY = fileURLToPath(new URL("../evals/probes/study/", import.meta.url));

test("the study toolchain's Python tests pass offline with none skipped", () => {
  const run = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", STUDY, "-p", "test_*.py"], { encoding: "utf8", env: { ...process.env, STUDY_NO_NETWORK: "1" } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /^Ran [1-9]\d* tests? in /m);
  assert.match(run.stderr, /^OK$/m);
});
