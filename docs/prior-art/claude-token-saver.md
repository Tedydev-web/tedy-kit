---
name: dbrownjave/claude-token-saver
pinned: https://github.com/dbrownjave/claude-token-saver/tree/437ba691a47b3f206a5783fe4bfe13a2f64c18ef
license: MIT
studied: 2026-10-30
channel: github
---

# dbrownjave/claude-token-saver

A supplement of sweep 261021-canon, not reference-labelled: token-saver, a Claude Code mod and hook set whose model-switch guard answers `PreModelSwitch` with a priced dialog (Switch, One message, Stay) and denies a warm-cache switch of 20k tokens or more unless the user picks Switch, studied for S32 technique T3 (no `model:` on a kit skill) because it is the strictest runtime form of Q4, though it guards the main session's own switch only, waves through subagent and SDK switches, ships its plain-hook form `cache-guard` off by default, and checks no skill or agent front matter.

## Evidence
- https://github.com/dbrownjave/claude-token-saver/blob/437ba691a47b3f206a5783fe4bfe13a2f64c18ef/plugins/token-saver/hooks/register.js#L3048 "Model-switch guard. The engine's own "Switch model?" dialog has no number in it; this event has them all"
- https://github.com/dbrownjave/claude-token-saver/blob/437ba691a47b3f206a5783fe4bfe13a2f64c18ef/plugins/token-saver/hooks/register.js#L19 "const SWITCH_CHEAP = 20_000"
- https://github.com/dbrownjave/claude-token-saver/blob/437ba691a47b3f206a5783fe4bfe13a2f64c18ef/plugins/token-saver/hooks/register.js#L3062-L3063 "The cache is cold, so the next message re-reads ${fmt(used)} tokens either way."
  - A switch on a cold cache passes as free; a warm one under 20k tokens passes with a toast.
- https://github.com/dbrownjave/claude-token-saver/blob/437ba691a47b3f206a5783fe4bfe13a2f64c18ef/plugins/token-saver/hooks/register.js#L3079 "let choice = 'Stay'"
  - The default answer, and the answer when the dialog throws, is Stay.
- https://github.com/dbrownjave/claude-token-saver/blob/437ba691a47b3f206a5783fe4bfe13a2f64c18ef/plugins/token-saver/hooks/register.js#L3096 "return { permissionDecision: 'deny', permissionDecisionReason: `token-saver: stayed on ${from}. Switching would re-cache ${fmt(used)} tokens${cost ? ` (${cost})` : ''}` }"
- https://github.com/dbrownjave/claude-token-saver/blob/437ba691a47b3f206a5783fe4bfe13a2f64c18ef/plugins/token-saver/hooks/register.js#L3092 "the session stays on ${from} so its cache stays warm"
  - "One message" denies the switch and sends only the next main-thread turn to the other model, booked as one cold read.
- https://github.com/dbrownjave/claude-token-saver/blob/437ba691a47b3f206a5783fe4bfe13a2f64c18ef/plugins/token-saver/hooks/register.js#L3058 "if (!modelGuard || e.agent_id || e.source === 'sdk' || !e.to_model || e.to_model === e.from_model) return next(e)"
  - The source's own framing at line 3054: subagents and headless switches are never questioned.
- https://github.com/dbrownjave/claude-token-saver/blob/437ba691a47b3f206a5783fe4bfe13a2f64c18ef/plugins/token-saver/hooks/register.js#L2569 "const modelGuard = options.modelGuard !== false"
- https://github.com/dbrownjave/claude-token-saver/blob/437ba691a47b3f206a5783fe4bfe13a2f64c18ef/README.md#L123 "### Model-switch guard (mod only)"
- https://github.com/dbrownjave/claude-token-saver/blob/437ba691a47b3f206a5783fe4bfe13a2f64c18ef/modules.json#L63-L68 ""default": false,"
  - The `cache-guard` hook module for plain Claude Code (no mod) is opt-in.
- https://github.com/dbrownjave/claude-token-saver/blob/437ba691a47b3f206a5783fe4bfe13a2f64c18ef/.claude/hooks/pre_model_switch.py#L27-L30 "if not warm or tokens < ASK_AFTER_TOKENS:"
  - The plain hook asks (never denies) on a warm cache of 20k tokens or more, skips `auto` and `resume` sources, and fails open on bad input.

## Issues and changelog
No closed issues and one merged PR, not about model switches; no changelog file. The guard arrived in commit 85e8fd9 ("token-saver 0.3.24: a priced dialog before a model switch"), outside the issue and PR record.

## Lessons
- Default to keeping the model and make the switch the deliberate choice, with the price shown (Q4, S32): register.js lines 3048, 3079 and 3096. Touches plugin/skills/*/SKILL.md front matter (no skill sets `model:` at branch head 7585393) and the uncommitted `skillModelErrors` in plugin/lib/canon-checks.mjs (working tree, 2026-10-30); overlap, the kit's static form is stricter for kit skills (no switch to deny); no cost.
- A cold cache makes a switch free and a small warm one cheap, so a fair rule exempts them (Q4): register.js lines 19 and 3062-3063. A static skill check has no cache state to read, so this applies only to a kit `PreModelSwitch` hook, and plugin/hooks/hooks.json registers none (PreToolUse, PostToolUse, SessionStart, Stop); gap; medium cost, a new hook under T2's output cap that governs the user's own `/model` use, which the registry keeps as session practice outside S32.
- Subagent and SDK switches pass unexamined, so a model pinned on a spawned agent is outside this guard (Q4, Q20): register.js line 3058. Touches plugin/agents/reviewer.md:1-5 (pins no model) only through T6; gap in the source, not the kit; none.
- Not covered: skill or agent front matter, effort changes, any check that runs without a live session. The mod form needs the mod runtime, the plain hook is off by default and only asks.
