# Status after merge

Run from the project root: `node <plugin>/scripts/merged-sweep.mjs --handoff --from "<this session's name>"`.

It finds the user's PRs opened, merged or reverted since the last sweep whose body links a work package (`OP#<id>`) assigned to the user, and writes one hand-off asking the PM session to move each to the map's `tracker.open_status` (still not started), `merge_status` or `revert_status`.

When it prints a `message:` line, `SendMessage` the PM session with that line exactly, without the `handoff.header` question: this batch covers only the user's own work packages, and the PM session still asks `approve.header` before any status changes.

Mention the hand-off in one line of the reply; it never blocks the review.
