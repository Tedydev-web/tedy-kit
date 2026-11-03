---
name: garrytan/gstack
pinned: https://github.com/garrytan/gstack/tree/c197a139b7eba04aa3a7a937bfcd1019bff224fb
license: MIT
studied: 2026-11-03
channel: github
domains: evals, testing, agent-skills
use-when: you decide which paid evals a change must run, what a skill test may pin, or how to keep generated skills and their size under control
---

# garrytan/gstack

Garry Tan's Claude Code skill suite (about 65 skills such as `/review`, `/ship`, `/qa`, `/autoplan`, plus a headless browser), Bun and TypeScript, studied because it runs the largest test and eval machine found for a skill kit: SKILL.md files generated from `.tmpl` templates and shared resolvers, a free suite plus paid E2E and LLM-judge lanes selected from `git diff` through touchfile maps, gate and periodic tiers enforced by a test, token-budget ratchets per skill, a written test value bar that forbids pinning English sentences, and a gate-integrity catalog `/review` reads on every diff. The master plan's claims that it uses `node:test` and splits `lib/` and `test/` for hook latency do not hold at this SHA: tests run on `bun test` behind a sharded runner. The paid lanes cost about 86 to 95 USD per full census (#2755).

## Evidence
- https://github.com/garrytan/gstack/blob/c197a139b7eba04aa3a7a937bfcd1019bff224fb/CLAUDE.md#L116 "SKILL.md files are **generated** from `.tmpl` templates."
- https://github.com/garrytan/gstack/blob/c197a139b7eba04aa3a7a937bfcd1019bff224fb/CLAUDE.md#L158 "NEVER resolve conflicts on generated SKILL.md"
- https://github.com/garrytan/gstack/blob/c197a139b7eba04aa3a7a937bfcd1019bff224fb/CLAUDE.md#L40 "selects tests from `git diff` through the"
- https://github.com/garrytan/gstack/blob/c197a139b7eba04aa3a7a937bfcd1019bff224fb/CLAUDE.md#L43-L44 "Classify every new E2E test in `E2E_TIERS`: safety guardrail or deterministic functional test -> `gate`"
- https://github.com/garrytan/gstack/blob/c197a139b7eba04aa3a7a937bfcd1019bff224fb/test/helpers/test-selection.ts#L364 "Global touchfile hit → run all."
- https://github.com/garrytan/gstack/blob/c197a139b7eba04aa3a7a937bfcd1019bff224fb/CLAUDE.md#L79 "prompt bytes are a contract only when software reads them"
- https://github.com/garrytan/gstack/blob/c197a139b7eba04aa3a7a937bfcd1019bff224fb/CLAUDE.md#L84 "Don't pin emphasis,"
- https://github.com/garrytan/gstack/blob/c197a139b7eba04aa3a7a937bfcd1019bff224fb/docs/test-value-bar.md#L3-L4 "a test earns its place by protecting behavior that a real regression would break. Test count is not a goal."
- https://github.com/garrytan/gstack/blob/c197a139b7eba04aa3a7a937bfcd1019bff224fb/docs/test-value-bar.md#L28-L29 "An English sentence is not a prompt-byte contract because the model reads it"
- https://github.com/garrytan/gstack/blob/c197a139b7eba04aa3a7a937bfcd1019bff224fb/CLAUDE.md#L151-L152 "each new skill ratchets it); and `test/context-budget-ratchet.test.ts` pins per-skill token ceilings"
- https://github.com/garrytan/gstack/blob/c197a139b7eba04aa3a7a937bfcd1019bff224fb/CLAUDE.md#L170-L171 "**If missing, AskUserQuestion**"
- https://github.com/garrytan/gstack/blob/c197a139b7eba04aa3a7a937bfcd1019bff224fb/CLAUDE.md#L179 "Each bash code block runs in a separate shell"
- https://github.com/garrytan/gstack/blob/c197a139b7eba04aa3a7a937bfcd1019bff224fb/review/gate-integrity.md#L13 "does this relaxation silence the failure it was added"
- https://github.com/garrytan/gstack/blob/c197a139b7eba04aa3a7a937bfcd1019bff224fb/review/gate-integrity.md#L16 "The control is the human disposition, not the"
- https://github.com/garrytan/gstack/blob/c197a139b7eba04aa3a7a937bfcd1019bff224fb/review/SKILL.md.tmpl#L175 "`NO FINDINGS` is a complete result from any reviewer."

## Issues and changelog
- https://github.com/garrytan/gstack/issues/3062 "input but gives PreToolUse the **schema-parsed** input."
  - Broke: on Claude Code 2.1.292 the `/autoplan` publication hook deep-compared the journaled raw tool input with the PreToolUse payload, the fork-subagent schema dropped `run_in_background` from the payload, and every reviewer dispatch was denied with a "retry" that could never pass. Fixed: PR #3069 ignores only that key and checks the payload against journaled records when the current call is not yet flushed.
- https://github.com/garrytan/gstack/issues/3062 "CI now pins 2.1.292, and a daily canary checks the newest release."
  - Broke: see above; a harness release changed hook input shape under a working kit. Fixed: a pinned Claude Code version in CI plus a daily canary on the newest release.
- https://github.com/garrytan/gstack/issues/3505 "The whole SKILL.md enters context on every invocation"
  - Broke: 33 of 65 SKILL.md files were over about 10k tokens and `/design-review` about 34k, paid on each invocation. Not fixed: closed as not planned; the repo keeps the per-skill ratchet (`test/context-budget-ratchet.test.ts`) instead of splitting. A commenter warned that a reference linked only at the top is skipped silently, and that the read instruction belongs at the step that needs it.
- https://github.com/garrytan/gstack/pull/3888 "paid $67 only because the selector didn't recognize the GBrain setup guide"
  - Broke: a docs-only file unknown to the touchfile maps counted as an unknown dependency and restored all 113 gate cases and 24 judges. Fixed: the file joined `FREE_ONLY_PR_FILES`, with a boundary test that fails if a paid runner imports a free-only path.
- https://github.com/garrytan/gstack/issues/2889 "Declarations before measurements, deliberately."
  - Broke: nothing; a proposal to add author-declared benefit fields beside the per-skill token bill. Not taken: closed as not planned because estimates would not change which skill anyone picks.
- https://github.com/garrytan/gstack/issues/2755 "VERDICT RED — lane periodic/full census, attempt 1"
  - Broke: the weekly periodic lane went red on judge and rule cases. Fixed: an automated weekly issue lists every failure with its rerun command, counts deselected cases with zero credit, and closes when the lanes are green; quarantine lives in `test/helpers/periodic-exclude-data.ts`.

## Lessons
- Test what software reads, not English sentences: touches `plugin/tests/skill-contracts.test.mjs:15` (a regex over the prose of `review-pr/SKILL.md` step 4, "Merge only on the user's yes ... never close a PR"); most other assertions there pin script names and flags, which the value bar keeps; gap; cost low. Replace sentence pins with structural checks or a cited eval, so rewording a skill does not fail the suite.
- Select paid evals from the diff through a touchfile map, with an unknown file restoring everything: touches `plugin/evals/pressure/run-pressure.sh:7` (`SCENARIOS` chosen by hand) and `plugin/evals/probes/run-probes.sh`; gap; cost high. PR #3888 shows the map needs a free-only list or docs edits buy full paid runs.
- Two tiers: deterministic safety cases gate every change, quality and model-dependent cases run periodically with quarantine: touches `plugin/evals/pressure/run-pressure.sh:6-8`; gap; cost medium.
- Pin the harness version and run a canary on the newest release (#3062): touches nothing yet (the only workflow is `.github/workflows/codeql.yml`); gap; cost medium. The kit's gates read PreToolUse `tool_input`, so a harness change to that shape is the same failure class.
- Per-skill size ratchet in tokens beside a flat cap: overlap with `plugin/tests/skill-size.test.mjs:10` (every SKILL.md at 9,000 characters or fewer, stronger than gstack's 160KB warning); a ratchet would also catch growth under the cap; cost low.
- Gate-integrity reading of every test, CI and lint-config hunk with one question, human decides: touches `plugin/agents/reviewer.md:33` and `plugin/skills/dev/SKILL.md:39`; partial; cost medium. The useful split is listed, read and finding: the tool tags hunks and never judges.
- Generated skills from templates and shared resolvers: touches `plugin/shared/` (hand-written shared files read at run time); not taken for six skills; regeneration and merge rules (CLAUDE.md line 158) cost more than the duplication they remove at this size.
- Project facts read from CLAUDE.md, asked once with AskUserQuestion, then persisted: overlap with the kit's project map (`plugin/scripts/project-map.mjs`); no change.
