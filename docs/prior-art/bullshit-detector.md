---
name: SerhiiKorniienko/bullshit-detector
pinned: https://github.com/SerhiiKorniienko/bullshit-detector/tree/d5f6156a8a5c72977bf2d4edae834dd22f7fa736
license: MIT
studied: 2026-10-28
channel: github
---

# SerhiiKorniienko/bullshit-detector

Agent skills that fact-check videos, articles and posts claim by claim, with a gate script (`tally.py`) that validates every report. Studied for the canon (sweep `261021-canon`, pass 1): each report carries the rules version it was written under, checks added later carry the version they apply from, and its eval states harness, model and arms with an honest failing score.

## Evidence
- https://github.com/SerhiiKorniienko/bullshit-detector/blob/d5f6156a8a5c72977bf2d4edae834dd22f7fa736/skills/analysis/bullshit-detector/scripts/tally.py#L60-L62 "Reports stamped by an older release were written under that release's rules. Checking # them against rules added later is the same error as re-scoring an old report with a new # rubric, so each check that postdates a release records the version it starts applying at."
- https://github.com/SerhiiKorniienko/bullshit-detector/blob/d5f6156a8a5c72977bf2d4edae834dd22f7fa736/skills/analysis/bullshit-detector/scripts/tally.py#L431-L434 "def check_applies(text: str, since: tuple) -> bool: """Whether a check added in release `since` should judge this report.""" version = report_version(text) return version is None or version >= since"
- https://github.com/SerhiiKorniienko/bullshit-detector/blob/d5f6156a8a5c72977bf2d4edae834dd22f7fa736/skills/analysis/bullshit-detector/scripts/tally.py#L368-L370 "Every `*_SINCE` must be <= the version in the manifest. A check gated at a version that never ships never fires, and does so silently"
- https://github.com/SerhiiKorniienko/bullshit-detector/blob/d5f6156a8a5c72977bf2d4edae834dd22f7fa736/skills/analysis/bullshit-detector/scripts/tally.py#L1636-L1638 "if not VERSION_STAMP.search(text) and not VERSION_UNKNOWN.search(text): problems.append( "no version stamp — header must carry `bullshit-detector <version>`, or ""
- https://github.com/SerhiiKorniienko/bullshit-detector/blob/d5f6156a8a5c72977bf2d4edae834dd22f7fa736/scripts/write-version-files.py#L12-L14 "The single source of truth stays `.claude-plugin/plugin.json`; this script propagates it, and `tally.py --self-test` fails loudly when a VERSION file drifts from the manifest"
- https://github.com/SerhiiKorniienko/bullshit-detector/blob/d5f6156a8a5c72977bf2d4edae834dd22f7fa736/scripts/check-consistency.py#L16-L20 "Nothing caught it because nothing compared the copies. The duplication itself is deliberate — skills ship as independent directories and a cross-skill import would break the moment someone installs one without the other — so the fix is not a shared module, it is a test that the copies still match."
- https://github.com/SerhiiKorniienko/bullshit-detector/blob/d5f6156a8a5c72977bf2d4edae834dd22f7fa736/skills/analysis/bullshit-detector/scripts/tally.py#L504-L506 "`searches` cannot exceed `tools`, because issuing a search *is* a tool call."
- https://github.com/SerhiiKorniienko/bullshit-detector/blob/d5f6156a8a5c72977bf2d4edae834dd22f7fa736/skills/analysis/bullshit-detector/SKILL.md#L30-L32 "A quick report discloses itself: `"mode": "quick"` in the run record and the **Mode: quick** line specified in [RUBRIC.md](RUBRIC.md) directly under the Checked line — the gate rejects a quick run that hides it."
- https://github.com/SerhiiKorniienko/bullshit-detector/blob/d5f6156a8a5c72977bf2d4edae834dd22f7fa736/eval/run-case.sh#L11-L12 "EVAL_QUICK=1 asks the runner for the skill's quick mode (a distinct arm — # never compare a quick run against full-mode baselines as if same instrument)"
- https://github.com/SerhiiKorniienko/bullshit-detector/blob/d5f6156a8a5c72977bf2d4edae834dd22f7fa736/eval/RESULTS.md#L5-L7 "**Harness:** `eval/run-case.sh` in claims-only mode, headless `claude -p`, model `claude-sonnet-5`, reasoning effort `xhigh`, transcripts pre-fetched, skill paths handed over, runner never told it is scored or timed."
- https://github.com/SerhiiKorniienko/bullshit-detector/blob/d5f6156a8a5c72977bf2d4edae834dd22f7fa736/eval/RESULTS.md#L32 "**The gate fails on every case that has enough known-true claims to test it.**"
- https://github.com/SerhiiKorniienko/bullshit-detector/blob/d5f6156a8a5c72977bf2d4edae834dd22f7fa736/scripts/check-fixture-independence.py#L6 "Assert no worked example in the skill instructions is quoted from content we measure on."

