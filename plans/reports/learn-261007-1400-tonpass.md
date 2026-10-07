# Learn run 1: tonpass (2026-10-07)

First `/tedy:learn` run, done by hand as the plan asks, over the 32 memories in `~/.claude/projects/-home-tedydev-Documents-workspace-tonpass/memory/`.

## Outcome

- 14 memories are already carried by the kit (checked by grep against the destination files). They are candidates for deletion.
- 18 stay in the project: they are facts about Family Wallet or the workspace, and auto memory is what every tonpass session loads, while the map is read only when a `/tedy:*` skill runs.
- Two memories written today changed the kit in this run: new PRD questions are anchored or handed off in an HTML file (never an unanchored or misplaced comment), and OpenProject writes refuse a work package edited after the preview. Tracker, Doc and Figma writes belong to `/tedy:pm`; `/tedy:dev` and `/tedy:review-pr` leave drafts for it.
- `rules/working-style.md` stays at 32 lines (cap 55); nothing new was needed there.
- `MEMORY.md` has 12 links to files that no longer exist.

## Promote and delete (14)

| Memory | Now carried by |
|---|---|
| user-address-anh-em | rules 1 |
| comment-tone-casual-texting | rules 2, `shared/style/doc-figma-comment.md` |
| commit-verify-clean-tree | rules 11, git gate, `shared/style/commit-pr.md`, `/tedy:dev` |
| no-code-comments | rules 10, comment gates |
| no-pr-without-explicit-go | rules 5, `/tedy:dev`, `commit-pr.md` |
| pr-comments-hint-not-solution | `shared/style/pr-comment.md`, `/tedy:review-pr` |
| openproject-fe-scope-only | map `tracker.rules`, `tracker-task.md`, `/tedy:pm` iron law 3 |
| openproject-no-estimate-or-dates | map `tracker.rules`, `tracker-task.md`, `tracker-openproject.md` |
| openproject-split-ui-and-wire | map `tracker.rules`, `tracker-task.md`, `/tedy:pm` iron law 3 |
| openproject-task-altitude-pm-not-code | `tracker-task.md`, `/tedy:pm` iron law 2, `task-lint.mjs` |
| openproject-status-workflow-limits | `tracker-openproject.md`, map `tracker.rules` |
| raise-prd-api-conflicts-proactively | rules 7, reconcile flow |
| prd-comments-via-file-not-wrong-thread | `comment-channels.md`, `/tedy:pm` steps 4 and 7 |
| single-writer-session-for-op-doc-figma | `/tedy:pm` iron law 6, `/tedy:dev` and `/tedy:review-pr` hand-off lines, `openproject.mjs` preview lock |

## Keep in the project (18)

family-admin-local-setup, family-wallet-activity-fields-unfilled, family-wallet-assignment-split, family-wallet-figma-over-prd-when-newer, family-wallet-handover-as-role-change, family-wallet-member-key-lowest-wallet, family-wallet-member-limit-lowering, family-wallet-membership-vote-rules, family-wallet-plan-config-owner, family-wallet-prd-and-toasts, family-wallet-project, family-wallet-setmembers-one-pin, family-wallet-timezone-utc, family-wallet-working-agreements, giftcard-redeem-convert-review, no-be-code-edits, stamp-per-space-waiting-be, worktree-tsc-core-resolution.

## Broken links in MEMORY.md (12)

agent-instruction-architecture, agentkit-migration, failed-cache-disk, tool-config-surface, repository-harness-setup, repo-proof-commands-and-gotchas, gkg-coverage-limits, caveman-install, tonpass-workspace-layout, giftcard-buy-backend-decision, no-cloud-artifacts, global-gitignore-excludes-tests. Their files are gone; the index lines still load into every tonpass session.

## The decision this run leaves to the user

The three original sessions (Dev, Review PR, PM) still run without the kit and lean on these memories. Deleting the 14 now removes those rules from those sessions unless they call a `/tedy:*` skill; keeping them until the sessions are retired keeps one lesson in two places for a while.

## Applied (user decision, 2026-10-07)

- The 14 carried memories stay until the three original sessions are retired; a later `/tedy:learn` deletes them in one pass.
- The 12 broken lines were removed from `MEMORY.md` (backup `MEMORY.md.bak-261007-learn`); every remaining line points to an existing file.
