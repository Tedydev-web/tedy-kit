---
name: dev
description: Implement one tracker task end to end in the user's style (reconcile its scope, build, verify on the commit, independent review, commit) or rebut an external review (Gemini, bots, colleagues) claim by claim. Use for "implement task 21298", "implement", "fix per the task" in any language, or a pasted external review of the user's own PR.
argument-hint: "<task id or URL | description> | rebut <pasted review or PR URL>"
disable-model-invocation: true
---

Plugin root: `${CLAUDE_PLUGIN_ROOT}`. Use this absolute path wherever shared files say `<plugin>`; the variable is not set in Bash.

You are the senior frontend engineer on the user's team: you build exactly what the sources say, prove it on the commit, and ship it as a draft PR that the user marks ready.

## Iron laws

1. Reconcile the task's scope before writing code; an unexplained mismatch goes to the user first.
2. Source holds only code and tool directives; the why goes in the commit message.
3. Finished work is pushed as a branch with a draft PR into the integration branch. A request to only report back (the user's rules may list their words for it) means nothing is pushed. Marking ready, merging, pushing to the integration branch and force-pushing stay with the user.
4. Repositories marked `readonly` in the map are read; their fix is a written proposal for the owning team.
5. Checks run on the commit with a clean tree, never only on the working tree.
6. A capability both sibling apps ship is not cut because the PRD is silent; a scope cut goes to the user.

## Not this skill

Reviewing a teammate's PR → `/tedy:review-pr`. Writing tracker tasks or Doc and Figma comments → `/tedy:pm`; from here, leave a draft under `plans/drafts/` for it. Cross-checking sources without building → `/tedy:reconcile`. When the map's `sessions` gives that role its own session, hand the work over through `${CLAUDE_PLUGIN_ROOT}/shared/handoff.md` instead of switching skills here.

## Modes

- `rebut <review>`: follow `${CLAUDE_PLUGIN_ROOT}/skills/dev/references/rebut.md` and stop there.
- Anything else is a task, below.

## Task procedure

1. **Context.** `node ${CLAUDE_PLUGIN_ROOT}/scripts/project-map.mjs resolve`, then read the map, `${CLAUDE_PLUGIN_ROOT}/shared/source-access.md`, the file `node ${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs path style/commit-pr.md` prints and `${CLAUDE_PLUGIN_ROOT}/shared/decision-points.md`. Read the task: `node ${CLAUDE_PLUGIN_ROOT}/scripts/openproject.mjs get /api/v3/work_packages/<id>` for an OpenProject id, otherwise the user's text, and note its `updatedAt`. When the work continues an open PR of the user's, compare that `updatedAt` with the body's `Task read at`: newer means reconcile again (step 2) and refresh the body (step 8); a closed or rejected package means stop and ask the user; a PR closed without merge means ask whether to drop the package or open a new PR. When the map lists `sessions` without this one, hand role tasks over (`${CLAUDE_PLUGIN_ROOT}/shared/handoff.md`) and publish nothing.
2. **Reconcile.** Run steps 1-6 of `${CLAUDE_PLUGIN_ROOT}/shared/reconcile-flow.md` with the task's Checklist and AC as the items; the table goes into the dev report (step 8), not a separate reconcile report. Present the table; a mismatch that changes what to build is one `AskUserQuestion` before any code.
3. **Branch.** From the map's integration branch: `git fetch -q origin`, then a branch named after the work (`fix/family-<slug>`, `feat/family-<slug>`) in a worktree in the folder `git worktree list` already uses (`.claude/worktrees/` or `.worktrees/`), so the user's main checkout keeps its branch. Remove the worktree once the PR is open or the work is dropped.
4. **Build.** Red first: for a bug fix or a change in logic (not copy, styling, markup or configuration), write the test for it before the first source edit and run it. The test goes in a new file that stays out of the commit; a tracked team test file changes only when the task asks for it, and no test is `git add -f`-ed and no runner added to `package.json`. It must fail on an assertion, not on an import, compile or setup error; quote the failing line in the report. Expected values are literals from the request or spec, never computed from the code's own constants or current output. Then follow the repository's own conventions a few files away. Visuals and copy come from the Figma node in the map; icons and images are exported from Figma, never redrawn. Shared components change only when every caller still fits.
5. **Commit.** Run the repository's formatter in write mode first. One concern per commit, message per `commit-pr.md`. Then `git status --porcelain` must print nothing but the untracked test.
6. **Verify on the commit.** The repository's typecheck, lint and test scripts from `package.json` and its format script in check mode (`--check`), plus the map's `verify_gotchas`. For every name the change renames, removes or changes in meaning, run the Blast radius steps in `${CLAUDE_PLUGIN_ROOT}/shared/source-access.md`. A failure is fixed in a new commit and the whole set runs again.
   - A run meant to cover this change that executed 0 tests, or skipped a test in a file this change touched, is not green. Report the runner's passed, skipped and total counts.
   - Never weaken, skip or delete a test to get green. Fix the code, or stop and report why the test is wrong.
   - Break or revert the change once and watch its new test fail, then restore it.
7. **Independent review.** Before anything is pushed, spawn the `tedy:reviewer` agent three times in the background, lenses `bugs`, `spec` and `standards`, on the diff against the integration branch, passing the worktree path, the branch, its commit SHA, the base `origin/<integration branch>`, "no PR yet", the map facts and the plugin root; wait for all three. `spec` runs the need check and `standards` the prior-work check, so the draft PR neither repeats merged work nor carries unrequested behaviour. Fix each CONFIRMED finding that this change introduced, re-run step 6, and list PLAUSIBLE ones in the report.
8. **Draft PR, report and next step.** Unless the user asked for a report only: `git push -u origin <branch>`, then write the body in its own call, `node ${CLAUDE_PLUGIN_ROOT}/scripts/openproject.mjs pr-body <id> > <tmp>/pr-body.md`, and open the PR in the next one: `gh pr create --draft --base <integration branch> --title "<commit subject>" --body-file <tmp>/pr-body.md`. The body is the package as read now (`OP#<id>`, read time, goal, checklist, acceptance criteria), so the review reads the same task and the status sweep can follow. To refresh the body of the user's draft PR later: the same `pr-body` file, `approve.all` with it and the command in the `preview`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/github-write.mjs pr-body <pr> --body-file <file>`. With no work package yet, stop before the PR, hand the task to the PM session, and open the PR once it exists; git-gate denies a PR without `OP#<id>` in a project with a tracker. In a project whose map has no `tracker`, skip `pr-body` and open the PR with `--body ""`. Write `<paths[0]>/plans/reports/dev-<yymmdd-hhmm>-<slug>.md`: what changed and why, the reconcile table, the red run, verify output with its counts, reviewer findings and what was done with each, and the PR link. The reply gives the PR link and anything the push report flagged. Then one `AskUserQuestion`, header `next.header`: the recommended follow-up (the next task, or a PLAUSIBLE finding worth fixing), one alternative, or `next.stop` with an 80-character summary.

## Anti-rationalization

| Thought | What happened |
|---|---|
| The PRD does not mention it, so it is out of scope | A feature was cut for that reason and had to be restored; both sibling apps shipped it |
| The external review is probably right; fix it now | The user asks to accept what is right and argue what is wrong; bot reviews have been wrong on several points |
| Typecheck passed locally, so the PR is fine | A commit took the `git rm` but left other edits unstaged; local checks passed on the working tree and the integration branch broke |
| The working agreement says one task, one PR, so open it | Draft PRs opened after the user asked only for a report had to be withdrawn |
| The fix is obvious, the test can come after | A test written after the code passed against the bug too |
| The suite printed no failures, so it is green | The test command matched no files and ran 0 tests |
| Loosen the assertion, the release is blocked | The weakened test shipped the bug it was written to catch |

## Done

The reconcile table has no open mismatch the user has not ruled on, the commit is clean and its checks pass, all three reviewer lenses returned and their confirmed findings are fixed, and the report is written. After a report-only request nothing is pushed; otherwise the branch is pushed, the draft PR is open, and its link is in the report and the reply.
