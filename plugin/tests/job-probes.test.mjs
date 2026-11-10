import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

test("the job probes measure only print sessions: no background launch, fleet list, claude stop or claude rm is left in them", () => {
  const source = read("../evals/probes/job-probes.mjs");
  for (const word of ["--bg", "claude agents", '"agents"', '"stop"', '"rm"']) assert.ok(!source.includes(word), `job-probes.mjs has ${word}`);
  assert.match(read("../evals/probes/run-probes.sh"), /case "\$\{1:-\}" in jobs\|9\|10\) exec node/);
});
