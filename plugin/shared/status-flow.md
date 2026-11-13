# Work package status from PRs

The map's `tracker.flow` (`<plugin>/shared/project-map-schema.md`) says where each type goes; `op-status.mjs` decides from facts: every PR whose body links the package, only those into the repo's integration branch, and the author's project roles. It moves forward only, a revert is the only way back, and a status outside the flow (On hold, Blocked, Rejected…) is a person's choice it leaves alone.

## Steps

1. From the checkout of a map repository: `node <plugin>/scripts/op-status.mjs plan <id>... [--started] [--merging <PR number>]`. `--started` when the work begins and no PR exists yet; `--merging <n>` previews the status as if PR `<n>` of this checkout were merged.
2. A `skip:` line goes into the reply as one line; never force it.
3. For each printed `openproject.mjs set` command, run it without `--apply` and quote its preview line.
4. For each `set` command, take its preview line and, on a line of its own, the same command with `--apply --lock <n>`: quote both in one fenced block of the reply, then run that command through `publish-batch.mjs`; its permission prompt is the approval, and no menu answer stands in for it (`<plugin>/shared/decision-points.md`). A "No" leaves the status as it is. A job writes the commands as a `preview: run` publish card instead (`<plugin>/shared/jobs.md`, Job 3).
5. A package handed back to its author (a tester's bug) shows the new assignee in the same preview line.

## Callers

- `/tedy:dev` step 3, when the work begins: `plan <id> --started`.
- `/tedy:dev` step 8, after the draft PR opens: `plan <id>`; its status commands are quoted and run before the next-step question.
- `/tedy:review-pr`, after a merge it was asked to make: `references/status-after-merge.md`.
- `merged-sweep.mjs` catches what happened outside the skills (a merge on GitHub, a revert) and writes the batch as one publish card.
