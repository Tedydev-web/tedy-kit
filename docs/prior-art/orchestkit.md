---
name: yonatangross/orchestkit
pinned: https://github.com/yonatangross/orchestkit/tree/22dfd9883087a6574174cec33ffb1e6b11aa6f60
license: MIT
studied: 2026-10-30
channel: github
---

# yonatangross/orchestkit

A supplement of sweep 261021-canon, not reference-labelled: OrchestKit, a Claude Code plugin whose `PreModelSwitch` hook prints one warning line when a mid-session model switch would re-cache a warm context above 100k tokens, and asks before a switch onto the premium tier, studied for S32 technique T3 (no `model:` on a kit skill) because it measures the cost a switch carries, though it acts on the session's own switch at run time, warns without blocking, names only `/model`, the picker and `set_model` as switch sources, and pins `model:` on 40 of its own 116 skills (17 haiku, 21 sonnet, 2 opus, counted with `git grep` at the pin).

## Evidence
- https://github.com/yonatangross/orchestkit/blob/22dfd9883087a6574174cec33ffb1e6b11aa6f60/src/hooks/src/lifecycle/model-switch-consent.ts#L60 "export const WARM_CONTEXT_WARN_TOKENS = 100_000;"
- https://github.com/yonatangross/orchestkit/blob/22dfd9883087a6574174cec33ffb1e6b11aa6f60/src/hooks/src/lifecycle/model-switch-consent.ts#L76 "if (!sw.promptCacheWarm || sw.contextTokens <= WARM_CONTEXT_WARN_TOKENS) {"
- https://github.com/yonatangross/orchestkit/blob/22dfd9883087a6574174cec33ffb1e6b11aa6f60/src/hooks/src/lifecycle/model-switch-consent.ts#L88-L91 "Cheaper: finish this task on ${from}, or hand the next step to a subagent or a fresh session with a short plan."
  - Only a switch up a price tier (haiku < sonnet < opus < fable) gets the "cheaper" claim; down, sideways or unknown gets the hand-off advice alone.
- https://github.com/yonatangross/orchestkit/blob/22dfd9883087a6574174cec33ffb1e6b11aa6f60/src/hooks/src/lifecycle/model-switch-consent.ts#L36 "It never asks or denies."
- https://github.com/yonatangross/orchestkit/blob/22dfd9883087a6574174cec33ffb1e6b11aa6f60/src/hooks/src/lifecycle/model-switch-consent.ts#L39 "async systemMessage on the NEXT turn, after the cache was already paid for."
  - Why the warning sits on the sync `PreModelSwitch` hook, not the async `PostModelSwitch` telemetry hook.
- https://github.com/yonatangross/orchestkit/blob/22dfd9883087a6574174cec33ffb1e6b11aa6f60/src/hooks/src/lifecycle/model-switch-consent.ts#L133 "permissionDecision: 'ask',"
  - The ask applies only to a switch onto the Fable or Mythos tier from below it; `ORK_FABLE_OK=1` skips it.
- https://github.com/yonatangross/orchestkit/blob/22dfd9883087a6574174cec33ffb1e6b11aa6f60/src/hooks/src/lib/session-staleness.ts#L20 "`source` was "command" for `/model`; the binary also names the picker and"
  - The measured payload names no skill or agent source, so this hook is not shown to see a skill's `model:`.
- https://github.com/yonatangross/orchestkit/blob/22dfd9883087a6574174cec33ffb1e6b11aa6f60/plugins/ork/hooks/hooks.json#L1644 ""PreModelSwitch": ["
- https://github.com/yonatangross/orchestkit/blob/22dfd9883087a6574174cec33ffb1e6b11aa6f60/src/hooks/src/__tests__/lifecycle/model-switch-consent.test.ts#L127 "the warning never blocks or asks"
- https://github.com/yonatangross/orchestkit/blob/22dfd9883087a6574174cec33ffb1e6b11aa6f60/src/skills/audit-full/SKILL.md#L11 "model: opus"
  - One of the 40 skills that pin a model in their front matter; `tests/ci/lint.sh` requires `model:` on agents and has no rule against it on skills; other test files that mention model were not opened within the budget.
- https://github.com/yonatangross/orchestkit/blob/22dfd9883087a6574174cec33ffb1e6b11aa6f60/tests/ci/lint.sh#L214-L215 "fail "$agent_name missing 'model:' field""
  - The opposite rule for agents: every agent must pin a model.

## Issues and changelog
The repository has 4,831 closed issues and PRs; searched for `PreModelSwitch`, none carries a reaction, so the two merged PRs below were picked by comments and Q4 relevance (PR 4567 has 6 comments, PR 3792 has 3).
- https://github.com/yonatangross/orchestkit/blob/22dfd9883087a6574174cec33ffb1e6b11aa6f60/CHANGELOG.md#L692 "warn before a model switch re-caches a warm large context"
  - Broke: switches re-cached large warm contexts without telling the operator. Fixed: PR 4567 below.
- https://github.com/yonatangross/orchestkit/pull/4567 "That file recorded 113 switches from 2026-08-29 to 2026-09-29, 102 of them above 100k context, about 592 USD of estimated cache writes (operator machine, one month)."
  - Broke: the `PostModelSwitch` telemetry hook only logged switches, and an async hook's message would arrive after the cache was paid. Fixed: the sync `PreModelSwitch` hook prints one line with the estimated cost and the hand-off advice; 3 of 7 new cases, then 2 of 3 more, failed on the old hook first. A live session showing the line was not verified.
- https://github.com/yonatangross/orchestkit/pull/3792 "Every payload field comes from a stdin-dumping hook on a real 2.1.251 `-p` session (the docs page does not list the events yet)"
  - Broke: the premium tier had a consent gate on agent spawns only; a `/model` switch went through unasked. Fixed: a `PreModelSwitch` ask for a switch onto Fable or Mythos and `PostModelSwitch` telemetry, both read from a measured payload.

## Lessons
- A mid-session switch on a warm large context is a counted cost, 113 switches in one month on one machine, 102 of them above 100k tokens, about 592 USD of estimated cache writes (Q4, S32): PR 4567, model-switch-consent.ts lines 60 and 76. Touches plugin/skills/*/SKILL.md front matter (lines 1-5 or 1-6; no skill sets `model:` at branch head 7585393) and the uncommitted `skillModelErrors` in plugin/lib/canon-checks.mjs (working tree, 2026-10-30); overlap for the rule, the figure is the source's evidence for why a skill must not pin a model; no cost.
- A hook on the switch does not replace a static check on skill front matter (Q4, S32): session-staleness.ts line 20 names `/model`, the picker and `set_model` only, and orchestkit itself pins `model:` on 40 skills and `lint.sh` has no rule against it (audit-full SKILL.md line 11). Neither file shows whether a skill's `model:` fires `PreModelSwitch` or starts a cold cache; that is not observed here. Touches the same `skillModelErrors` check; overlap; none beyond the check under way.
- Warn at the switch, synchronously, with the cost and the hand-off (Q4): model-switch-consent.ts lines 36, 39 and 88-91, test line 127. Touches plugin/hooks/hooks.json (registers PreToolUse, PostToolUse, SessionStart and Stop; no PreModelSwitch); gap; medium cost, a new hook whose output also falls under T2's output cap, and it governs the user's own `/model` use, which the quota registry keeps as session practice outside S32.
- Not covered: effort changes, opusplan plan-mode toggles, subagent `model:` cost, any static check of skill or agent model against the session model (Q4, Q20). The hook warns only, and asks only for the premium tier.
