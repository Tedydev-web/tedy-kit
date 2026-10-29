# Status after merge

## Sweep (step 1a)

Run from any directory the project map covers; the hand-off lands under the map's `paths[0]/plans/reports/`: `node <plugin>/scripts/merged-sweep.mjs --handoff --from "<this session's name>"`.

It finds the user's PRs opened, merged or reverted since the last sweep whose body links a work package (`OP#<id>`) assigned to the user, plans each package from all of its PRs (`<plugin>/shared/status-flow.md`), and writes one hand-off asking the PM session to apply the batch.

When it prints a `message:` line, `SendMessage` the PM session with that line exactly, without the `handoff.header` question: this batch covers only the user's own work packages, and the PM session still asks `approve.header` before any status changes.

Mention the hand-off in one line of the reply; it never blocks the review.

## Merge step (step 12)

When a re-review of a teammate's PR leaves no finding, every review thread is resolved, `gh pr checks <n>` passes and the PR is not a draft:

1. From the reviewed repo: `node <plugin>/scripts/op-status.mjs plan <id>... --merging <n>` for every package the PR body links, then each printed `set` command without `--apply`, quoting its preview line.
2. One `AskUserQuestion`, header `merge.header`: `merge.yes` carries in its `preview` the PR, its base branch, the merge method and every status preview line; `merge.no` keeps the PR open. The method is the one the repository allows (`gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed`); when more than one is allowed, the method of its latest merged PRs.
3. On `merge.yes`: `gh pr merge <n> --repo <owner/repo> --<method>` (git-gate asks once more), then `op-status.mjs plan <id>...` again and each `set` command with `--apply --lock <n>`; the merge answer approved those lines.
4. Report the merge commit and each package's new status and assignee in the reply.
