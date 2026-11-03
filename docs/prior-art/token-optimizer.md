---
name: alexgreensh/token-optimizer
pinned: https://github.com/alexgreensh/token-optimizer/tree/734da4eb1e96e10f93c0a93cd1dfecfeae93713d
license: NOASSERTION
studied: 2026-10-30
channel: github
domains: cost
use-when: you measure a session's context use and cost and act on it through hooks
---

# alexgreensh/token-optimizer

A supplement of sweep 261021-canon, not reference-labelled: token-optimizer, a plugin and Python CLI that measures a Claude Code session's context use and cost and acts on it through hooks, licensed PolyForm Noncommercial 1.0.0 with a custom small-business permission (`LICENSE`, `LICENSE-SMALL-BUSINESS.md`; `package.json` says `PolyForm-Noncommercial-1.0.0`), so it is studied, never copied, and excerpts stay short. Studied for S32 (T2 hook output, Q10; also Q1) because a CI pytest fails if its fresh-session nudge repeats within a session, its UserPromptSubmit quality warning re-fires only when the score drops into a new lower 10-point band, and its SessionStart hook writes diagnostics to a log instead of the model's context. The nudges are emitted as a `systemMessage` or plain stdout, not `additionalContext`; "once" is keyed by `session_id`, which subagents share with their parent (issue 189); no test caps a hook's output size; and the subagent 1h cache TTL with its auto-revert runs only under an opt-in environment variable.

## Evidence
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/tests/test_fresh_nudge_once.py#L49 "def test_shows_once_even_when_the_cache_loses_its_flag(m):"
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/tests/test_fresh_nudge_once.py#L53-L54 "again = _degraded() assert m._maybe_fresh_session_nudge(again, _cache(m, SID), {}) is None"
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/tests/test_fresh_nudge_once.py#L58 "def test_racing_processes_show_it_once(m):"
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/.github/workflows/tests.yml#L70 "run: python -m pytest tests/ -q -rs"
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/.github/workflows/tests.yml#L7 "Guards that nothing enforces are decoration."
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/skills/token-optimizer/scripts/measure.py#L46961 "# Once per session."
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/skills/token-optimizer/scripts/measure.py#L46976 "if _ran_once_this_session("fresh-nudge", session_id):"
  - An `O_EXCL` marker file, so the once holds when the cache that carries the flag is rewritten (lines 46972-46975).
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/skills/token-optimizer/scripts/measure.py#L47548 "The fresh-session nudge BYPASSES pressure suppression on purpose"
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/skills/token-optimizer/scripts/measure.py#L47556 "print(json.dumps({"systemMessage":"
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/skills/token-optimizer/scripts/measure.py#L47072-L47073 "session cap + cooldown + "only re-fire on a NEW lower quality band.""
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/skills/token-optimizer/scripts/measure.py#L47108 "if last_band is not None and band >= last_band:"
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/skills/token-optimizer/scripts/measure.py#L47565 "if warn and _maybe_quality_warn(result, warn_threshold):"
  - The UserPromptSubmit hook runs `quality-cache --warn --quiet` (lines 47560-47562), which prints one plain line when the gate opens.
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/skills/token-optimizer/scripts/measure.py#L20318 "TOKEN_OPTIMIZER_SUBAGENT_CACHE_1H=1 is the ONLY automatic write"
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/skills/token-optimizer/scripts/measure.py#L20326 "A value the user set is never overridden"
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/skills/token-optimizer/scripts/measure.py#L20379 "_SUBAGENT_CACHE_TRIPWIRE_MIN_DAYS = 14"
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/skills/token-optimizer/scripts/measure.py#L20387 "_SUBAGENT_CACHE_TRIPWIRE_MIN_REQUESTS = 200"
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/skills/token-optimizer/scripts/measure.py#L21434 "# Net negative over a full window: undo OUR value only."

