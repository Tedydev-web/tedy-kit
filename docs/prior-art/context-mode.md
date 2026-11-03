---
name: mksglu/context-mode
pinned: https://github.com/mksglu/context-mode/tree/849c8690bdf86eef60156e13d98efd10fcfd46fb
license: Elastic-2.0
studied: 2026-10-30
channel: github
domains: cost, platform
use-when: large tool output floods the conversation and should stay in a sandbox
---

# mksglu/context-mode

A supplement of sweep 261021-canon, not reference-labelled: context-mode, an MCP server and hook set that routes large tool output into a sandbox and an index so it stays out of the conversation, licensed Elastic License 2.0 (source-available), so it is studied, never copied, and excerpts stay short. Studied for S32 (T2 hook output, Q10) because its PreToolUse advisories go out at most once per type per session through an `O_EXCL` marker file, a vitest suite run in CI pins that throttle, its compaction re-injection is capped at 500 estimated tokens, and its UserPromptSubmit hook writes to SQLite and returns nothing to the model. "Once" has no content hash, so it is stricter than "only when its content changes"; a Read over 50,000 bytes and the external-MCP nudge deliberately bypass it; the SessionStart routing block is not size-capped; and every Agent call gets the routing block appended to its prompt, so the plugin's text reaches every subagent.

## Evidence
- https://github.com/mksglu/context-mode/blob/849c8690bdf86eef60156e13d98efd10fcfd46fb/hooks/core/routing.mjs#L121-L123 "function guidanceOnce(type, content, sessionId) {"
- https://github.com/mksglu/context-mode/blob/849c8690bdf86eef60156e13d98efd10fcfd46fb/hooks/core/routing.mjs#L130 "Atomic create-or-fail: O_CREAT | O_EXCL | O_WRONLY"
- https://github.com/mksglu/context-mode/blob/849c8690bdf86eef60156e13d98efd10fcfd46fb/hooks/core/routing.mjs#L143 "return { action: "context", additionalContext: content };"
- https://github.com/mksglu/context-mode/blob/849c8690bdf86eef60156e13d98efd10fcfd46fb/hooks/core/routing.mjs#L839-L840 "inject routing nudge (once per session)"
- https://github.com/mksglu/context-mode/blob/849c8690bdf86eef60156e13d98efd10fcfd46fb/hooks/core/routing.mjs#L853-L855 "?? { action: "context", additionalContext: readGuidance };"
  - A Read of a file over 50,000 bytes gets the guidance every time, throttled or not.
- https://github.com/mksglu/context-mode/blob/849c8690bdf86eef60156e13d98efd10fcfd46fb/hooks/core/routing.mjs#L151 "A single one-shot nudge gets lost"
  - `guidancePeriodic` re-fires the external-MCP nudge every N calls because a one-shot nudge is lost after compaction (lines 146-160).
- https://github.com/mksglu/context-mode/blob/849c8690bdf86eef60156e13d98efd10fcfd46fb/hooks/core/routing.mjs#L892 "inject context-mode routing into subagent prompts"
- https://github.com/mksglu/context-mode/blob/849c8690bdf86eef60156e13d98efd10fcfd46fb/hooks/core/routing.mjs#L913 ": { ...toolInput, [fieldName]: prompt + subagentBlock };"
- https://github.com/mksglu/context-mode/blob/849c8690bdf86eef60156e13d98efd10fcfd46fb/hooks/sessionstart.mjs#L166 "let additionalContext = ROUTING_BLOCK;"
- https://github.com/mksglu/context-mode/blob/849c8690bdf86eef60156e13d98efd10fcfd46fb/hooks/sessionstart.mjs#L206 "additionalContext += buildSessionDirective("compact", eventMeta, toolNamer);"
- https://github.com/mksglu/context-mode/blob/849c8690bdf86eef60156e13d98efd10fcfd46fb/hooks/auto-injection.mjs#L13 "Hard cap: 500 tokens (~2000 chars at 4 chars/token)."
- https://github.com/mksglu/context-mode/blob/849c8690bdf86eef60156e13d98efd10fcfd46fb/hooks/auto-injection.mjs#L61 "let budget = 500; // hard cap in tokens"
- https://github.com/mksglu/context-mode/blob/849c8690bdf86eef60156e13d98efd10fcfd46fb/hooks/userpromptsubmit.mjs#L8 "Must be fast (<10ms). Just a single SQLite write."
- https://github.com/mksglu/context-mode/blob/849c8690bdf86eef60156e13d98efd10fcfd46fb/tests/guidance-throttle.test.ts#L34 "Bash: first call returns guidance, second returns null"
- https://github.com/mksglu/context-mode/blob/849c8690bdf86eef60156e13d98efd10fcfd46fb/tests/guidance-throttle.test.ts#L188 "different sessionIds get independent throttles"
- https://github.com/mksglu/context-mode/blob/849c8690bdf86eef60156e13d98efd10fcfd46fb/.github/workflows/ci.yml#L73-L75 "if grep -q "Tests.*failed" /tmp/vitest-output.txt; then"
  - CI fails on a failed test by parsing vitest's summary, not its exit code, because worker teardown can exit non-zero after a pass (lines 63-66).

