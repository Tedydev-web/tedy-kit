---
name: danjdewhurst/story-skills
pinned: https://github.com/danjdewhurst/story-skills/tree/4b8019d7fa08e1e1866be360fadab2a2f7cbcf11
license: MIT
studied: 2026-10-28
channel: github
---

# danjdewhurst/story-skills

Agent skills and a companion CLI for planning and drafting fiction in markdown. Studied for the canon (sweep `261021-canon`, pass 1): it measures each skill against a no-skill baseline arm, refuses a release with an empty changelog, and replays the command samples in its docs against the real CLI.

## Evidence
- https://github.com/danjdewhurst/story-skills/blob/4b8019d7fa08e1e1866be360fadab2a2f7cbcf11/evals/compare-outputs.js#L10 "A pair counts as a win only if the same draft wins"
- https://github.com/danjdewhurst/story-skills/blob/4b8019d7fa08e1e1866be360fadab2a2f7cbcf11/evals/compare-outputs.js#L17 "dir-b draft must pass at least that many more of the fixture's checks"
- https://github.com/danjdewhurst/story-skills/blob/4b8019d7fa08e1e1866be360fadab2a2f7cbcf11/evals/compare-outputs.js#L107 "ok: b - a >= checks.baseline_margin"
- https://github.com/danjdewhurst/story-skills/blob/4b8019d7fa08e1e1866be360fadab2a2f7cbcf11/evals/compare-outputs.js#L198 "A missing verdict is a failed comparison, never a tie."
- https://github.com/danjdewhurst/story-skills/blob/4b8019d7fa08e1e1866be360fadab2a2f7cbcf11/evals/compare-outputs.js#L209 "(Never label which directory came from the skill: labelled authorship shifts judge preference.)"
- https://github.com/danjdewhurst/story-skills/blob/4b8019d7fa08e1e1866be360fadab2a2f7cbcf11/evals/compare-outputs.js#L215 "so it is never a vacuous pass."
- https://github.com/danjdewhurst/story-skills/blob/4b8019d7fa08e1e1866be360fadab2a2f7cbcf11/evals/README.md#L193-L194 "None of that belongs in a per-commit gate. CI runs only the deterministic half"
- https://github.com/danjdewhurst/story-skills/blob/4b8019d7fa08e1e1866be360fadab2a2f7cbcf11/CHANGELOG.md#L5 "`bun run release` refuses to release while `Unreleased` is empty, and moves its entries under the new version."
- https://github.com/danjdewhurst/story-skills/blob/4b8019d7fa08e1e1866be360fadab2a2f7cbcf11/scripts/release.js#L264 "has no entries under "## [Unreleased]". Add the user-visible changes first."
- https://github.com/danjdewhurst/story-skills/blob/4b8019d7fa08e1e1866be360fadab2a2f7cbcf11/docs/development.md#L383 "fails when the CLI no longer prints what the page shows, or exits with another code."
- https://github.com/danjdewhurst/story-skills/blob/4b8019d7fa08e1e1866be360fadab2a2f7cbcf11/docs/development.md#L392 "`MARKED` in the test pins how many samples each file marks, so a marker lost in an edit fails it too"

## Issues and changelog
- https://github.com/danjdewhurst/story-skills/issues/689 "and `check:evals` reports 'all eval fixture checks passed'."
  - Broke: a misspelled top-level key in a fixture's checks.json was dropped by the runner, so that check never ran and the fixture still passed. Fixed: #834 exports the allowed keys and fails any other key.
- https://github.com/danjdewhurst/story-skills/issues/834 "Each fix has a test that fails on origin/main for the reason the issue gives."
  - Broke: five eval checker gaps (#689 to #693) let wrong drafts pass, for example present-tense prose passing the past-tense check. Fixed: one PR, each fix with a test shown red on the old main first.
- https://github.com/danjdewhurst/story-skills/issues/745 "A platform, root or missing-tool guard returns before the assertions, so Bun shows the test as passed."
  - Broke: tests whose guard returned early were reported green on systems where they asserted nothing. Fixed: #832 turned about 25 files of guards into `test.skipIf(...)`.
- https://github.com/danjdewhurst/story-skills/issues/747 "The Windows failure in the release item was this kind of check."
  - Broke: an absolute wall-clock limit in a test failed on a loaded Windows runner and blocked the 0.23.0 release. Fixed: #832 replaced absolute limits with growth ratios and a 20-second backstop.

## Lessons
- A skill is measured against a no-skill arm on the fixture's own fact checks, and must beat it by a stated margin per fixture (S10): `baseline_margin` needs no model call. Touches docs/adr/0009-fact-based-ablation-evals.md:14-17; overlap for the pre-change and no-plugin arms; partial: the kit asks only that the post-change plugin beat the no-plugin arm, with no per-case margin; low cost.
- A model judge, when used, sees both drafts unlabelled and in both orders, a split counts as a tie, and a loss is a flag to read the drafts, not a verdict (S10, S8). Touches plugin/tests/skill-contracts.test.mjs:31 (no llm or baseline grader in any case); overlap, the kit keeps judges out entirely; none.
- A comparison that compared nothing, a missing draft or a missing verdict fails, never ties or passes (S8). Touches docs/adr/0010-dev-red-step-and-honest-green.md (void runs recorded apart); overlap; none.
- Model-backed evals stay out of CI because they spend money and cannot pin sampling; they run by hand around a skill change and land in a dated table with model ids and the baseline scores (S9, S24, S30). Touches docs/adr/0010-dev-red-step-and-honest-green.md (results by model); overlap; none.
- Every user-visible change, including skill instructions, lands under `Unreleased` in the same PR, and the release refuses an empty `Unreleased` before any slow check and in `--dry-run` (S3). Touches README.md release steps; gap: the kit keeps no changelog, only the criteria revision log; low cost.
- Command samples in the docs are replayed against the real CLI with their exit codes; a malformed marker fails, and the number of markers per file is pinned so a lost marker fails too (S6, S8). Touches README.md; gap, nothing replays the README's commands; medium cost.
- Every checker fix lands with a test shown failing on the old main for the reason the issue gives, and a guard that cannot run is a skip, not a pass (S8): #834, #832. Touches plugin/tests and the red-before-source grader of ADR 0010; overlap for the dev role; not checked whether the kit's own tests return early on a missing tool; low cost.
- The release keeps the package version and the version pins in shipped workflow templates equal through `check:metadata` in CI (S15). Touches plugin/lib/profile.mjs:147-164; gap: no check compares plugin.json with the release tag; low cost.
