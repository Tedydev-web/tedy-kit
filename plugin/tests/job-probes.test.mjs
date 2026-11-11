import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const read = (relative) => readFileSync(path(relative), "utf8");

test("the job probe is a manual cockpit procedure: no claude -p --agent probe or its probe agent is left, and run-probes.sh jobs prints the procedure", () => {
  assert.deepEqual(readdirSync(path("../evals/probes")).filter((name) => name.startsWith("job")), ["job-probe.md"]);
  assert.equal(existsSync(path("../evals/probes/probe/agents")), false);
  const runner = read("../evals/probes/run-probes.sh");
  for (const word of ["--agent", "job-probes", "zz-job-probe", "--bg"]) assert.ok(!runner.includes(word), `run-probes.sh has ${word}`);
  assert.match(runner, /case "\$\{1:-\}" in jobs\) exec cat "\$HERE\/job-probe\.md" ;; esac/);
  const procedure = read("../evals/probes/job-probe.md");
  for (const word of ["claude --plugin-dir", "TEDY_STATE_DIR", "TEDY_PROFILE_DIR", '"jobs":true', "job.mjs list", "SendMessage", "job.mjs close", "gate-log.jsonl", "push-report", "ADR 0019"]) assert.ok(procedure.includes(word), `job-probe.md lacks ${word}`);
  for (const word of ["claude -p", "--agent "]) assert.ok(!procedure.includes(word), `job-probe.md has ${word}`);
});
