---
name: button-inc/batten
pinned: https://github.com/button-inc/batten/tree/95e2f6aaef1370c1fcfbaa806a4652f25384aadd
license: Apache-2.0
studied: 2026-10-18
channel: github
---

# button-inc/batten

## Evidence
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/README.md#L9 "the tests were edited until they passed"
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/crates/batten/src/replay.rs#L1 "Replay each modified test's BASE form against HEAD"
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/crates/batten/src/replay.rs#L9 "it asserts what the base asserted"
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/crates/batten/src/replay.rs#L15 "its base body is spliced into HEAD's tree and run."
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/crates/batten/src/replay.rs#L18 "could-not-look, never a finding."
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/crates/batten/src/replay.rs#L19 "present at base and gone at HEAD is `test-removed`"
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/crates/batten/src/replay.rs#L21 "An ADDED test is never replayed"
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/crates/batten/src/replay.rs#L28 "only through the `asked` ledger"
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/batten.toml#L5888 "id = "test count dropped""
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/batten.toml#L6011 "a disabled test is a deleted test that still counts"
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/batten.toml#L6023 "THE LITERAL SEES ONE SPELLING OF FOUR"
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/batten.toml#L5924 "a suite quietly gutted was indistinguishable from a"
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/crates/batten/src/checks_green.rs#L50 "Absent is not skipped, and absent is not an answer"
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/crates/batten/src/checks_green.rs#L511 "MEMBERSHIP, NOT A LITERAL PAIR (CLOUD-376)."
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/crates/batten/src/checks_green.rs#L287 "A COMPLETED-BUT-UNANSWERED RUN NEVER DISPLACES A REAL VERDICT"
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/crates/batten/src/checks_green.rs#L293 "the copy that does not apply concludes `skipped`."
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/crates/batten/src/checks_green.rs#L33 "Red and pending collapse onto one code deliberately."
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/crates/batten/src/semver.rs#L60 "const VACUOUS: &str = " 0 checks:";"
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/rules/rust.md#L41 "A missing tool is a failure, and a missing subject is a `cfg!` arm."
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/rules/rust.md#L44 "when it finds none passes"
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/rules/rust.md#L49 "Flakes are fixed, never retried."
- https://github.com/button-inc/batten/blob/95e2f6aaef1370c1fcfbaa806a4652f25384aadd/crates/batten/src/checks_green.rs#L332 "//MUTANT unanswered-displaces-a-verdict"

## Issues and changelog
- https://github.com/button-inc/batten/pull/1122 "the replay built the checkout's own HEAD test and passed every narrowed expectation"
  - Broke: the first replay spawned through a runner that inherited the caller's working directory, so it ran the checkout's HEAD test instead of the spliced base test and passed every narrowed expectation. Fixed before merge: the replay spawns in the scratch tree's root; the tier case `a_narrowed_expectation_is_refused_by_name` caught it.
- https://github.com/button-inc/batten/pull/1178 "GitHub reports a job skipped by its own `if:` as success"
  - Broke: the only required check, `final`, read `always() && draft == false`, so every draft push wrote a passing `final` and a commit reached `main` with no CI run. Fixed: `final` is `if: always()` and asserts red on a draft; `ci-parity` refuses any other condition on the fan-in (`job skip loose`).
- https://github.com/button-inc/batten/pull/347 "Judged as a union, the residue vetoes a verdict that already exists."
  - Broke: a draft PR's `skipped` check-runs stayed on the SHA beside the real runs, so a green head polled forever and once a completed failure went unseen. Fixed: only a name's newest run speaks for it; unorderable rows resolve to the least conclusive member.
- https://github.com/button-inc/batten/pull/936 "`started_at` stops tracking event order once two events for one head are in flight together."
  - Broke: a `skipped` twin started after the real run, so a red head read as "no verdict" for 30 minutes and a green head was polled 3600 times. Fixed: a name's runs are ordered by `completed_at`, which the check-runs projection already carries. A later incident (checks_green.rs L291-L300, a skipped twin one second after a success) added the rule that a completed-but-unanswered run never displaces a real verdict.
- https://github.com/button-inc/batten/pull/302 "A cancelled run judged nothing."
  - Broke: `cancelled` was bucketed with `failure`, so a concurrency-cancelled run read as red and the landing loop re-drafted on a stale set it could not replace. Fixed: `cancelled` joins `skipped` as no verdict; any conclusion outside the declared answered set is no verdict.
