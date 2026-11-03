---
name: ryanthedev/code-foundations
pinned: https://github.com/ryanthedev/code-foundations/tree/ca30ba90ebd3b44017365ad4d91938dd675808f9
license: NOASSERTION
studied: 2026-10-30
channel: github
domains: ai-models, evals, cost
use-when: you pick the cheapest model per task from measured pass rates
---

# ryanthedev/code-foundations

A supplement of sweep 261021-canon, not reference-labelled: a Claude Code plugin of software-engineering skills with a plan and build workflow, studied for S32 (technique T6) because it is the only source found where a measured floor, the cheapest of four models passing at least 4 of 5 runs per task, sits behind a role's model pin (`REVIEW always runs on sonnet` in `commands/build.md`), though the pin is command text with no test, its stated reason does not match the pre-registered verdict, and the floor rule itself picks fable, not sonnet, on one of the two review tasks; the tree has no LICENSE file, while README line 196 and `.claude-plugin/plugin.json` line 8 say MIT and the GitHub API reports no license, so the card records NOASSERTION.

## Evidence
- https://github.com/ryanthedev/code-foundations/blob/ca30ba90ebd3b44017365ad4d91938dd675808f9/benchmarks/model-tiers/REPORT.md#L92 "Floor rule: per task, floor(task) = cheapest ladder model with pass rate ≥4/5 at n=5."
- https://github.com/ryanthedev/code-foundations/blob/ca30ba90ebd3b44017365ad4d91938dd675808f9/benchmarks/model-tiers/analyze.py#L116-L117 "FLOOR_LADDER_ORDER = ("haiku-4.5", "sonnet-5", "opus-4.8", "fable-5") # cheapest -> priciest FLOOR_PASS_THRESHOLD = 4 # of 5 runs -- rule 1's exact bar"
- https://github.com/ryanthedev/code-foundations/blob/ca30ba90ebd3b44017365ad4d91938dd675808f9/benchmarks/model-tiers/analyze.py#L442-L446 "for model in ladder: info = per_model.get(model) if info and info["pass_count"] >= pass_threshold: floor_model = model break"
  - The loop checks the pass count only, not that `n` is 5.
- https://github.com/ryanthedev/code-foundations/blob/ca30ba90ebd3b44017365ad4d91938dd675808f9/benchmarks/model-tiers/REPORT.md#L101 "| 04-hash-progress-review | 4 | fable-5=3/3, haiku-4.5=2/5, opus-4.8=5/5, sonnet-5=4/5 | sonnet-5 |"
- https://github.com/ryanthedev/code-foundations/blob/ca30ba90ebd3b44017365ad4d91938dd675808f9/benchmarks/model-tiers/REPORT.md#L102 "| 04-loop-core-review | 4 | fable-5=4/5, haiku-4.5=0/5, opus-4.8=3/5, sonnet-5=2/5 | fable-5 |"
  - The two rung-4 review tasks: the floor is sonnet on one and fable on the other.
- https://github.com/ryanthedev/code-foundations/blob/ca30ba90ebd3b44017365ad4d91938dd675808f9/benchmarks/model-tiers/REPORT.md#L22 "operationalized at n=5 as: a violation the lower tier found in 0 of 5 runs that the higher tier found in ≥3 of 5."
- https://github.com/ryanthedev/code-foundations/blob/ca30ba90ebd3b44017365ad4d91938dd675808f9/benchmarks/model-tiers/REPORT.md#L140-L145 "**Verdict: `no-difference→cheaper`** Rule inputs: - n_tasks (surviving): 2 - rule's designed n_runs: 5 - qualifying capability gaps found: 0"
  - The pre-registered haiku-against-sonnet REVIEW comparison (rule 4, line 138) found no capability gap and so favours the cheaper tier.
- https://github.com/ryanthedev/code-foundations/blob/ca30ba90ebd3b44017365ad4d91938dd675808f9/benchmarks/model-tiers/REPORT.md#L147 "A model that catches some-but-not-all defects on a run scores as a miss for this rule, which can only *under*-count qualifying gaps"
- https://github.com/ryanthedev/code-foundations/blob/ca30ba90ebd3b44017365ad4d91938dd675808f9/benchmarks/model-tiers/REPORT.md#L35 "effort was pinned at medium throughout (no sweep)."
  - Round 1 calibration only; round 2 adds a three-run effort sweep on two tasks, descriptive only (line 151).
