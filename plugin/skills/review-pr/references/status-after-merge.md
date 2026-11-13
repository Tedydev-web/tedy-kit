# Status after merge

## Sweep (step 1a)

Run from any directory the project map covers: `node <plugin>/scripts/merged-sweep.mjs`, or in a review job `node <plugin>/scripts/merged-sweep.mjs --job <this job file>`.

It finds the user's PRs opened, merged or reverted since the last sweep whose body links a work package (`OP#<id>`) assigned to the user, plans each package from all of its PRs (`<plugin>/shared/status-flow.md`), writes one publish card with a `set` command per package and prints `card: <path>`. Mention that path in one line of the reply; it never blocks the review, and the cockpit asks the card like every open card (`<plugin>/shared/jobs.md`, Cockpit 5).

With `--job`, the card and each of its `set` commands name the job, so the cockpit applies the batch only after the job is done and does not close the job while the card is open.

## Merge step (step 12)

When a re-review of a teammate's PR leaves no finding, every review thread is resolved, `gh pr checks <n>` passes and the PR is not a draft:

1. From the reviewed repo: `node <plugin>/scripts/op-status.mjs plan <id>... --merging <n>` for every package the PR body links, then each printed `set` command without `--apply`, quoting its preview line.
2. One `AskUserQuestion`, header `merge.header`: `merge.yes` approves the merge alone, and its `preview` carries the PR, its base branch, the merge method and every status preview line; `merge.no` keeps the PR open. The method is the one the repository allows (`gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed`); when more than one is allowed, the method of its latest merged PRs.
3. On `merge.yes`: `gh pr merge <n> --repo <owner/repo> --<method>` (git-gate asks once more). Once it has merged, `op-status.mjs plan <id>...` again, each printed `set` command without `--apply`, then per `<plugin>/shared/status-flow.md` step 4 show that dry run's line and run the command with `--apply --lock <n>`; its permission prompt is the approval.

In a job, which cannot ask, steps 2 and 3 become one publish card (`shared/jobs.md`, Job 3), `preview: ready`, no `--draft`: block 1 is exactly `gh pr merge <n> --repo <owner/repo> --<method>`, followed by the PR, its base branch and the merge method; each later block is one `set` command of the step 1 plan with `--apply --lock <n> --job <this job file>`, followed by its preview line. The cockpit runs the blocks in order, so a status moves only after the merge; git-gate's merge ask and each `set` prompt are the approvals.
4. Report the merge commit and each package's new status and assignee in the reply.
