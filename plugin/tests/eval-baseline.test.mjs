import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ablationPlan, costTolerance, rebaseline, tally } from "../lib/eval-baseline.mjs";

const run = (scenario, arm, pass, fields = {}) => ({ scenario, arm, run: 1, pass, model: "model-a", cost: 0.1, ...fields });
const cell = (passed, runs, model = "model-a") => ({ passed, runs, model, claudeVersion: null, date: "2026-10-27" });

test("tally counts passes per scenario and arm, refuses a run without a served model or a cell on two models, and keeps unmeasured spend apart", () => {
  const { errors, cells, spend } = tally([run("s1", "green", true), run("s1", "green", false, { cost: undefined }), run("s1", "red", false)]);
  assert.deepEqual(errors, []);
  assert.deepEqual(cells, { "s1 green": { passed: 1, runs: 2, model: "model-a", claudeVersion: null, costMean: 0.1, costRuns: 1, costBand: null }, "s1 red": { passed: 0, runs: 1, model: "model-a", claudeVersion: null, costMean: 0.1, costRuns: 1, costBand: null } });
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
  assert.deepEqual(moved.baseline.cells["s1 green"], { passed: 1, runs: 2, model: "model-b", claudeVersion: null, costMean: 0.1, costRuns: 2, costBand: 0, date: "2026-10-28" });
  assert.deepEqual(moved.baseline.cells["s3 green"], cell(2, 3));
  assert.deepEqual(rebaseline({ baseline, results: [run("s3", "green", true)], date: "2026-10-28" }).errors, []);
  assert.deepEqual(rebaseline({ baseline: null, results: [], date: "2026-10-28" }).errors, ["no results to compare"]);
});

test("a pass-rate fall is refused only on the kit-on arm and the with arm of a ledger ablation, so a control arm doing worse is recorded", () => {
  const ledger = { rules: [{ id: "blast-radius", class: "model-gap", ablation: { scenario: "s7", with: "bare-rule", without: "bare" } }] };
  const baseline = { cells: { "s1 green": cell(3, 3), "s1 red": cell(1, 3), "s7 bare": cell(1, 3), "s7 bare-rule": cell(3, 3) } };
  const fall = (scenario, arm) => [run(scenario, arm, false)];
  const controls = rebaseline({ baseline, results: [...fall("s1", "red"), ...fall("s7", "bare")], ledger, date: "2026-10-30" });
  assert.deepEqual(controls.errors, []);
  assert.equal(controls.baseline.cells["s1 red"].passed, 0);
  assert.equal(rebaseline({ baseline, results: fall("s1", "green"), ledger, date: "2026-10-30" }).errors.length, 1);
  assert.equal(rebaseline({ baseline, results: fall("s7", "bare-rule"), ledger, date: "2026-10-30" }).errors.length, 1);
  assert.equal(rebaseline({ baseline, results: fall("s1", "red"), date: "2026-10-30" }).errors.length, 1);
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

test("a rebaseline whose mean cost rises past the noise band is refused unless the rise is accepted or the model changed", () => {
  const priced = (passed, runs, costMean, model = "model-a") => ({ ...cell(passed, runs, model), costMean, costRuns: runs });
  const baseline = { costTolerance: 0.2, cells: { "s1 green": priced(3, 3, 0.1) } };
  const at = (cost, fields = {}) => [1, 2, 3].map((n) => run("s1", "green", true, { run: n, cost, ...fields }));
  assert.deepEqual(rebaseline({ baseline, results: at(0.11), date: "2026-10-30" }).errors, []);
  assert.deepEqual(rebaseline({ baseline, results: at(0.15), date: "2026-10-30" }).errors, [
    "s1 green: mean cost USD 0.1000 rose to USD 0.1500 (+50%), past the 20% noise band; find the cause, or pass --accept-cost-rise",
  ]);
  assert.deepEqual(rebaseline({ baseline, results: at(0.15), acceptCostRise: true, date: "2026-10-30" }).errors, []);
  assert.deepEqual(rebaseline({ baseline, results: at(0.15, { model: "model-b" }), acceptModelChange: true, date: "2026-10-30" }).errors, []);
  assert.deepEqual(rebaseline({ baseline, results: [...at(0.1).slice(0, 2), run("s1", "green", true, { run: 3, cost: undefined })], date: "2026-10-30" }).errors, [
    "s1 green: 1 of 3 runs report no cost, so the cost cannot be compared with the baseline; rerun",
  ]);
  assert.deepEqual(rebaseline({ baseline: { cells: baseline.cells }, results: at(0.1), date: "2026-10-30" }).errors, [
    "baseline.json has no costTolerance: measure the noise first with rebaseline.mjs <folder> --noise --write",
  ]);
  assert.equal(rebaseline({ baseline, results: at(0.11), date: "2026-10-30" }).baseline.costTolerance, 0.2);
});

test("a cell is judged on its own measured cost band, never narrower than the noise floor", () => {
  const priced = (costMean, costBand) => ({ ...cell(3, 3), costMean, costRuns: 3, costBand });
  const at = (cost) => [1, 2, 3].map((n) => run("s6", "bare", true, { run: n, cost }));
  const baseline = { costTolerance: 0.05, cells: { "s6 bare": priced(0.1, 0.3) } };
  assert.deepEqual(rebaseline({ baseline, results: at(0.125), date: "2026-10-30" }).errors, []);
  assert.deepEqual(rebaseline({ baseline, results: at(0.14), date: "2026-10-30" }).errors, [
    "s6 bare: mean cost USD 0.1000 rose to USD 0.1400 (+40%), past the 30% noise band; find the cause, or pass --accept-cost-rise",
  ]);
  const narrow = { costTolerance: 0.05, cells: { "s6 bare": priced(0.1, 0.01) } };
  assert.deepEqual(rebaseline({ baseline: narrow, results: at(0.104), date: "2026-10-30" }).errors, []);
  assert.equal(rebaseline({ baseline: narrow, results: at(0.106), date: "2026-10-30" }).errors.length, 1);
  assert.equal(tally([0.9, 1.1, 1].map((cost, n) => run("s6", "bare", true, { run: n + 1, cost }))).cells["s6 bare"].costBand, costTolerance([0.9, 1.1, 1]));
});

test("the cost noise band is two standard errors of the difference between two three-run means, relative to the mean", () => {
  assert.equal(costTolerance([0.9, 1.1]), 0.231);
  assert.throws(() => costTolerance([1]), /at least 2 runs/);
});
