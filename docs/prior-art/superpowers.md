---
name: obra/superpowers
pinned: https://github.com/obra/superpowers/tree/bb92a77741419a4ab5f06e711a283343f1ada0c3
license: MIT
studied: 2026-10-18
channel: github
---

# obra/superpowers

## Evidence
- https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/test-driven-development/SKILL.md#L34 "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST"
- https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/test-driven-development/SKILL.md#L37 "Write code before the test? Delete it. Start over."
- https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/test-driven-development/SKILL.md#L126 "You're testing existing behavior. Fix test."
- https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/test-driven-development/SKILL.md#L186 "green run of the test you wrote is not a green suite."
- https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/test-driven-development/writing-good-tests.md#L168 "A mutation nothing catches marks the behavior as unprotected"
- https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/verification-before-completion/SKILL.md#L17 "NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE"
- https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/verification-before-completion/SKILL.md#L47 "VCS diff shows changes"
- https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/verification-before-completion/SKILL.md#L84 "Revert fix"
- https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/writing-skills/SKILL.md#L154 "an agent may follow the description instead of reading the full skill content"
- https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/writing-skills/SKILL.md#L379 "NO SKILL WITHOUT A FAILING TEST FIRST"
- https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/writing-skills/SKILL.md#L470 "Conditional keyed to an observable predicate"
- https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/RELEASE-NOTES.md#L100 "sessions ran only that file in 11 of 12 probe runs"
- https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/RELEASE-NOTES.md#L178 "Trivial code and human prose earn no test"
- https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/RELEASE-NOTES.md#L179 "Deleting the section outright measurably degraded test-first behavior"

## Issues and changelog
- https://github.com/obra/superpowers/issues/633 "Subagents create files and commit their work"
  - Broke: the commit lacked new files the working tree had, so checks passed locally and a fresh checkout failed. Fixed: PR #661 (post-commit `git status` check) was closed unmerged after nobody could reproduce on newer Claude Code, whose system prompt gained staging instructions.
- https://github.com/obra/superpowers/issues/2112 "each one could add new acceptance criteria"
  - Broke: each fresh re-reviewer added new criteria, tests grew 25 to 62 and the task never converged. Fixed in v6.3.0: re-reviews are scoped to the prior findings list, out-of-scope observations become deferred items, a breaker stops at round 5.
- https://github.com/obra/superpowers/issues/384 "Hooks are rules, markdown files are suggestions."
  - Broke: with TDD mandated in CLAUDE.md the agent still wrote the implementation first and tests after. Not fixed in the plugin: closed with "add it to CLAUDE.md". The issue proposed a PreToolUse hook gate; a commenter pointed to nizos/tdd-guard.
- https://github.com/obra/superpowers/issues/1576 "subagent skips TDD entirely"
  - Broke: the implementer prompt applied TDD only when the task text asked for it, and generated plans never asked, so every run skipped TDD. Closed as a duplicate of #853, which carries the planning-to-execution TDD contract.
- https://github.com/obra/superpowers/issues/237 "this is a Claude Code platform limitation"
  - Broke: subagents did not receive SessionStart hook context, so TDD discipline faded in dispatched work. Not fixable in the plugin; the workaround is restating the rules in every dispatch prompt.
- Changelog v6.4.1 (RELEASE-NOTES.md#L100, #2110): sessions told one test file ran only that file; the skill now requires the project's own test command and naming every failure. v6.2.0 (#L179): deleting the "why order matters" prose lowered test-first compliance (8/10 to 5/10), so the arguments moved into rationalization rows.

## Lessons
- Test-first, proven red, keyed to an observable predicate (bug fix or logic change, not copy or styling): touches `plugin/skills/dev/SKILL.md:35` (Build) and `:39` (report records the red run); missing; cost low (one step clause plus one anti-rationalization row). Key it to the predicate, not to task text, because #1576 shows "if the task says so" means never.
- Regression proof by reverting the fix and watching the test fail: touches `plugin/skills/dev/SKILL.md:37`; missing; cost low, but only meaningful once test-first exists.
- Project suite defines green: overlap with `plugin/skills/dev/SKILL.md:37` (all `package.json` test scripts on the commit); no change.
- Verify the committed state, not the working tree (#633): overlap with `plugin/skills/dev/SKILL.md:18`, `:36` and `:47`; the kit is stronger (checks run on a clean committed tree); no change.
- Scope re-review to prior findings (#2112): overlap with `plugin/skills/dev/SKILL.md:38` (fix only findings this change introduced, re-run step 6, no re-review loop) and `plugin/agents/reviewer.md:33` (pre-existing problems kept out of findings); no change.
- Fresh evidence before any completion claim: partial at `plugin/skills/dev/SKILL.md:52` (Done lists conditions but not that each was observed in this run); cost low; weaker than the test-first lesson because the kit's report already carries verify output.
- Rules reach subagents only through the dispatch prompt (#237): overlap with `plugin/skills/dev/SKILL.md:38` and `plugin/agents/reviewer.md:9-17` (map facts and plugin root passed explicitly); no change.
- Description trap: `plugin/skills/dev/SKILL.md:3` summarizes the workflow, but `:5` sets `disable-model-invocation: true`, so the description should not drive model routing; low priority, unverified.
- Prefer a gate over prose (#384): a PreToolUse test-first gate would be the strongest form, but frontend visual work from Figma would trip it constantly; cost high; revisit only if the skill-line change fails its eval.
