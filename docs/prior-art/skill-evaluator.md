---
name: EmadMokhtar/skill-evaluator
pinned: https://github.com/EmadMokhtar/skill-evaluator/tree/1ce02bc689899cf801d4b6fa83c16e26b41be3e5
license: MIT
studied: 2026-10-30
channel: github
---

# EmadMokhtar/skill-evaluator

A supplement of sweep 261021-canon, not reference-labelled: skill-lens, an eval runner for SKILL.md cases that scores each case on assertions, trajectory, an optional judge and a token, cost and latency budget, studied for S32 because a case over its budget fails the case and the CLI exits non-zero, though it gates SKILL.md eval cases only, needs a `budget:` the author declares per case in the eval file, and reads no cache TTL, cached-prefix order or context share of the window.

## Evidence
- https://github.com/EmadMokhtar/skill-evaluator/blob/1ce02bc689899cf801d4b6fa83c16e26b41be3e5/src/skill_lens/evaluators/budget.py#L1 "Scoring efficiency: a skill that works but costs too much has a real problem."
- https://github.com/EmadMokhtar/skill-evaluator/blob/1ce02bc689899cf801d4b6fa83c16e26b41be3e5/docs/eval-files.md#L33 "| `budget:` | Did it stay inside a token, cost or latency limit? | Nothing |"
- https://github.com/EmadMokhtar/skill-evaluator/blob/1ce02bc689899cf801d4b6fa83c16e26b41be3e5/src/skill_lens/evaluators/budget.py#L35-L37 "held = result.tokens <= spec.max_tokens evidence = f"used {result.tokens} tokens, limit is {spec.max_tokens}""
- https://github.com/EmadMokhtar/skill-evaluator/blob/1ce02bc689899cf801d4b6fa83c16e26b41be3e5/src/skill_lens/evaluators/budget.py#L54 "held = result.cost_usd <= spec.max_cost_usd"
- https://github.com/EmadMokhtar/skill-evaluator/blob/1ce02bc689899cf801d4b6fa83c16e26b41be3e5/src/skill_lens/evaluators/budget.py#L17-L20 "`0.0 > max_cost_usd` is always False, so evaluating it anyway would report "within budget" for a limit nobody checked. It becomes a *failing* check carrying the reason -- never a passing one."
- https://github.com/EmadMokhtar/skill-evaluator/blob/1ce02bc689899cf801d4b6fa83c16e26b41be3e5/src/skill_lens/orchestrator.py#L697 "BudgetEvaluator(),"
  - One of the default evaluators, so every case that declares a `budget:` is scored on it.
- https://github.com/EmadMokhtar/skill-evaluator/blob/1ce02bc689899cf801d4b6fa83c16e26b41be3e5/src/skill_lens/gating.py#L82 "min_pass_rate: float = 1.0,"
- https://github.com/EmadMokhtar/skill-evaluator/blob/1ce02bc689899cf801d4b6fa83c16e26b41be3e5/src/skill_lens/gating.py#L129 "short is never a pass, and a ceiling that could not see spend was not"
- https://github.com/EmadMokhtar/skill-evaluator/blob/1ce02bc689899cf801d4b6fa83c16e26b41be3e5/src/skill_lens/gating.py#L197-L198 "passed = not reasons return GateResult(passed=passed, exit_code=EXIT_OK if passed else EXIT_FAILED, reasons=reasons)"
- https://github.com/EmadMokhtar/skill-evaluator/blob/1ce02bc689899cf801d4b6fa83c16e26b41be3e5/src/skill_lens/cli.py#L526 "raise typer.Exit(code=gate.exit_code)"
- https://github.com/EmadMokhtar/skill-evaluator/blob/1ce02bc689899cf801d4b6fa83c16e26b41be3e5/docs/comparative-evals.md#L22-L23 "`previous` — the skill's **prior version**, resolved from git (see below). This isolates what a specific edit changed."
- https://github.com/EmadMokhtar/skill-evaluator/blob/1ce02bc689899cf801d4b6fa83c16e26b41be3e5/src/skill_lens/comparison.py#L92-L93 "Every delta is candidate - baseline. Higher is better for `pass_rate_delta`; negative is better for tokens, cost and latency."
- https://github.com/EmadMokhtar/skill-evaluator/blob/1ce02bc689899cf801d4b6fa83c16e26b41be3e5/src/skill_lens/gating.py#L184-L186 "f"pass-rate delta {delta.pass_rate_delta:+.0%} is below the ""
  - `--min-delta` gates the pass-rate delta only; the token and cost deltas of the same arms are reported, never gated.
- https://github.com/EmadMokhtar/skill-evaluator/blob/1ce02bc689899cf801d4b6fa83c16e26b41be3e5/src/skill_lens/gating.py#L190-L191 "An unresolvable one is: treating it as "no change" would # let a repo pass this gate forever by deleting its git history."

## Issues and changelog
Merged PRs and closed issues carry almost no engagement (at most 3 comments, no reactions), so the four PRs below were chosen for their S32 relevance, not by the reactions or comments sort. `CHANGELOG.md` lines 6, 27 and 33 record PRs 118, 111 and 110.
- https://github.com/EmadMokhtar/skill-evaluator/blob/1ce02bc689899cf801d4b6fa83c16e26b41be3e5/CHANGELOG.md#L6 "stop a run's spending at a ceiling, for every runner (#118)"
  - Broke: no run-wide limit on spend existed. Fixed: the ceiling of PR 118 below.
