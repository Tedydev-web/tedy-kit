---
name: lloydjf/ratchet
pinned: https://github.com/lloydjf/ratchet/tree/350a343f4d3e02df53d53f55697db788d87679cb
license: Apache-2.0
studied: 2026-10-28
channel: github
---

# lloydjf/ratchet

A supplement of sweep 261021-canon, not reference-labelled: a regression checker that replays an agent's recorded golden runs after each edit to its own skills, studied because it pins the model tier and harness a golden was recorded on and writes a measured reversal trigger into its decision records (S30, S31, partial).

## Evidence
- https://github.com/lloydjf/ratchet/blob/350a343f4d3e02df53d53f55697db788d87679cb/docs/adr/0003-hold-the-agents-model-tier-constant-across-replay.md#L9 "Replays run on the golden's agent tier; the proxy refuses a mismatch with 409 tier_mismatch."
- https://github.com/lloydjf/ratchet/blob/350a343f4d3e02df53d53f55697db788d87679cb/ratchet/proxy/policy.py#L53 "if purpose == "agent" and meta is not None and tier != meta.agent_tier:"
- https://github.com/lloydjf/ratchet/blob/350a343f4d3e02df53d53f55697db788d87679cb/ratchet/config/settings.py#L55 "Override the super model id."
- https://github.com/lloydjf/ratchet/blob/350a343f4d3e02df53d53f55697db788d87679cb/ratchet/orchestrator/replaying.py#L5-L6 "goldens are grouped by (agent tier, harness) so a replay never runs on a different tier or adapter than its golden (ADR 0003, ``harness_mismatch``)"
- https://github.com/lloydjf/ratchet/blob/350a343f4d3e02df53d53f55697db788d87679cb/ratchet/models.py#L129-L130 "harness_version: str # "<adapter>/<version>", e.g. "minimal/0.1.0" skills_commit: str # commit on main the golden ran against"
- https://github.com/lloydjf/ratchet/blob/350a343f4d3e02df53d53f55697db788d87679cb/ratchet/orchestrator/bless.py#L241 "archived = golden.model_copy(update={"archived_reason": "drift"})"
- https://github.com/lloydjf/ratchet/blob/350a343f4d3e02df53d53f55697db788d87679cb/docs/adr/0020-ultra-confirms-cascade-blocks.md#L23-L24 "Reversal trigger Bench E4 shows Ultra confirmation adds cost without changing any decision on the 600 cases."
- https://github.com/lloydjf/ratchet/blob/350a343f4d3e02df53d53f55697db788d87679cb/docs/adr/0023-control-replays.md#L57-L58 "Bench E6 with and without controls (`noise` vs `controls_off` on the same replays) shows no change in false blocks, or E1 recall drops"
- https://github.com/lloydjf/ratchet/blob/350a343f4d3e02df53d53f55697db788d87679cb/docs/adr/0006-level-0-deterministic-check-before-any-model.md#L14-L15 "Reversal trigger —"
- https://github.com/lloydjf/ratchet/blob/350a343f4d3e02df53d53f55697db788d87679cb/docs/adr/0024-nano-shortcut-gate.md#L22-L23 "The Nano screen may not clear a pair alone when Level 0 found **any** structural difference"
- https://github.com/lloydjf/ratchet/blob/350a343f4d3e02df53d53f55697db788d87679cb/ratchet/proxy/policy.py#L4-L6 "a call is refused once the daily cap, its purpose's daily cap or the bench hard cap has been reached (429 ``budget_exceeded``)."

## Issues and changelog
- https://github.com/lloydjf/ratchet/blob/350a343f4d3e02df53d53f55697db788d87679cb/CHANGELOG.md#L94 "Token Factory does not honor `seed`, so replays of an unchanged skill still vary."
  - Broke: replays of an unchanged skill diverged, so cosmetic edits were held as regressions (7 of 8 held in the 0.1.0 bench, CHANGELOG L80-81). Fixed: control replays of the unchanged skill (ADR 0023), amended the same day when the measured E6 run showed the first rule still held 8 of 8 unchanged-skill edits.

## Lessons
- Evidence is bound to the model it was measured on, and a run on another model is refused rather than compared (S30): the proxy refuses an agent call whose tier differs from the golden's recorded `agent_tier`. Partial: the record holds the tier (nano, super, ultra), not the model id, and `settings.py` lets the model behind a tier change with nothing marked stale; the kit should key on the model id. Touches docs/adr/0010-dev-red-step-and-honest-green.md (model rows) and plugin/lib/sweep-record.mjs; gap (eval results are not refused or marked stale when the model differs); low cost, store the model id with each result and refuse a comparison across ids.
- Each baseline records the harness version and the skills commit it ran against, and replays are grouped so none runs on a different harness (S16, S1): `EnvSnapshot.harness_version`, `skills_commit` and the `harness_mismatch` refusal. Touches plugin/evals/probes/run-probes.sh and plugin/evals/probes/claude-code-inventory.py; partial (the kit records the Claude Code version in the inventory, not with each eval result); low cost.
- A decision record carries a reversal trigger, and the good ones are a measurable bench condition (S31, S20): ADR 0020 is reversed if Bench E4 shows the rule changes no decision on 600 cases, ADR 0023 if E6 shows no change in false blocks. Partial: several ADRs leave the trigger as `—` and nothing checks or re-runs it. Touches docs/adr/ and `checkMeasuredAdrs` in plugin/lib/sweep-record.mjs:67; gap (kit ADRs and rules state no removal condition); low cost, one `Reversal trigger:` line per ADR and rule, required non-empty for model-gap rules.
- A rule changed after a measured run says so in the same record and keeps the old rule (S3, S10): ADR 0023's amendment and ADR 0024's "rejected alternative, measured on the same sweep". Touches docs/adr/0009-fact-based-ablation-evals.md; overlap; none.
- A changed baseline is archived with a reason, never overwritten (S2): re-blessing a drifted golden stores the old one with `archived_reason="drift"`. Touches plugin/lib/prior-art.mjs (GRANDFATHERED set holds names only); partial; low cost.
- Every model call is logged with tier, purpose, tokens and cost, and caps refuse calls once reached (S24): `policy.py` daily, per-purpose and bench caps. Touches the per-call spend ledger of the canon sweep; overlap for the log; the kit applies a cap only when the user sets one, ratchet configures them by default; none.
