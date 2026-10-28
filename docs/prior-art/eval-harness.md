---
name: nano-step/eval-harness
pinned: https://github.com/nano-step/eval-harness/tree/002aafee3ed60ab6cde5acda8cdb49f70e2ca2c5
license: MIT
studied: 2026-10-28
channel: github
---

# nano-step/eval-harness

A shell eval harness for agent skills with baselines, A/B runs and an LLM judge. Studied for the canon (sweep `261021-canon`, pass 2): it checks its own checks (judge calibration, a planted-regression meta-eval), refuses to rebaseline across a model change without an audited override, and keeps unknown cost apart from zero.

## Evidence
- https://github.com/nano-step/eval-harness/blob/002aafee3ed60ab6cde5acda8cdb49f70e2ca2c5/scripts/eval/calibrate.sh#L4 "system prompt as score_llm_judge (judge_system_prompt) — calibration must measure the real"
- https://github.com/nano-step/eval-harness/blob/002aafee3ed60ab6cde5acda8cdb49f70e2ca2c5/scripts/eval/calibrate.sh#L28 "Report readiness (kappa >= EVAL_CALIBRATION_MIN_KAPPA, default 0.6); never hard-exits."
- https://github.com/nano-step/eval-harness/blob/002aafee3ed60ab6cde5acda8cdb49f70e2ca2c5/scripts/eval/metaeval.sh#L3-L4 "KNOWN regressions and benign edits (stub opencode, fully offline) and measures the harness's # OWN false-positive rate, false-negative rate, and attribution accuracy."
- https://github.com/nano-step/eval-harness/blob/002aafee3ed60ab6cde5acda8cdb49f70e2ca2c5/scripts/eval/rebaseline.sh#L4 "case that flipped PASS->FAIL — so a model upgrade cannot silently launder a regression."
- https://github.com/nano-step/eval-harness/blob/002aafee3ed60ab6cde5acda8cdb49f70e2ca2c5/scripts/eval/rebaseline.sh#L58 "rebaseline refuses PASS-to-FAIL changes without --accept-model-change"
- https://github.com/nano-step/eval-harness/blob/002aafee3ed60ab6cde5acda8cdb49f70e2ca2c5/scripts/eval/lib/attribute.sh#L27 "'^(model_id|opencode_version|langgraph_version)$' && classes+=("MODEL_CHANGED")"
- https://github.com/nano-step/eval-harness/blob/002aafee3ed60ab6cde5acda8cdb49f70e2ca2c5/scripts/eval/lib/manifest.sh#L3 "env-manifest per run with opencode version, model, skill bundle sha,"
- https://github.com/nano-step/eval-harness/blob/002aafee3ed60ab6cde5acda8cdb49f70e2ca2c5/scripts/eval/ab.sh#L6 "regressions (base PASS, candidate FAIL) and exits 12 if any exist."
- https://github.com/nano-step/eval-harness/blob/002aafee3ed60ab6cde5acda8cdb49f70e2ca2c5/scripts/eval/lib/budget.sh#L19 "Sum measured cost_usd only; unavailable entries never masquerade as zero spend."
- https://github.com/nano-step/eval-harness/blob/002aafee3ed60ab6cde5acda8cdb49f70e2ca2c5/scripts/eval/lib/budget.sh#L58 "No-op (return 0) when EVAL_BUDGET_USD is unset/empty."
- https://github.com/nano-step/eval-harness/blob/002aafee3ed60ab6cde5acda8cdb49f70e2ca2c5/scripts/eval/lib/safe_shell.py#L57 "only jq, printf, and wc -l are supported"
- https://github.com/nano-step/eval-harness/blob/002aafee3ed60ab6cde5acda8cdb49f70e2ca2c5/docs/JANUS_BENCHMARK.md#L43 "No-go for a Janus execution adapter or a claim that Janus is ready as an eval runner."

## Issues and changelog
- https://github.com/nano-step/eval-harness/issues/8 "A typo like `expected_regex:` (instead of `expect_regex:`) silently fails the check with no warning."
  - Broke: a shell check with no `expect_*` key could never pass, so a YAML typo read as an ordinary skill FAIL. Fixed: PR 38 returns `error: true` with a misconfiguration hint and adds a regression test.
- https://github.com/nano-step/eval-harness/blob/002aafee3ed60ab6cde5acda8cdb49f70e2ca2c5/CHANGELOG.md#L25 "Rebaseline refuses missing, pending, or unavailable evidence; model-change override is explicit."
- https://github.com/nano-step/eval-harness/blob/002aafee3ed60ab6cde5acda8cdb49f70e2ca2c5/CHANGELOG.md#L27 "Unknown token/cost usage is null/unavailable, never zero."

## Lessons
- A model change is detected from the run manifest and a rebaseline that turns a PASS into a FAIL is refused unless an explicit override writes an audit event (S30): `attribute.sh` flags `MODEL_CHANGED` from the stored manifest diff, `rebaseline.sh` exits 12. Touches docs/adr/0010-dev-red-step-and-honest-green.md:20 and plugin/evals/results (model named per row, nothing marks a result stale); gap; low cost, store the model id per result and refuse to compare across ids.
- A grader is measured before its verdicts are trusted: an LLM judge against a human-labelled gold set with the real system prompt and a kappa floor, and the whole harness against a planted-regression corpus that reports its own false-positive and false-negative rates (S8). Touches plugin/tests/sweep-record.test.mjs and the `red-before-source` grader of ADR 0010 (negative cases per check); partial, the kit has no corpus that measures its graders' false-pass rate as a number; medium cost.
- A check that cannot pass is a harness error, not a skill FAIL (S8, S9): issue 8. Touches plugin/tests/skill-contracts.test.mjs (fact-only graders); gap for eval cases with a missing expectation; low cost.
- Each run records an environment manifest, and missing evidence yields INDETERMINATE or ERROR instead of a score (S9). Touches docs/adr/0010-dev-red-step-and-honest-green.md:20 (grants and void batches written by hand); partial, no per-run manifest file; low cost.
- A candidate is compared with a base arm on the same cases and any per-case regression fails the run (S10): `ab.sh` exits 12. Touches docs/adr/0009-fact-based-ablation-evals.md:14 and `checkMeasuredAdrs` in plugin/lib/sweep-record.mjs:67; overlap, and the kit also requires a no-plugin arm; none.
- Unknown spend stays null, never zero, and a budget gate applies only when the user sets one (S24). Touches docs/adr/0009-fact-based-ablation-evals.md:14 (user-approved cap) and the per-call spend ledger of the canon sweep; overlap for the optional cap, partial for null-versus-zero; low cost.
- Commands in eval checks run in a shell-free argv runner limited to jq, printf and `wc -l` inside the workdir, and anything else needs an explicit `unsafe_shell: true` (S26). Touches plugin/scripts/git-gate.mjs; partial, the kit gates agent shell commands, not grader commands, which are JavaScript; low value.
- A rejected adoption is recorded with its benchmark evidence and the conditions to revisit (S20): the Janus no-go. Touches docs/adr/0007-considered-and-rejected.md; overlap; none.