## Issues and changelog
- https://github.com/SerhiiKorniienko/bullshit-detector/issues/46 "So every report from `npx skills add` — the install path the README leads with — was non-compliant and could not be made compliant by following the rules."
  - Broke: the rubric told a manifest-less install to stamp `version unknown` and the gate rejected that string. Fixed: the gate accepts it, and `write-version-files.py` puts a generated VERSION file in every skill, checked by `tally.py --self-test`.
- https://github.com/SerhiiKorniienko/bullshit-detector/issues/38 "a fabricated-but-consistent run line is currently undetectable by the tool."
  - Broke: an invented wall time passed because every check only compared the report with itself. Fixed: `wall_seconds` must equal `finished` minus `started` in the run record, from 0.13.0 (`RUN_CLOCK_SINCE`).
- https://github.com/SerhiiKorniienko/bullshit-detector/issues/33 "A validator whose failure mode is *"insert this word"* will get the word."
  - Broke: a check that rejected a row unless it held the word `searched` taught reports to add the word, and the verification count keyed on it. Fixed: a parsed `❓ unverifiable (searched)` or `(by construction)` token in the verdict cell, from 0.11.0.
- https://github.com/SerhiiKorniienko/bullshit-detector/issues/41 "the harness will grade the instrument on answers the instrument was given."
  - Broke: a worked example in SKILL.md was quoted from a regression-set video, so runs on it were told the answer. Fixed: `check-fixture-independence.py`, which fails when a quoted span of 4 or more words in SKILL.md or RUBRIC.md appears in a cached fixture.

## Lessons
- Each artifact records the rules version it was made under, and a check added later records the version it applies from, so older artifacts are waived by version instead of by name (S1, S2): `tally.py` `*_SINCE` constants and `check_applies`. Touches plugin/lib/sweep-record.mjs (criteria pin, sweep records only) and plugin/lib/prior-art.mjs:5 (ADRs exempted by file name); gap for skills, gates and ADRs; low cost, one `standard:` field and one since-version per check.
- A version-gated check is itself checked: a since-version ahead of the manifest fails the self-test, because that check could never fire (S8, S2). Touches plugin/tests; gap (the kit has no gated checks yet); none until versioned checks exist.
- A check that compares the artifact only with itself is gamed by consistent invention; a check whose failure message names a word gets the word (S8): issues 38 and 33. Touches plugin/tests/skill-contracts.test.mjs:31 (fact-only graders) and plugin/evals; overlap (graders read facts, not wording); none.
- Eval fixtures are kept independent of the instructions under test, by a script that fails on any shared quoted span (S8, S9): issue 41, `check-fixture-independence.py`. Touches plugin/evals/test-integrity-* and plugin/skills/*/SKILL.md; gap (nothing checks that skill examples are absent from eval prompts); low cost.
- The manifest is the one version source, every copy is generated from it, and a self-test fails on drift (S15). Touches plugin/.claude-plugin/plugin.json and plugin/lib/profile.mjs:160 (worktree tag only); gap (no check that the manifest equals the tag); low cost.
- Deliberate duplication across independently installed parts is kept, with a test that the copies still match, instead of a shared module (S4, S12): `check-consistency.py`. Touches plugin/tests/shim-parity.test.mjs; overlap; none.
- A results file states harness, rules commit, model, effort, inputs and label status, runs each mode as its own arm, and publishes a failing score (S9, S10, S7): `eval/RESULTS.md`, `run-case.sh`, and the gate rejects a quick run that hides its mode. Touches docs/adr/0010-dev-red-step-and-honest-green.md and docs/adr/0009-fact-based-ablation-evals.md; overlap for S9 and S10, partial for S7 (the kit records the invocation prefix but no run record states the mode); low cost.
- Run effort is logged per report (wall time, searches, tool calls, seconds per claim) and the gate refuses impossible counts, but no money is logged (S24). Touches docs/adr/0009-fact-based-ablation-evals.md:14 (cost cap) and docs/adr/0010-dev-red-step-and-honest-green.md (void spend reported); partial (the kit logs money, not per-run effort counts); low cost.