## Issues and changelog
None citable: the repository has issues disabled (the API answers HTTP 410), its pulls listing answers 404, and there is no changelog at the pinned commit. The code names the upstream numbers it fixed (298, a marker directory keyed by a parent pid that shifts on Windows, now keyed by session id; 567, the periodic external-MCP nudge; 724, the subagent block's ToolSearch bootstrap; 233, ctx commands left out of the subagent block), but none can be fetched.

## Lessons
- Cap the bytes a hook injects, in the hook, and say the unit (S32, Q10): auto-injection.mjs lines 13 and 61. Touches plugin/lib/session-hooks.mjs:204 (the SessionStart notice joins the config warning, role card, pending list, waiting list and learn line with no length bound; the pending and waiting lists grow with the drafts waiting) and plugin/lib/push-report.mjs:90 (joins every report); gap; low cost, a unit test that each hook's output for its fixtures stays under a committed byte cap, well below the platform's 10,000-character cap on `additionalContext` (Q10 row) (T2).
- Throttle a standing reminder at the hook with an atomic marker, and pin it with a test (S32, Q10): routing.mjs lines 121-143, guidance-throttle.test.ts lines 34 and 188, run in CI. Touches plugin/lib/session-hooks.mjs:58 (the Stop nudge has no repetition bound; `decideNudge` decides from the last reply alone); partial; low cost if T2 wants one; the kit's pilot measured the nudge at 50 fires in 1,002 passes (Q10 row), so the gain is small.
- "Once" by type is not "on change", and it fights compaction (S32, Q10): routing.mjs lines 151 and 853-855 show the author re-firing on purpose after compaction and for large reads. Touches plugin/hooks/hooks.json:56-61 (the kit re-sends its role reminder on `compact` only); overlap, the kit already re-injects only on compaction; none.
- No UserPromptSubmit output (S32, Q10, Q3): userpromptsubmit.mjs line 8, a capture-only hook. Touches plugin/hooks/hooks.json (no UserPromptSubmit or InstructionsLoaded entry today); overlap; none, a static test that the two events stay absent would hold it (T2).
- A once-marker keyed by `session_id` is shared by a parent and its subagents (S32, Q10): `guidanceDirFor(sessionId)` (routing.mjs lines 116-119) keys the marker by session; token-optimizer issue 189 reports that subagents share their parent's `session_id`, so a subagent whose parent already got a nudge would not get its own. Touches no kit file today (the kit's hooks keep no per-session marker); note for T2.
- Another plugin's text in every subagent is outside the kit's artifacts (Q16): routing.mjs lines 892-913 append the routing block to every Agent prompt. Touches plugin/agents/reviewer.md (T4: a kit reviewer spawned where context-mode is installed carries that block whatever `omitClaudeMd` says); not taken in S32, it is the user's environment; record it as a confound for the T4 eval.
- Not covered: skill or rules footprint (Q7-Q9), cache TTL or prefix order (Q1, Q3); the SessionStart routing block itself has no size test.
