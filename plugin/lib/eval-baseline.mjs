const rate = (cell) => cell.passed / cell.runs;
const share = (cell) => `${cell.passed}/${cell.runs} on ${cell.model}`;

export function tally(results) {
  const errors = [];
  const cells = {};
  for (const result of results) {
    const key = `${result.scenario} ${result.arm}`;
    if (!result.model) {
      errors.push(`${key} run ${result.run}: no served model recorded`);
      continue;
    }
    const cell = (cells[key] ??= { passed: 0, runs: 0, model: result.model, claudeVersion: result.claudeVersion ?? null });
    if (cell.model !== result.model) errors.push(`${key}: runs on ${cell.model} and ${result.model}`);
    cell.runs += 1;
    if (result.pass) cell.passed += 1;
  }
  const costs = results.map((result) => result.cost);
  const spend = { usd: costs.filter((cost) => typeof cost === "number").reduce((a, b) => a + b, 0), unmeasured: costs.filter((cost) => typeof cost !== "number").length };
  return { errors, cells, spend };
}

export function rebaseline({ baseline, results, acceptModelChange = false, date }) {
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
  if (errors.length) return { errors, baseline, spend };
  const next = Object.fromEntries(Object.entries(cells).map(([key, cell]) => [key, { ...cell, date }]));
  return { errors: [], baseline: { cells: { ...before, ...next } }, spend };
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
