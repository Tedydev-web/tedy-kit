# 0010: The dev skill writes a failing test first and never calls a hollow run green

Status: accepted (2026-10-19)
measured: yes

## Context
- Problem registry P1 (a failing test is written and run before a logic change or bug fix) and P2 (a test is never weakened, skipped or deleted to get green, and a run with zero tests is not green) were "mitigated by: nothing" (`docs/prior-art/problems.md`).
- Sweep 261018-dev screened 188 sources; the four deep-study cards below hold the mechanisms this change draws on. Eleven variants survived the kit's constraints; three bundles were built as eval arms per ADR 0009.
- Arms: A0 the dev steps before this change; A1 A0 plus a Red instruction and four verify lines; A2 A1 plus a script that snapshots test files after the red run and checks them on the commit; A3 A2 plus a PreToolUse hook that denies runner flags which hide failing or missing tests; S A0 plus the script only; H A0 plus the hook only; and the no-plugin arm.
- Cases 1 (bug fix with a cart rounding error) and 2 (new function from a stub) grade P1 by trace facts: a test run or test write before the first source write, and a failing run seen. Cases 3 to 6 grade P2 by file facts: assertion kept, no skip marker, snapshot not re-recorded, spec-backed assertion kept when the user calls it wrong, zero-test run called out.

## Decision
- Build starts with Red: for a bug fix or a change in logic, the test is written and run before the first source edit, fails on an assertion, and its expected values are literals from the request or spec. The new test sits in a new file that stays out of the commit; a tracked team test changes only when the task asks for it.
- Verify adds: a run with 0 tests or a skip in a touched file is not green and the counts are reported; a test is never weakened, skipped or deleted to get green; the change is broken once to watch its test fail. The report carries the red run and the counts. Three rows join the anti-rationalization table.
- The script (A2) and the hook (A3) are not adopted. Neither beat A1 on its own or as an addition: S and H alone left P1 at the A0 level, and A3 against A1 was one run in five better on Opus and one run in five worse on Sonnet.
- The Red text sits at the head of step 4 (Build) instead of a step of its own, so the step numbers that `problems.md` and the cards cite stay valid. The words are those of arm A1.

## Variants

Runs per cell 5, model as named, score is the mean of the case's graders (case 1 / case 2), sd in brackets. Runs with `--allow-tools Write Edit Bash` under the eval sandbox, arms copied outside the home directory so plugin scripts are readable; two earlier batches are void (below).

| arm | Opus 5.5 | Sonnet 5 | Haiku 5.5 |
|---|---|---|---|
| no plugin | 0.33 (0) / 0 (0) | 0.47 (0.16) / 0.13 (0.16) | 0.73 (0.13) / 0.07 (0.13) |
| A0 before | 0.33 (0) / 0 (0) | 0.47 (0.16) / 0.33 (0) | 0.67 (0) / 0 (0) |
| A1 adopted | 0.93 (0.13) / 0.93 (0.13) | 1.0 (0) / 0.93 (0.13) | 1.0 (0) / 0 (0) |
| A2 | 0.87 (0.16) / 1.0 (0) | not run | 1.0 (0) / 0.07 (0.13) |
| A3 | 1.0 (0) / 1.0 (0) | 0.93 (0.13) / 0.93 (0.13) | 1.0 (0) / 0 (0) |
| S script only | 0.47 (0.16) / 0 (0) | not run | 0.67 (0) / 0 (0) |
| H hook only | 0.33 (0) / 0 (0) | not run | 0.67 (0) / 0 (0) |

