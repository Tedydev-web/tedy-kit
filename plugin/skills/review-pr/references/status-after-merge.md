# Status after merge

## Sweep (step 1a)

Run from any directory the project map covers: `node <plugin>/scripts/merged-sweep.mjs`, or in a review job `node <plugin>/scripts/merged-sweep.mjs --job <this job file>`.

It finds the user's PRs opened, merged or reverted since the last sweep whose body links a work package (`OP#<id>`) assigned to the user, plans each package from all of its PRs (`<plugin>/shared/status-flow.md`), writes one publish card with a `set` command per package and prints `card: <path>`. Mention that path in one line of the reply; it never blocks the review, and `/tedy:pending approve` applies the batch.

With `--job`, the card and each of its `set` commands name the job, so the cockpit applies the batch only after the job is done and does not close the job while the card is open.

## Merge step (step 12)

When a re-review of a teammate's PR leaves no finding, every review thread is resolved, `gh pr checks <n>` passes and the PR is not a draft:

1. From the reviewed repo: `node <plugin>/scripts/op-status.mjs plan <id>... --merging <n>` for every package the PR body links, then each printed `set` command without `--apply`, quoting its preview line.
2. One `AskUserQuestion`, header `merge.header`: `merge.yes` carries in its `preview` the PR, its base branch, the merge method and every status preview line; `merge.no` keeps the PR open. The method is the one the repository allows (`gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed`); when more than one is allowed, the method of its latest merged PRs.
3. On `merge.yes`: `gh pr merge <n> --repo <owner/repo> --<method>` (git-gate asks once more), then `op-status.mjs plan <id>...` again and each `set` command with `--apply --lock <n>`; the merge answer approved those lines.
4. Report the merge commit and each package's new status and assignee in the reply.
