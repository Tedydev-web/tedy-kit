import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROBE = fileURLToPath(new URL("./regex-backtracking-probe.mjs", import.meta.url));

test("no gate regex takes longer than 250 ms on a crafted 200,000-character input", () => {
  const run = spawnSync(process.execPath, [PROBE], { encoding: "utf8", timeout: 120_000 });
  assert.equal(run.signal, null, "the probe did not finish within 120 s");
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), []);
});
