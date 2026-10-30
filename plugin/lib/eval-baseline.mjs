const rate = (cell) => cell.passed / cell.runs;
const share = (cell) => `${cell.passed}/${cell.runs} on ${cell.model}`;
const round = (usd) => Math.round(usd * 1e6) / 1e6;

export function tally(results) {
  const errors = [];
  const cells = {};
  const costs = {};
  for (const result of results) {
    const key = `${result.scenario} ${result.arm}`;
    if (!result.model) {
      errors.push(`${key} run ${result.run}: no served model recorded`);
      continue;
    }
    const cell = (cells[key] ??= { passed: 0, runs: 0, model: result.model, claudeVersion: result.claudeVersion ?? null, costMean: null, costRuns: 0 });
    if (cell.model !== result.model) errors.push(`${key}: runs on ${cell.model} and ${result.model}`);
    cell.runs += 1;
    if (result.pass) cell.passed += 1;
    if (typeof result.cost === "number") {
      cell.costMean = round(((cell.costMean ?? 0) * cell.costRuns + result.cost) / (cell.costRuns + 1));
      cell.costRuns += 1;
      (costs[key] ??= []).push(result.cost);
    }
  }
  for (const [key, cell] of Object.entries(cells)) cell.costBand = cell.costRuns >= 2 ? costTolerance(costs[key]) : null;
  const all = results.map((result) => result.cost);
  const spend = { usd: all.filter((cost) => typeof cost === "number").reduce((a, b) => a + b, 0), unmeasured: all.filter((cost) => typeof cost !== "number").length };
  return { errors, cells, spend };
}

export function costTolerance(costs, cellRuns = 3) {
  if (costs.length < 2) throw new Error(`the noise band needs at least 2 runs with a cost, got ${costs.length}`);
  const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
  const sd = Math.sqrt(costs.reduce((sum, cost) => sum + (cost - mean) ** 2, 0) / (costs.length - 1));
  return Math.round((2 * sd * Math.sqrt(2 / cellRuns)) / mean * 1000) / 1000;
}

function costErrors({ before, cells, tolerance, acceptModelChange, acceptCostRise }) {
  const errors = [];
  let untolerated = false;
  for (const [key, cell] of Object.entries(cells)) {
    const old = before[key];
    if (typeof old?.costMean !== "number" || (acceptModelChange && old.model !== cell.model)) continue;
    if (cell.costRuns < cell.runs) {
      errors.push(`${key}: ${cell.runs - cell.costRuns} of ${cell.runs} runs report no cost, so the cost cannot be compared with the baseline; rerun`);
      continue;
    }
    if (typeof tolerance !== "number") {
      untolerated = true;
      continue;
    }
    const band = Math.max(old.costBand ?? 0, tolerance);
    if (!acceptCostRise && cell.costMean > old.costMean * (1 + band)) {
      errors.push(`${key}: mean cost USD ${old.costMean.toFixed(4)} rose to USD ${cell.costMean.toFixed(4)} (+${Math.round((cell.costMean / old.costMean - 1) * 100)}%), past the ${Math.round(band * 100)}% noise band; find the cause, or pass --accept-cost-rise`);
    }
  }
  if (untolerated) errors.push("baseline.json has no costTolerance: measure the noise first with rebaseline.mjs <folder> --noise --write");
  return errors;
}

export function rebaseline({ baseline, results, acceptModelChange = false, acceptCostRise = false, date }) {
  if (!results.length) return { errors: ["no results to compare"], baseline };
  const { errors, cells, spend } = tally(results);
  if (errors.length) return { errors, baseline, spend };
  const before = baseline?.cells ?? {};
  for (const [key, cell] of Object.entries(cells)) {
    const old = before[key];
    if (!old || rate(cell) >= rate(old)) continue;
    if (!acceptModelChange) errors.push(`${key}: ${share(old)} fell to ${share(cell)}; rerun, fix the regression, or pass --accept-model-change when the model changed`);
    else if (old.model === cell.model) errors.push(`${key}: ${share(old)} fell to ${share(cell)} on the same model; --accept-model-change applies only to a model change`);
  }
  errors.push(...costErrors({ before, cells, tolerance: baseline?.costTolerance, acceptModelChange, acceptCostRise }));
  if (errors.length) return { errors, baseline, spend };
  const next = Object.fromEntries(Object.entries(cells).map(([key, cell]) => [key, { ...cell, date }]));
  return { errors: [], baseline: { ...baseline, cells: { ...before, ...next } }, spend };
}

export function ablationPlan({ ledger, baseline, model }) {
  const cells = baseline?.cells ?? {};
  return ledger.rules.filter((rule) => rule.class === "model-gap").map((rule) => {
    const { scenario, with: kept, without } = rule.ablation ?? {};
    if (!scenario) return { rule: rule.id, verdict: "unmeasured", detail: "no ablation scenario; add an eval case first" };
    const [on, off] = [cells[`${scenario} ${kept}`], cells[`${scenario} ${without}`]];
    if (!on || !off) return { rule: rule.id, verdict: "unmeasured", detail: `run scenario ${scenario} with arms ${kept} and ${without}` };
    if (on.model !== off.model) return { rule: rule.id, verdict: "stale", detail: `arms measured on different models (${on.model}, ${off.model}); rerun both` };
    if (model && on.model !== model) return { rule: rule.id, verdict: "stale", detail: `measured on ${on.model}, the kit now runs on ${model}; rerun both arms` };
    if (rate(on) > rate(off)) return { rule: rule.id, verdict: "keep", detail: `with the rule ${share(on)}, without ${share(off)}` };
    return { rule: rule.id, verdict: "propose removal", detail: `without the rule ${share(off)}, with it ${share(on)}; the user decides, nothing is deleted` };
  });
}
