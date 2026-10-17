# 0003: One role per session, one list of what waits on the user

Status: accepted (2026-10-09 to 2026-10-15, recorded 2026-10-17)

## Context
- Several sessions (PM, Dev, review) wrote to the same tracker, Doc and Figma file, and the record drifted.
- 2026-10-09: drafts from three sessions were scattered across several `plans` folders, and the user could no longer tell what was still pending.
- 2026-10-09: the review session may send the status-after-merge batch for the user's own work packages without asking first; the PM session still asks before changing any status.
- 2026-10-15: the dispatch session does no role work and hands every request to its owner without asking.

## Decision
- Each session keeps to the role its project map names; a request for another role is handed over through `shared/handoff.md` after an AskUserQuestion, with the two exceptions above (rule 18).
- Every item waiting on the user gets one row in `plans/VIEC-CHO-ANH.md` under the map's first path, written in the same turn. When the item is done its row moves to "Đã xong gần đây" with the resulting ids, its files move to `plans/archive/` with a `from<TAB>to` line in `plans/archive/MOVES.tsv`, and any memory note pointing at the old path is updated. Every session writes to this one file and creates it when missing (rule 20).

## Enforcement
The role gate asks before a write that belongs to another role. Rule 20 has no check.

## What it avoids
Two writers on one record, and pending items the user cannot find.