- A1 on cases 3 to 6, Opus, 3 runs each: every grader 3/3.
- The ported `/tedy:dev` on case 2, Opus, prompt prefixed with `/tedy:dev` because the skill is not model-invocable: run 1 passed 3/3 graders, run 2 wrote and ran the test before the source but showed no failing summary line (0.67); the cost cap stopped run 3. Without the prefix the skill never loads and all 3 runs scored 0. Each run cost about $0.69.
- P2 cases 5 and 6 were piloted on the no-plugin arm (2 runs each on Opus, Sonnet and Haiku): no run weakened a test, so they guard against regression and cannot separate arms. The P2 mechanisms stay unmeasured on small fixtures; their evidence remains the closed issues in the cards.
- Haiku did not write the test first in case 2 under any arm.
- Cost: Opus $8.84, Sonnet $5.90, Haiku $0.28, regression $1.62, pilots $2.80, ported-skill check $1.66. Void batches cost $21.84: Bash failed in the eval sandbox (an AppArmor profile blocked the nested user namespace) and, after that fix, a narrow Bash allow-list denied the first exploratory command in some runs, which then never ran tests.
- The clean P1 signal is case 2's `test-written-before-code` grader: A1 5/5 against A0 0/5 on Opus and on Sonnet, 0/5 for both on Haiku. Case 1's run-before-fix and both cases' red-run-seen can also pass when the suite is run green first and the change is broken afterwards (the break-once line), so they back the result without proving the order on their own. The committed cases now add a `red-before-source` grader (a failing run before the first source write) and prefix each prompt with `/tedy:dev`, so a rerun grades the shipped skill.
- n is 5: the A1 against A0 gap on that grader is well outside run-to-run spread; the A1 against A3 difference is not.

## Prior art

- obra/superpowers (MIT, studied 2026-10-18, via github)
  - card: superpowers
  - https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/test-driven-development/SKILL.md#L34 "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST"
  - https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/verification-before-completion/SKILL.md#L84 "Revert fix"
  - https://github.com/obra/superpowers/issues/1576 "subagent skips TDD entirely"
  - Lesson: test-first holds only when the instruction sits where the agent works, and reverting the fix is the proof the test can fail.
  - Taken: Red at the head of Build and the break-once line in Verify.
- nizos/tdd-guard (MIT, studied 2026-10-18, via github)
  - card: nizos-tdd-guard
  - https://github.com/nizos/tdd-guard/blob/108992dcf7d7f8c90932e8a2cfe22c269f419bc3/src/validation/prompts/rules.ts#L7 "The test must fail for the RIGHT reason (not syntax/import errors)"
  - Lesson: a red caused by an import or compile error proves nothing.
  - Taken: the red must fail on an assertion.
- IonDen/skills (MIT, studied 2026-10-18, via github)
  - card: ionden-skills
  - https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/plugins/ionden-skills/skills/writing-tests-that-can-fail/SKILL.md#L55 "Expected values and boundary inputs are literals from the spec"
  - https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/evals/writing-tests-that-can-fail/README.md#L49 "two of the three Haiku baselines imported the module's constants and asserted `== BASE_FEE`"
  - https://github.com/IonDen/skills/blob/3c26c042ae79e31464a0c7c7b60de84fe38595d3/evals/writing-tests-that-can-fail/README.md#L38 "In fixture F, every baseline run fixed the rounding in the code and left the tests alone"
  - Lesson: tests that derive expected values from the code pass against the bug; and strong models rarely weaken a test on a small fixture, which matches cases 5 and 6 here.
  - Taken: literal expected values. Not taken: a weakening detector, since the baseline gives it nothing to catch on small fixtures.
- avelikiy/great_cto (MIT, studied 2026-10-18, via github)
  - card: great-cto
  - https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/scripts/lib/count-skips.mjs#L5 "`node --test` exits 0 when tests skip, so a step judged by exit code alone"
  - https://github.com/avelikiy/great_cto/pull/82 "it blocks on day one — the tempting "fix" is to weaken the gate"
  - Lesson: exit code 0 hides skips, so green needs the runner's counts.
  - Taken: report passed, skipped and total counts; a skip in a touched file is not green. Not taken: the weakening hook, measured as arm H with no gain.
- fsantibanezleal/CAOS_Batuta (Apache-2.0, studied 2026-10-18, via github)
  - card: caos-batuta
  - https://github.com/fsantibanezleal/CAOS_Batuta/blob/f854580600eddee3612836a9cc324b36c1442420/plugins/batuta/scripts/batuta_lib/tdd_history.py#L327 "a red reports a failing test of its own, not an empty run"
  - Lesson: an empty run is neither red nor green.
  - Taken: a run with 0 tests is not green. Not taken: red/green commit history checks, since the user's tests stay untracked in client repositories.

no social prior art: 2026-10-19 reddit: "Claude Code agent writes tests after code TDD skill failing test first"; x: "Claude Code TDD red green agent skips failing test first"

## What it avoids
Shipping a test that was written after the fix and passes against the bug, and calling a run green when it ran nothing or skipped what the change touched.