- https://github.com/ryanthedev/code-foundations/blob/ca30ba90ebd3b44017365ad4d91938dd675808f9/benchmarks/model-tiers/REPORT.md#L366 "Cumulative reported cost: **$172.56** (tripwire: $250.00)."
- https://github.com/ryanthedev/code-foundations/blob/ca30ba90ebd3b44017365ad4d91938dd675808f9/benchmarks/model-tiers/REPORT.md#L376-L377 "some subject-model session during the sweep wrote its fix directly into the shared task `starter/` files rather than an isolated per-run workspace copy."
- https://github.com/ryanthedev/code-foundations/blob/ca30ba90ebd3b44017365ad4d91938dd675808f9/commands/build.md#L60 "**REVIEW always runs on sonnet** — never haiku, whose planted-defect recall proved unreliable on review-shaped tasks."
  - The commit that wrote this sentence (2026-10-10, v6.6.0) gives too many serial blocking reviews as its reason ("That is too much") and moves every REVIEW to sonnet; it cites no benchmark.
- https://github.com/ryanthedev/code-foundations/blob/ca30ba90ebd3b44017365ad4d91938dd675808f9/agents/post-gate-agent.md#L1-L4 "name: post-gate-agent"
  - The reviewer agent's front matter has no `model:` or `effort:`; the model is chosen in command text at dispatch.

## Issues and changelog
The repository has no closed issues and no changelog. Its five merged PRs carry no comments or reactions, so the one below was chosen for its Q20 relevance.
- https://github.com/ryanthedev/code-foundations/pull/7 "Sonnet is the default to prevent Opus propagation to mechanical subagent work."
  - Broke: phases without a model inherited the session's Opus for mechanical subagent work. Fixed: every plan phase must carry a `**Model:**` field, sonnet by default.

## Lessons
- A role's model is set from a pre-registered floor rule over a model ladder at n=5, with ties going to the cheaper model (Q20, S32): REPORT.md lines 92 and 8, analyze.py lines 116-117. Touches plugin/agents/reviewer.md:1-5 (no `model:` or `effort:`) and plugin/skills/review-pr/SKILL.md:33 (three reviewer spawns, no model named); gap; one front-matter line plus the T6 parity run (USD 9-12 per model tried, n=5 on two review scenarios).
- The pin and its measurement drift apart when nothing links them (Q20): build.md line 60 cites haiku's recall, the round-2 verdict at REPORT.md lines 140-145 favours the cheaper tier under its own bar, the floor rule gives fable on one review task (line 102), and the commit names review load. Touches plugin/agents/reviewer.md:1-5; gap; low cost for a static test that the pinned `model:` equals the floor recorded in a committed results file with its date and Claude Code version, as plugin/evals/pressure/baseline.json:6-8 already keeps per cell.
- Score review recall per planted defect, not per run, or the comparison is biased toward the cheaper tier (Q20): REPORT.md line 147. Touches plugin/evals/pressure/grade-pressure.mjs (one pass or fail per run); partial; medium cost, needs planted-defect review scenarios the kit does not have.
- Run each eval in an isolated copy of its fixture (Q25): REPORT.md lines 376-377. Touches plugin/evals/pressure/run-pressure.sh:139 (each run already works in its own `$dir/work`); overlap; none.
- Effort was not part of the floor: the sweep is descriptive and three runs per cell (REPORT.md lines 35 and 151), so it does not show effort parity (Q20). Touches plugin/agents/reviewer.md:1-5 (no `effort:`); gap; the parity run would need an effort arm too.
- Limits: four models on ten tasks of the author's own projects, only two of them review-shaped, n=5; two tasks carry the integrity caveat at lines 368-407; the kit draws 3 runs per cell (plugin/evals/pressure/run-pressure.sh:6), below this n=5; no license file, so studied, not copied.
