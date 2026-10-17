# 0004: Every pull request follows one work package

Status: accepted (2026-10-08 to 2026-10-14, recorded 2026-10-17)

## Context
- 2026-10-08: another tracker skill drafted work packages with function and file names, no estimates, and backend tasks nobody asked for.
- 2026-10-14: a pull request merged with an empty body, and the bug it fixed never moved on the tracker.
- 2026-10-14: the tracker's own GitHub tab showed no pull request for a package that was linked to one.

## Decision
- In a mapped project, the kit's tracker rules win over another tracker skill's defaults (rule 19).
- Every PR points to exactly one work package: the body starts with `OP#<id>` and carries the package's goal, checklist and acceptance criteria as read at a stated time; no package means a hand-off to the PM session first (rule 21).
- PRD and Figma say what the product must be, the package says what one person builds now; a mismatch stops that part until the PM session writes the user's choice into the package (rule 22).
- The review session reads every package the PR body points to (`OP#<id>`, a work package link, or a five-digit `#id` next to the word OP) and hands drift to the PM session (rule 23).
- A package that changed after the PR opened means reconcile again and refresh the body; closed or rejected means stop and ask; a PR closed without merge means ask whether to drop the package or open a new PR (rule 24).
- Status moves only through one batch hand-off from review to PM and one approval: `In progress` when the PR opens, the map's `merge_status` after merge, back to `In progress` or `Re-Work` after a revert (rule 25).

## Enforcement
git-gate denies `gh pr create` without `OP#<id>`; `pr-body`, `reconcile` and `merged-sweep` carry the details of rules 22, 24 and 25.

## What it avoids
PRs the tracker cannot see, and packages that silently disagree with the PRD.
