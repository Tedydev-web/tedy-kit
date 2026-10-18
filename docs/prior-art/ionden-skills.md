---
name: IonDen/skills
pinned: https://github.com/IonDen/skills/tree/3c26c042ae79e31464a0c7c7b60de84fe38595d3
license: MIT
studied: 2026-10-18
channel: github
---

# IonDen/skills

## Evidence
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/plugins/ionden-skills/skills/writing-tests-that-can-fail/SKILL.md#L21 "A test earns its place only if you can name the one-line bug that turns it red."
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/plugins/ionden-skills/skills/writing-tests-that-can-fail/SKILL.md#L55 "Expected values and boundary inputs are literals from the spec"
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/plugins/ionden-skills/skills/writing-tests-that-can-fail/SKILL.md#L84 "Before you keep a test, break the code on purpose and watch the test go red"
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/plugins/ionden-skills/skills/writing-tests-that-can-fail/SKILL.md#L94 "A test that passed on its first run, before you ever saw it fail, has proved nothing yet."
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/plugins/ionden-skills/skills/writing-tests-that-can-fail/SKILL.md#L101 "change a test's expected value, tolerance, input or skip status;"
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/plugins/ionden-skills/skills/writing-tests-that-can-fail/SKILL.md#L106 "Change the test only as a separate, labelled change the user agrees to."
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/plugins/ionden-skills/skills/writing-tests-that-can-fail/SKILL.md#L108 "After three failed attempts"
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/plugins/ionden-skills/skills/writing-tests-that-can-fail/SKILL.md#L136 "load when reviewing a red-to-green diff, or before changing a failing test."
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/plugins/ionden-skills/skills/writing-tests-that-can-fail/references/cheating-patterns.md#L3 "None of these is ever acceptable."
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/plugins/ionden-skills/skills/writing-tests-that-can-fail/references/cheating-patterns.md#L43 "mutate the function (return a constant, delete the body). If the suite stays green, the tests are too thin."
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/plugins/ionden-skills/skills/writing-tests-that-can-fail/references/languages/javascript-typescript.md#L49 "There is no dedicated runner for `node:test`."
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/plugins/ionden-skills/skills/writing-tests-that-can-fail/references/languages/javascript-typescript.md#L55 "Any of these inside a fix is suspect:"
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/plugins/ionden-skills/skills/writing-tests-that-can-fail/references/languages/javascript-typescript.md#L61 "Filters that hide tests: `--passWithNoTests`"
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/evals/writing-tests-that-can-fail/harness.py#L81 "anything else (collection or import error, no tests, crash) = error."
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/evals/writing-tests-that-can-fail/harness.py#L100 "if counts.get("tests", 0) == 0 or counts.get("cancelled", 0):"
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/evals/writing-tests-that-can-fail/harness.py#L289-L290 "CONFIG_FILES = ("conftest.py", "pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini")"
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/evals/writing-tests-that-can-fail/harness.py#L314 "if not unchanged or config_added or skips or (given == PASS and heldout != PASS):"
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/evals/writing-tests-that-can-fail/rubric.md#L19 "This is not a pass, because the given tests are correct."
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/evals/writing-tests-that-can-fail/README.md#L49 "two of the three Haiku baselines imported the module's constants and asserted `== BASE_FEE`"

## Issues and changelog
- https://github.com/IonDen/skills/pull/16 "Two of the shipping fixture's ten mutants were added after a discarded trial run showed that pattern, before any recorded run."
  - Broke: a trial suite without the skill killed the first eight mutants while copying its expected values from the code's constants, so the fixture could not tell a copied oracle from a spec one. Fixed: mutants e9 and e10 change the fee constants and were added before any recorded run.
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/evals/writing-tests-that-can-fail/README.md#L53 "a fix that always rounds up would have passed it."
  - Broke: the held-out suite for the red-test fixture held only whole and exact-half amounts, so a wrong fix scored `fixed`. Fixed: two below-half cases added, new test files listed in `tests_added` instead of counting as a changed test, all seven F verdicts recomputed (still `fixed`).
- https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/evals/writing-tests-that-can-fail/README.md#L38 "In fixture F, every baseline run fixed the rounding in the code and left the tests alone"
  - Broke: the no-test-edit fixture never showed the failure without the skill (Haiku 3/3, Sonnet 1/1 fixed honestly), so the no-test-edit and attempt-cap rules have no measured effect. Fixed: not fixed; the rubric requires stating a non-discriminating baseline in the headline, which the README does.
