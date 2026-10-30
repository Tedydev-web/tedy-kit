---
name: tardigrde/agent-skill-eval
pinned: https://github.com/tardigrde/agent-skill-eval/tree/59de161f657b82bfaf8f6abe83dfff38552deb21
license: MIT
studied: 2026-10-30
channel: github
---

# tardigrde/agent-skill-eval

A supplement of sweep 261021-canon, not reference-labelled: a harness that runs a skill's `evals.json` cases through claude-code, codex or opencode and grades each run, studied for S32 because a case over its token, non-cached-input or cost limit gets a failed `budget` assertion and the only budget seen that touches prompt caching, though it gates SKILL.md eval cases only, takes one set of `--max-*-per-case` flags per invocation that the author chooses, exits non-zero only when the caller opts in (`--fail-on-assertions` defaults to False, or `--min-pass-rate`), and reads no cache TTL, cached-prefix order or context share of the window.

## Evidence
- https://github.com/tardigrde/agent-skill-eval/blob/59de161f657b82bfaf8f6abe83dfff38552deb21/README.md#L21 "**Budget guards**: per-case token/cost/duration limits with `warn`, `fail`, or `stop-suite` actions, so a runaway recovery loop can't silently burn quota"
- https://github.com/tardigrde/agent-skill-eval/blob/59de161f657b82bfaf8f6abe83dfff38552deb21/src/agent_skill_eval/models.py#L226-L229 "Any limit left at None is not enforced. ``action`` decides what a violation does: "warn" only prints, "fail" appends a failed ``budget`` assertion to the run's grading, "stop-suite" additionally skips all runs that have not started yet."
- https://github.com/tardigrde/agent-skill-eval/blob/59de161f657b82bfaf8f6abe83dfff38552deb21/src/agent_skill_eval/models.py#L239 "action: Literal["warn", "fail", "stop-suite"] = "fail""
- https://github.com/tardigrde/agent-skill-eval/blob/59de161f657b82bfaf8f6abe83dfff38552deb21/src/agent_skill_eval/models.py#L263-L270 "and timing.non_cached_input_tokens > self.max_non_cached_input_tokens"
- https://github.com/tardigrde/agent-skill-eval/blob/59de161f657b82bfaf8f6abe83dfff38552deb21/src/agent_skill_eval/models.py#L261-L262 "A None is "unavailable", and failing a run over an unknown quantity # would punish agents for exposing less telemetry."
- https://github.com/tardigrde/agent-skill-eval/blob/59de161f657b82bfaf8f6abe83dfff38552deb21/src/agent_skill_eval/models.py#L217 "enforcement is post-run, mid-run kills remain"
- https://github.com/tardigrde/agent-skill-eval/blob/59de161f657b82bfaf8f6abe83dfff38552deb21/src/agent_skill_eval/runner.py#L662-L671 "text="The run stayed within its budget", passed=False, evidence="budget exceeded: " + "; ".join(violations), method="budget","
- https://github.com/tardigrde/agent-skill-eval/blob/59de161f657b82bfaf8f6abe83dfff38552deb21/src/agent_skill_eval/cli.py#L609-L611 "False, "--fail-on-assertions/--no-fail-on-assertions", help="Exit non-zero when any completed run has failed assertions","
- https://github.com/tardigrde/agent-skill-eval/blob/59de161f657b82bfaf8f6abe83dfff38552deb21/src/agent_skill_eval/cli.py#L1011-L1014 "if fail_on_assertions and aggregate["suites_failed_grading"]: raise typer.Exit(1) if aggregate["suites_below_min_pass_rate"]: raise typer.Exit(1)"
- https://github.com/tardigrde/agent-skill-eval/blob/59de161f657b82bfaf8f6abe83dfff38552deb21/src/agent_skill_eval/harnesses/__init__.py#L330-L332 "timing.cached_tokens = usage.get("cache_read_input_tokens", 0) timing.cache_creation_tokens = usage.get("cache_creation_input_tokens", 0)"
- https://github.com/tardigrde/agent-skill-eval/blob/59de161f657b82bfaf8f6abe83dfff38552deb21/src/agent_skill_eval/harnesses/__init__.py#L335 "timing.total_tokens = timing.input_tokens + timing.output_tokens"
- https://github.com/tardigrde/agent-skill-eval/blob/59de161f657b82bfaf8f6abe83dfff38552deb21/src/agent_skill_eval/harnesses/__init__.py#L374-L376 "# Anthropic usage reports input_tokens EXCLUDING cache reads. return timing.input_tokens"
  - For claude-code, non-cached input and total tokens are both built from `input_tokens`, which leave out cache reads and cache writes.
