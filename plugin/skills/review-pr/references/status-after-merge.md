# Status after merge

## Sweep (step 1a)

Run from any directory the project map covers: `node <plugin>/scripts/merged-sweep.mjs`.

It finds the user's PRs opened, merged or reverted since the last sweep whose body links a work package (`OP#<id>`) assigned to the user, plans each package from all of its PRs (`<plugin>/shared/status-flow.md`), writes a ready batch with one `set … --apply --lock <n>` item per package to `plans/drafts/<stamp>-status-from-prs.json`, and prints an `update #<id> …` line per package, `batch: <path>` and the `publish-batch.mjs <path> --summary` command. It never blocks the review. When it printed a batch, run that `--summary` command, show each `update` line as the item (`<plugin>/shared/decision-points.md`) and run the `--shows` command it prints in the same turn; its permission prompt is the approval. Then `pending.mjs done <path>`. A "No" leaves the statuses as they are and the batch in `plans/drafts/`; a `set` refused because the work package moved past its lock needs the sweep's plan again (`<plugin>/shared/status-flow.md`).

## Merge step (step 12)

When a re-review of a teammate's PR leaves no finding, every review thread is resolved, `gh pr checks <n>` passes and the PR is not a draft:

1. From the reviewed repo: `node <plugin>/scripts/op-status.mjs plan <id>... --merging <n>` for every package the PR body links, then each printed `set` command without `--apply`, quoting its preview line.
2. One `AskUserQuestion`, header `merge.header`: `merge.yes` approves the merge alone, and its `preview` carries the PR, its base branch, the merge method and every status preview line; `merge.no` keeps the PR open. The method is the one the repository allows (`gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed`); when more than one is allowed, the method of its latest merged PRs.
3. On `merge.yes`: `gh pr merge <n> --repo <owner/repo> --<method>` (git-gate asks once more). Once it has merged, `op-status.mjs plan <id>...` again, each printed `set` command without `--apply`, then per `<plugin>/shared/status-flow.md` step 4 show that dry run's line and run the command with `--apply --lock <n>`; its permission prompt is the approval.
4. Report the merge commit and each package's new status and assignee in the reply.