- https://github.com/EmadMokhtar/skill-evaluator/pull/118 "A provider that reports no token usage sets `usage_note` and `cost_note`, so `max_tokens` fails as not evaluated instead of passing on a zero."
  - Broke: a token or cost limit on a run whose spend was unknown passed on a 0, and nothing stopped a run's total spend. Fixed: `max_tokens` also stops a keyed run while it spends, a run-wide `max_spend_usd` ceiling stops new work items, any item it held back fails the gate, and a runner whose spend can never be priced is refused before any case runs.
- https://github.com/EmadMokhtar/skill-evaluator/pull/110 "was reported as **errored** with `cost_usd: 0.0` and `tokens: 0`. Its trace still carried `total_cost_usd` and `usage`."
  - Broke: a `claude-code` run stopped by `--max-budget-usd` (`subtype: error_max_budget_usd`) dropped its spend, so the totals under-counted exactly the costliest runs (issue 91). Fixed: the errored result keeps tokens, cost and notes from the trace; the verdict stays errored.
- https://github.com/EmadMokhtar/skill-evaluator/pull/111 "`RunReport.pricing_degraded` and the console totals line then read the run as free, although the product ran and may have spent real money."
  - Broke: a run that died before the product reported spend (timeout, cut trace, no `result` event) read as free, and a `result` with no number in `total_cost_usd` let `max_cost_usd` pass on a 0. Fixed: such runs carry "spend unknown" notes, which make a declared limit fail as not evaluated.
- https://github.com/EmadMokhtar/skill-evaluator/pull/114 "`--min-delta` gated on that mixed pass rate, so one runner that improved could carry another that regressed past the bar."
  - Broke: deltas averaged a product runner at about 375,000 tokens a run with a framework runner at about 9,000 (issue 93), describing neither. Fixed: one delta per runner, every runner must meet `--min-delta`, and a runner with no comparable case fails.

## Lessons
- A limit whose figure is unknown fails as not evaluated, never passes on a 0 (S32, S8): `budget.py` lines 15-20, PRs 111 and 118, gating.py line 129. Touches plugin/lib/eval-baseline.mjs:19 (counts runs with no `cost` as `unmeasured`) and plugin/evals/pressure/rebaseline.mjs:18 (prints the count; no cell fails or is held back for it); partial (the kit reports the gap, skill-lens fails on it; agent-skill-eval takes the opposite rule, see its card); low cost, one refusal in `rebaseline` when a spend limit applies.
- A per-case token and cost budget is a default evaluator, and a case over it fails the gate at `min_pass_rate` 1.0 with a non-zero exit (S32, Q24): orchestrator.py line 697, gating.py lines 82 and 197-198, cli.py line 526. Touches plugin/evals/pressure/run-pressure.sh:139 (`--max-budget-usd 1` is a kill switch, not a graded budget), plugin/evals/pressure/grade-pressure.mjs:63 (records `cost` only) and plugin/evals/pressure/baseline.json:3-9 (a cell holds passed, runs, model, claudeVersion and date, no token or cost figure); gap; medium cost (a budget per scenario, a token figure in the grade, a failing cell). It still gates eval cases of a SKILL.md only, never hooks, rules, agents or plugin surfaces, and the author picks each case's budget, so it does not fill S32.
- Quota and score come from the same arms, candidate against the skill's previous git version or an empty skill, but only the pass-rate delta is gated (S32, Q25): comparison.py lines 92-93, comparative-evals.md lines 22-23, gating.py lines 184-186. Touches docs/adr/0009-fact-based-ablation-evals.md:14 (pre-change, post-change and no-plugin arms under a `--max-cost-usd` cap, no quota figure compared between them); partial (skill-lens computes the token and cost delta Q25 needs and stops short of gating it); medium cost, a token delta per arm in the eval baseline plus a rule that a claimed saving needs a non-negative pass-rate delta.
- A baseline that cannot be resolved fails a delta gate instead of reading as "no change" (S8, Q25): gating.py lines 190-191. Touches plugin/lib/eval-baseline.mjs:23 (refuses an empty result set) and plugin/lib/eval-baseline.mjs:29-30 (refuses a pass-rate drop unless the model changed, but a cell with no earlier baseline is accepted unchecked); overlap for the empty run, partial for the missing baseline; low cost.
- A run stopped by its own budget keeps the spend its trace reported, and a run cut before any `result` event says its spend is unknown (S8, Q24): PRs 110 and 111. Touches plugin/evals/pressure/grade-pressure.mjs:63 (`result?.total_cost_usd` is read whatever the result subtype, so a budget stop keeps its cost) and plugin/evals/pressure/run-pressure.sh:139 (`timeout 600` kills before any `result` event, so that run's cost is undefined and lands in `unmeasured`); overlap for the budget stop, partial for the timeout; low cost.
- Deltas and gates are per runner, never averaged across runners whose spend differs by 40 times (S8): PR 114. Touches plugin/evals/pressure/baseline.json (cells keyed by scenario and arm, each with its model); overlap; none.
- Not covered: cache TTL, cached-prefix stability or order, context footprint as a share of the window, progressive disclosure, any artifact other than a SKILL.md eval case (Q1, Q3, Q7-Q10). What `result.tokens` counts (cache reads and writes or not) was not read within the 8-file budget.
