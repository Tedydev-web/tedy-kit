import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROBE = fileURLToPath(new URL("./regex-backtracking-probe.mjs", import.meta.url));

test("no gate regex grows faster than linear from 50,000 to 200,000 crafted characters or passes 1,000 ms of CPU time", () => {
  const run = spawnSync(process.execPath, [PROBE], { encoding: "utf8", timeout: 120_000 });
  assert.equal(run.signal, null, "the probe did not finish within 120 s");
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), []);
});