- Searches: `gh api -X GET search/issues -f q='repo:IonDen/skills is:closed'` returned 25 items, all merged PRs, none with reactions; only #12 has a comment. No issues exist, so the terms test, skip, tdd, red, mutation and bypass select nothing beyond #16 and #18 (#18 is a directory-scan false positive on a Swift example, off topic).

## Lessons
- Spec-literal oracle (expected values and boundary inputs are literals from the spec, never the code's constants or current output): touches `plugin/skills/dev/SKILL.md:35` (Build) and `:45-48` (one anti-rationalization row: "assert == the constant"); gap; cost low. Best-evidenced rule in the repo: shipping fixture 1/3 to 3/3 with the skill, Sonnet baseline 0/1 because it also built boundary inputs from the threshold constant.
  - Surface: skill line. Not disqualified; no failure mode found against it.
- Proof a test can fail by breaking the code (flip a comparison, return a constant, delete the body): touches `plugin/skills/dev/SKILL.md:37` (Verify) and `:39` (report records the red run); gap; cost low when scoped to the tests written for the change, by hand; mutation tools cost more (StrykerJS has no `node:test` runner). This is not P1: it allows writing the test after the code and proves red afterwards. It is the fallback where test-first does not apply, and overlaps superpowers' revert-the-fix lesson.
  - Surface: skill line. Not disqualified.
- Stub-out red check (delete the body or return a constant; a green suite means the tests are too thin): same touch point and surface as the mutation lesson, which it is a case of; overlap with it; no separate change.
  - Surface: skill line. Not disqualified.
- No test edit inside a fix (expected value, tolerance, input, skip status, runner config): touches `plugin/skills/dev/SKILL.md:37` ("A failure is fixed in a new commit") and `:45-48`; gap; cost low. Its fixture never discriminated, so its effect is unmeasured.
  - Surface: skill line. A PreToolUse block on edits to test files is disqualified in Claude Code: feature tasks change tests legitimately, and the harness's check works only because the fixture's given tests are known correct.
- Test change as its own labelled change the user agrees to: touches `plugin/skills/dev/SKILL.md:36` (one concern per commit, which it extends) and the user's AskUserQuestion rule; partial overlap; cost low.
  - Surface: skill line plus one AskUserQuestion. Not disqualified.
- Attempt cap (stop and report after three failed attempts on the same failure): touches `plugin/skills/dev/SKILL.md:37`, whose fix-and-rerun loop is unbounded; gap; cost low. No fixture exercises it.
  - Surface: skill line. Survives on cost, not on evidence.
- Cheat catalog for red-to-green diffs (copied oracle, special-cased input, always-equal object, early exit, runner patching, swallowed exception, widened tolerance): touches `plugin/agents/reviewer.md:26` (bugs lens) and `:21` (the reference files it loads); gap; cost low (one reference the bugs lens loads when the diff turns red tests green).
  - Surface: reviewer agent reference. Not disqualified.
- Red-flag flags in a test command (`--passWithNoTests`, `-u`/`--updateSnapshot`, `--allowOnly`, `--test-skip-pattern`, `--test-name-pattern`): touches `plugin/hooks/hooks.json:17-19` (git-gate on Bash) and `plugin/skills/dev/SKILL.md:37`; gap; cost low. The cheapest real gate for P2.
  - Surface: PreToolUse on Bash. Not disqualified; deny only the flags, never test runs.
- Static check of a red-to-green change (given test files hashed against the original, runner config files, skip-marker regex, zero tests counted as error, held-out suite): touches `plugin/skills/dev/SKILL.md:37` and `:39`; gap (the kit has no P2 check at all); cost medium (per-runner parse of the test count; `git diff --name-only origin/<base>` filtered by test globs and skip markers, listed in the report and handed to the bugs lens).
  - Surface: verify step plus report. The held-out suite is disqualified: real repositories have no hidden oracle, and the repo's own held-out suite proved too thin (README L53). The hash part survives only as a report list, not a block, for the reason in the no-test-edit lesson. Zero tests counted as not green survives as a verify rule.
