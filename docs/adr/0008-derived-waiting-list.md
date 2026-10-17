# 0008: The waiting list is derived from the work, not kept by hand

Status: accepted (2026-10-17)

Supersedes: the `plans/VIEC-CHO-ANH.md` ledger in 0003.

## Context
- The hand-kept ledger drifted from the files it listed: in one multi-repo project 17 of 40 pending paths no longer opened (15 lived in sub-repositories, 2 had been archived without updating the row), and 4 rows marked posted or sent still sat under pending.
- Every drift came from writing the same state twice, once on the item and once in the ledger. A reminder or a doctor check would only make the second write more frequent.
- Trackers built for agents and humans (beads `human` gates, GitHub draft PRs and review requests, LangGraph interrupts, Backlog.md task status) keep the waiting state on the item and query the list.

## Decision
- A draft waiting on the user lives in `plans/drafts/` of its project or repository; an action with no file gets a one-line stub there.
- `pending.mjs list` derives the list from hand-offs still `pending`, files in `plans/drafts/` of the project and its writable repositories, branches that track a live upstream or are checked out, counted by their commits on no remote, and open draft PRs by the user. Session start prints the local part; `/tedy:pending` prints all of it.
- `pending.mjs done <file>` moves a finished draft to `plans/archive/` under the same relative path and logs the move in `plans/archive/MOVES.tsv`.

## What it avoids
A second copy of the waiting state that goes stale, and paths that point into the wrong repository.
