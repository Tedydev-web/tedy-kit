import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ablationPlan, rebaseline, tally } from "../lib/eval-baseline.mjs";

const run = (scenario, arm, pass, fields = {}) => ({ scenario, arm, run: 1, pass, model: "model-a", cost: 0.1, ...fields });
const cell = (passed, runs, model = "model-a") => ({ passed, runs, model, claudeVersion: null, date: "2026-10-27" });

test("tally counts passes per scenario and arm, refuses a run without a served model or a cell on two models, and keeps unmeasured spend apart", () => {
  const { errors, cells, spend } = tally([run("s1", "green", true), run("s1", "green", false, { cost: undefined }), run("s1", "red", false)]);
  assert.deepEqual(errors, []);
  assert.deepEqual(cells, { "s1 green": { passed: 1, runs: 2, model: "model-a", claudeVersion: null }, "s1 red": { passed: 0, runs: 1, model: "model-a", claudeVersion: null } });
  assert.deepEqual(spend, { usd: 0.2, unmeasured: 1 });
  assert.deepEqual(tally([run("s1", "green", true, { model: undefined }), run("s1", "red", true), run("s1", "red", true, { model: "model-b" })]).errors, [
    "s1 green run 1: no served model recorded",
    "s1 red: runs on model-a and model-b",
  ]);
});

test("a rebaseline that lowers a pass rate is refused unless the model changed and the change is accepted", () => {
  const baseline = { cells: { "s1 green": cell(3, 3), "s3 green": cell(2, 3) } };
  const worse = [run("s1", "green", true), run("s1", "green", false)];
  assert.deepEqual(rebaseline({ baseline, results: worse, date: "2026-10-28" }).errors, ["s1 green: 3/3 on model-a fell to 1/2 on model-a; rerun, fix the regression, or pass --accept-model-change when the model changed"]);
  assert.deepEqual(rebaseline({ baseline, results: worse, acceptModelChange: true, date: "2026-10-28" }).errors, ["s1 green: 3/3 on model-a fell to 1/2 on model-a on the same model; --accept-model-change applies only to a model change"]);
  const moved = rebaseline({ baseline, results: worse.map((result) => ({ ...result, model: "model-b" })), acceptModelChange: true, date: "2026-10-28" });
  assert.deepEqual(moved.errors, []);
  assert.deepEqual(moved.baseline.cells["s1 green"], { passed: 1, runs: 2, model: "model-b", claudeVersion: null, date: "2026-10-28" });
  assert.deepEqual(moved.baseline.cells["s3 green"], cell(2, 3));
  assert.deepEqual(rebaseline({ baseline, results: [run("s3", "green", true)], date: "2026-10-28" }).errors, []);
  assert.deepEqual(rebaseline({ baseline: null, results: [], date: "2026-10-28" }).errors, ["no results to compare"]);
});

test("the ablation plan keeps a model-gap rule that still helps, proposes removing one that does not, and never measures across models", () => {
  const ledger = { rules: [
    { id: "helps", class: "model-gap", ablation: { scenario: "s6", with: "rule", without: "red" } },
    { id: "idle", class: "model-gap", ablation: { scenario: "s7", with: "rule", without: "red" } },
    { id: "unrun", class: "model-gap", ablation: { scenario: "s8", with: "rule", without: "red" } },
    { id: "mixed", class: "model-gap", ablation: { scenario: "s9", with: "rule", without: "red" } },
    { id: "policy", class: "user-policy" },
  ] };
  const baseline = { cells: { "s6 rule": cell(3, 3), "s6 red": cell(1, 3), "s7 rule": cell(2, 3), "s7 red": cell(3, 3), "s9 rule": cell(3, 3), "s9 red": cell(0, 3, "model-b") } };
  assert.deepEqual(ablationPlan({ ledger, baseline }).map(({ rule, verdict }) => `${rule} ${verdict}`), ["helps keep", "idle propose removal", "unrun unmeasured", "mixed stale"]);
  assert.match(ablationPlan({ ledger, baseline }).find((row) => row.rule === "idle").detail, /nothing is deleted/);
  assert.deepEqual(ablationPlan({ ledger, baseline, model: "model-c" })[0], { rule: "helps", verdict: "stale", detail: "measured on model-a, the kit now runs on model-c; rerun both arms" });
});
