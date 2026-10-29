# Work package status from PRs

The map's `tracker.flow` (`<plugin>/shared/project-map-schema.md`) says where each type goes; `op-status.mjs` decides from facts: every PR whose body links the package, only those into the repo's integration branch, and the author's project roles. It moves forward only, a revert is the only way back, and a status outside the flow (On hold, Blocked, Rejected…) is a person's choice it leaves alone.

## Steps

1. From the checkout of a map repository: `node <plugin>/scripts/op-status.mjs plan <id>... [--started] [--merging <PR number>]`. `--started` when the work begins and no PR exists yet; `--merging <n>` previews the status as if PR `<n>` of this checkout were merged.
2. A `skip:` line goes into the reply as one line; never force it.
3. For each printed `openproject.mjs set` command, run it without `--apply` and quote its preview line.
4. The preview lines ride in the question the calling step already asks, and the user's yes there approves them; where no question is due, one `AskUserQuestion` with header `approve.header` holds them. Then run each command again with `--apply --lock <n>`.
5. A package handed back to its author (a tester's bug) shows the new assignee in the same preview line.

## Callers

- `/tedy:dev` step 3, when the work begins: `plan <id> --started`.
- `/tedy:dev` step 8, after the draft PR opens: `plan <id>`; the preview lines ride in the next-step question.
- `/tedy:review-pr`, after a merge it was asked to make: `references/status-after-merge.md`.
- `merged-sweep.mjs` catches what happened outside the skills (a merge on GitHub, a revert) and hands the batch to the PM session.