- https://github.com/button-inc/batten/pull/1096 "`silent_skip.rs` refuses a bare `return` in a test."
  - Broke: 37 test cases returned early when a tool was missing and passed, reporting coverage the leg did not have. Fixed: a missing tool fails through `require_tool`, a platform subject is a `cfg!` arm, test retries are refused in runner config.
- https://github.com/button-inc/batten/pull/1209 "it refused a surviving mutant in this change's own new code"
  - Broke: nothing shipped; the admission gate (mutants of the changed diff run in `verify`) found a test that did not cover new code on the PR itself. Fixed: the code under the surviving mutant, before merge.
- CHANGELOG.md holds only the Keep a Changelog header; release notes live in release PRs, so the PRs above are the failure record.

## Lessons
- Replay the base form of each changed test against the new code, and send a failure to the owner as a question rather than a red: touches `plugin/skills/dev/SKILL.md:37` (verify on the commit) and `:47` (anti-rationalization row: "I only adjusted the assertion to match"); gap; cost medium for team-tracked tests (file-level, not per test: `git show origin/<integration>:<file>` into a scratch worktree at HEAD, run that file; a failure is a changed expectation the user rules on, because a task can legitimately change behaviour), cost high to go per test as batten does. Client repos keep the user's tests untracked, so the integration branch holds no base form for them; there the only base is a snapshot the kit takes at the proven-red run (P1), replayed at step 6, which also proves the red test was not edited to pass. Build the snapshot half first; it is the only half that covers local tests.
- Ratchet the test count and the skip count against the base: touches `plugin/lib/push-report.mjs:47-58` (already diffs `start..HEAD` per file for comments); gap; cost low for tracked tests. Count every spelling (`it`/`test`, `.skip`, `.only`, `.todo`, `xit`, `xdescribe`, `--passWithNoTests`), anchored so prose does not count (batten measured 5 hits in a tree with zero disabled tests, and its literal saw one spelling of four). A blanket waiver made a gutted suite look like a retirement; any allowed drop names the test it replaces. Local untracked tests are invisible to this diff; they need the same snapshot as above.
- A zero-test run is not green: touches `plugin/skills/dev/SKILL.md:37`; gap; cost low (the verify output must show a test count above zero for the touched module; `--passWithNoTests` or a filter matching nothing is a refusal). Batten's nearest form is `semver.rs` refusing a ` 0 checks:` run; it has no test-runner equivalent in the files read.
- Skipped, cancelled, neutral or absent CI checks are no answer, judged latest run per name: touches `plugin/skills/dev/SKILL.md:39` (the draft-PR step, where a future `gh pr checks` reader would sit); gap, no reader today (the kit reads no check conclusions anywhere in `plugin/`). Cost low once a skill reads `gh pr checks`: count only declared passing conclusions, treat every other conclusion as no verdict, and remember #1178, a job skipped by its own `if:` can register as a passing required check. Record now, build when a reader exists.
- A test that returns early or probes and bails passes silently: touches `plugin/agents/reviewer.md:26` (bugs lens) and `:27` (standards); gap; cost low (one lens line). The reviewer sees only the tracked diff, so local tests need the dev self-check at step 6.
- Flakes are fixed, never retried: touches `plugin/agents/reviewer.md:27`; gap; cost low (a new `retry`/`retries`/`retryTimes` in runner config is a finding).
- Mutation of the changed diff proves the tests cover it (#1209): overlap with the obra/superpowers card's revert-the-fix lesson at `plugin/skills/dev/SKILL.md:37`; no change beyond it; `cargo-mutants`-style tooling for JS (Stryker) is cost high and out of scope.
- Surface, base-test replay: a script run from step 6 of the dev skill (skill line), optionally a PreToolUse deny on `git push`. #1122 is an implementation trap, not a disqualifier: a Bash-driven replay in a worktree inherits cwd the same way, so its first test is a fixture whose narrowed expectation must be refused. Survives.
- Surface, test and skip ratchet: the existing PostToolUse push-report (report only), or PreToolUse on `git push` to deny. The one-spelling and blanket-waiver failures are design traps; none disqualifies it. Survives for tracked tests; local tests only through the snapshot.
- Surface, zero-test refusal: skill line in step 6. No failure mode found. Survives.
- Surface, skipped-check rule: skill line in whichever skill first reads `gh pr checks`. #1178, #347, #936 and #302 are reader bugs batten fixed, not disqualifiers. Survives, deferred until a reader exists.
- Surface, silent skip and retries: reviewer agent lens lines. No disqualifier. Survives.