- https://github.com/tardigrde/agent-skill-eval/blob/59de161f657b82bfaf8f6abe83dfff38552deb21/src/agent_skill_eval/models.py#L198-L199 "unavailable cost must # not be confused with a real $0.00 run."
- https://github.com/tardigrde/agent-skill-eval/blob/59de161f657b82bfaf8f6abe83dfff38552deb21/CHANGELOG.md#L65-L66 "cached / max(input, cached) showed a bogus 100% for claude-code/opencode."

## Issues and changelog
The repository has no closed issues. Its 14 merged PRs carry at most one comment and one reaction each, so the three below were chosen for their S32 relevance, not by that sort. The changelog (`CHANGELOG.md`, generated per release) records the same fixes.
- https://github.com/tardigrde/agent-skill-eval/pull/13 "Limits on values an agent didn't report (cost, reasoning, non-cached input) are skipped, never failed"
  - Broke: on a live commit, push and merge-request skill, full suites cost 12 to 20 minutes and 1 to 2M reported input tokens per iteration, and a case could finish inside the timeout yet cost far too much. Fixed: per-case budget flags with `warn`, `fail` and `stop-suite`, `--eval-id` to run single cases, and `cost_usd: null` for unknown cost instead of 0.
- https://github.com/tardigrde/agent-skill-eval/pull/14 "so `non_cached_input_tokens` clamped to a bogus 0 and `cached_pct` capped at 100% for opencode."
  - Broke: the harness assumed codex's convention (input includes cache reads) for opencode, so its billable input read 0 and its cached share 100%. Fixed: opencode takes claude-code's split, and `cached_pct` divides by non-cached plus cached input (CHANGELOG lines 65-66).
- https://github.com/tardigrde/agent-skill-eval/pull/12 "The claude CLI prices runs at Anthropic list prices regardless of endpoint; `cost_usd` was wrong whenever claude-code was routed through OpenRouter."
  - Broke: cost through a gateway was the CLI's list-price estimate, not the bill. Fixed: cost recomputed from token counts and the gateway's published rates, `cost_usd_source` and `cost_usd_cli` kept on each run, and cache-creation tokens captured so cache writes are priced.

## Lessons
- A case over any declared token, non-cached-input or cost limit gets a failed `budget` assertion by default, but the process exits non-zero only under `--fail-on-assertions` (default False) or `--min-pass-rate` (S32, Q24): models.py line 239, runner.py lines 662-671, cli.py lines 609-611 and 1011-1014. Touches plugin/evals/pressure/run-pressure.sh:139 (`--max-budget-usd 1` stops the run, no budget is graded) and plugin/evals/pressure/baseline.json:3-9 (no token or cost figure per cell); gap; medium cost. It gates eval cases of a SKILL.md only, with one budget per invocation the author picks, so it does not fill S32; a kit check would have to fail by default.
- A limit whose figure the agent did not report is skipped, not failed (S8, S32): models.py lines 261-262, PR 13. Touches plugin/lib/eval-baseline.mjs:19 (`unmeasured` runs counted and printed by plugin/evals/pressure/rebaseline.mjs:18); overlap (both let an unknown figure through; skill-lens fails it instead, see its card); the kit has to pick a side before it adds a spend limit.
- A non-cached-input limit is the only budget found that touches prompt caching, and on claude-code it cannot see a broken prefix (Q1, Q3): DERIVED from harnesses/__init__.py lines 330-335 and 374-376, which build both the non-cached and the total figure from `input_tokens` and keep cache reads and writes in separate fields; assuming a broken cached prefix shows up as cache-creation tokens rather than plain `input_tokens`, only `max_cost_usd`, read from `total_cost_usd`, moves when it breaks. Touches the quota study's cache rows Q1 and Q3 (no kit file reads cache usage); gap; low cost to read `cache_creation_input_tokens` from the same `result` event plugin/evals/pressure/grade-pressure.mjs:63 already reads.
- A cache share needs one denominator valid for every CLI's token convention, pinned by a test, or it reads 100% (Q24): PR 14, CHANGELOG lines 65-66. Touches plugin/evals/pressure/grade-pressure.mjs:63 (no cache share recorded); gap; low cost.
- Each cost figure names its source, and a list-price estimate through a gateway is kept apart from a reconciled one (Q2, Q24): PR 12, models.py lines 198-199. Touches docs/prior-art/problems-quota.md:13 (the quota proxy is list price by decision); overlap by design; none.
- Not covered: cache TTL, cached-prefix order, context footprint as a share of the window, progressive disclosure, any artifact other than a SKILL.md eval case (Q7-Q10).
