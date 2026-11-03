---
name: Anteneh-T-Tessema/meshflow
pinned: https://github.com/Anteneh-T-Tessema/meshflow/tree/081a368f238731d829a9f59201e57e02ad048a46
license: Apache-2.0
studied: 2026-10-30
channel: github
domains: evals, cost
use-when: you gate CI on token, cost and pass-rate regressions against a stored baseline
---

# Anteneh-T-Tessema/meshflow

A supplement of sweep 261021-canon, not reference-labelled: a multi-agent framework whose `meshflow/eval/ci_gate.py` compares a stored baseline eval with the current one on total tokens, total cost and pass rate and returns 1 on a rise or drop past a fixed threshold, studied for S32 (technique T5) as the simplest quota-and-score gate found, though it compares point totals with no noise interval, reads a missing field as a passing value, passes when no baseline exists, and in the repository's own CI runs mocked against a placeholder; the LICENSE file is Apache 2.0, while the GitHub API reports NOASSERTION; the kit lines cited below are the uncommitted T5 work in the worktree on 2026-10-30.

## Evidence
- https://github.com/Anteneh-T-Tessema/meshflow/blob/081a368f238731d829a9f59201e57e02ad048a46/meshflow/eval/ci_gate.py#L1-L5 "CI budget gate — blocks a build when token/cost regression exceeds threshold."
- https://github.com/Anteneh-T-Tessema/meshflow/blob/081a368f238731d829a9f59201e57e02ad048a46/meshflow/eval/ci_gate.py#L101-L103 "tokens = int(data.get("total_tokens", data.get("tokens", 0))) cost = float(data.get("total_cost_usd", data.get("cost_usd", 0.0))) rate = float(data.get("pass_rate", data.get("pass_rate_pct", 1.0)))"
  - A missing field reads as 0 tokens, 0 USD and a 100% pass rate.
- https://github.com/Anteneh-T-Tessema/meshflow/blob/081a368f238731d829a9f59201e57e02ad048a46/meshflow/eval/ci_gate.py#L139-L141 "tok_delta = (c_tok - b_tok) / max(b_tok, 1) cost_delta = (c_cost - b_cost) / max(b_cost, 1e-9) rate_delta = c_rate - b_rate # in pp"
- https://github.com/Anteneh-T-Tessema/meshflow/blob/081a368f238731d829a9f59201e57e02ad048a46/meshflow/eval/ci_gate.py#L153-L155 "token_regression=tok_delta > self._max_tokens, cost_regression=cost_delta > self._max_cost, quality_regression=rate_delta < -self._max_quality,"
- https://github.com/Anteneh-T-Tessema/meshflow/blob/081a368f238731d829a9f59201e57e02ad048a46/meshflow/eval/ci_gate.py#L169-L171 "return 0 # Don't fail if there's no baseline yet"
- https://github.com/Anteneh-T-Tessema/meshflow/blob/081a368f238731d829a9f59201e57e02ad048a46/meshflow/eval/ci_gate.py#L179-L181 "if report.any_regression: print(" [ci-gate] FAILED: regression detected.", file=sys.stderr) return 1"
- https://github.com/Anteneh-T-Tessema/meshflow/blob/081a368f238731d829a9f59201e57e02ad048a46/meshflow/eval/baseline.py#L117-L123 "def to_dict(self) -> dict[str, Any]: return { "suite_name": self.suite_name, "timestamp": self.timestamp, "pass_rate": self.pass_rate, "weighted_score": self.weighted_score, "total_tokens": self.total_tokens,"
  - The writer `to_dict` (lines 117-135) has no cost key, so a baseline saved by `--save-baseline` reads as 0 USD on both sides and the cost gate cannot fire (DERIVED from this and ci_gate.py line 102).
- https://github.com/Anteneh-T-Tessema/meshflow/blob/081a368f238731d829a9f59201e57e02ad048a46/.github/workflows/cost-regression.yml#L36 "continue-on-error: true # First run has no baseline — skip gate"
- https://github.com/Anteneh-T-Tessema/meshflow/blob/081a368f238731d829a9f59201e57e02ad048a46/.github/workflows/cost-regression.yml#L41-L42 "MESHFLOW_MODEL: claude-haiku-4-5-20251001 # cheap model for CI MESHFLOW_MOCK: "1""
- https://github.com/Anteneh-T-Tessema/meshflow/blob/081a368f238731d829a9f59201e57e02ad048a46/.github/workflows/cost-regression.yml#L49-L55 "if [ -f eval/ci_suite.yaml ]; then"
  - No file under `eval/` is tracked at the pinned SHA (`git ls-files eval` is empty), so the else branch writes `{"total_tokens":0,"total_cost_usd":0,"pass_rate":1.0}` on every run.
- https://github.com/Anteneh-T-Tessema/meshflow/blob/081a368f238731d829a9f59201e57e02ad048a46/.github/workflows/cost-regression.yml#L58-L61 "if: steps.download_baseline.outcome == 'success'"
- https://github.com/Anteneh-T-Tessema/meshflow/blob/081a368f238731d829a9f59201e57e02ad048a46/.github/workflows/cost-regression.yml#L67-L72 "path: eval_current.json"
  - The artifact uploaded as `eval-baseline` holds `eval_current.json`, while the gate reads `baselines/eval_baseline.json` (line 61); the gate would then find no baseline and return 0 (DERIVED, not run).

## Issues and changelog
The repository has no closed issues and no merged pull requests, so nothing could be sorted. `CHANGELOG.md` mentions the gate once.
- https://github.com/Anteneh-T-Tessema/meshflow/blob/081a368f238731d829a9f59201e57e02ad048a46/CHANGELOG.md#L430 "Cost Regression Gate `.venv/bin/python` replaced with `python`"
  - The only recorded fix is to how the workflow starts Python, not to what the gate compares.

## Lessons
- Tokens, cost and pass rate compared in one call with one exit code is the minimum shape of a quota-and-score gate (S32, Q25): ci_gate.py lines 153-155 and 179-181. Touches plugin/lib/eval-baseline.mjs:54-69 (`rebaseline` refuses a pass-rate drop and, through `costErrors` at :35, a cost rise in one run); overlap; none.
- A point delta against a fixed threshold, with no interval, is the weaker form (Q25): ci_gate.py lines 139-141 and 153-155, defaults 10% and 5 points (lines 124-126). Touches plugin/lib/eval-baseline.mjs:28 (`costTolerance` derives the band from measured runs instead); the kit is already stronger; not taken.
- A missing field must not read as a pass (S8, Q24): ci_gate.py lines 101-103 turn an absent pass rate into 1.0 and absent cost into 0. Touches plugin/lib/eval-baseline.mjs:41-43 (refuses a cell whose runs report no cost) and :10-12 (refuses a run with no served model); overlap, the kit is stricter; none.
- Fails open with no baseline (Q25): ci_gate.py lines 169-171, workflow line 36. Touches plugin/lib/eval-baseline.mjs:40 and :61 (a cell with no baseline passes as new); overlap; same choice as trg (see its card).
- A gate that never sees a real number is not a gate: here the baseline writer drops cost and the workflow compares a mocked placeholder, so a test that plants a regression and proves the gate fires is the kit lesson (S32): baseline.py lines 117-135, workflow lines 41-55. Touches plugin/tests/eval-baseline.test.mjs (the gate's own test, which must feed the shape grade-pressure.mjs:65 actually writes); partial; low cost.
- Not covered: a Claude Code kit artifact (this is a Python multi-agent framework), cache tokens (`total_tokens` is one number), per-cell or per-case figures, a no-plugin arm, any variance.