## Issues and changelog
The most-commented closed issues are about installs on other hosts and Windows, so these three were picked by relevance to hook output. `CHANGELOG.md` lines 240 and 363 below.
- https://github.com/alexgreensh/token-optimizer/issues/124 "It re-prints on **every single prompt** for as long as the score stays below `warn_threshold` (default 70)"
  - Broke: the UserPromptSubmit warning had no cap, cooldown or "only if worse" check, so a session sitting in one band got it on every prompt. Fixed: v5.11.82 (PR 126) gives it the session cap, cooldown and band-drop gate of the sibling nudge.
- https://github.com/alexgreensh/token-optimizer/issues/189 "In Claude Code, subagents share their parent's `session_id`"
  - Broke: Bash dedup keyed by session told a subagent its output was "identical to your previous output" for output only the parent had seen. Fixed: PR 190 keys dedup and the thrash nudge by session and agent identity.
- https://github.com/alexgreensh/token-optimizer/issues/281 "5.13.59 cuts these to at most two notices per session."
  - Broke: a host-policy notice showed on every SessionStart, UserPromptSubmit and Stop. Fixed: capped per session; it cannot be removed because the host's security guard runs first.
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/CHANGELOG.md#L240 "The "start a fresh session" tip shows once per session, as intended, instead of returning on later prompts."
  - Broke: the fresh-session nudge came back on later prompts; the test file names the cause, "A later write replaced the cache without the fired flag (the reported repeat)" (line 52). Fixed: 5.13.33 (2026-10-04).
- https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/CHANGELOG.md#L363 "Fix: SessionStart no longer adds anything to the model's context."
  - Broke: startup diagnostics on stdout and stderr landed in every session's context. Fixed: 5.13.14 (2026-09-14) writes them to a local log file.

## Lessons
- A nudge's "once per session" is a tested property, not prose (S32, Q10): test_fresh_nudge_once.py lines 49-58, run in CI by tests.yml line 70. Touches plugin/lib/session-hooks.mjs:58 (the Stop nudge emits `additionalContext` whenever `decideNudge` says so) and plugin/lib/session-hooks.mjs:204 (the SessionStart notice, once per start by its event); partial, the kit gates the Stop nudge by the reply's content (`decideNudge`, line 35), not by repetition; low cost, a unit test that two identical Stop inputs in one session produce one nudge, or a recorded reason they may not (T2).
- Re-emit only on new information (S32, Q10): `_maybe_quality_warn` lines 47072-47108, issue 124. Touches plugin/lib/session-hooks.mjs:204 (the SessionStart notice re-sends the role card and pending list on every `startup` and `resume`, changed or not, plugin/hooks/hooks.json:49-55); gap for "only when its content changes"; low cost, a hash of the last notice in the kit's state dir, skipping an identical one. token-optimizer's own warning sits on UserPromptSubmit, which T2 bans for the kit; take the gate, not the event.
- Startup output that the model does not need goes to a log, not the context (S32, Q10, Q7): changelog line 363. Touches plugin/lib/session-hooks.mjs:204 (`systemMessage` for the learn notice, `additionalContext` for the rest) and plugin/lib/hook-io.mjs:22-30 (`logGate` already logs to `gate-log.jsonl`); overlap, the kit already logs gate decisions; none.
- Key "once" by agent, not only by session, when subagents run hooks (S32, Q10): issue 189. Touches plugin/lib/session-hooks.mjs:57 (logs `input.session_id`, keys nothing on it); not applicable today, the only emission state the kit keeps, `learn_nudged` (line 205), is per project and day; none, a note for any T2 dedup the kit adds.
- The subagent 1h TTL is set and reverted by measured net, opt-in only (Q1): measure.py lines 20318, 20326, 20379, 20387, 21434. Touches no kit file; Q1 is session practice outside S32 per the technique set; not taken.
- Not covered: a byte cap on any hook's output (no test reads the length of what a hook prints), whether a `systemMessage` reaches the model (not read within the budget), skill or rules footprint (Q7-Q9).
