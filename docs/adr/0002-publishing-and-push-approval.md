# 0002: Publishing, pushing and asking go through the user

Status: accepted (2026-10-07 to 2026-10-08, recorded 2026-10-17)

## Context
- Text posted under the user's name was read as theirs; they answer for every word.
- 2026-10-07: open review threads were the user's checklist. Threads resolved by an agent disappeared from it before the fix was checked.
- 2026-10-08: draft PRs were opened after the user had asked only for a report ("noted lại cho tôi biết", "báo cáo"), and had to be withdrawn.
- A push from a dirty working tree once broke the shared `dev` branch.
- Questions asked in prose left the user typing answers in 20-35% of past turns, and many were never answered.

## Decision
- Everything published under the user's name starts as a draft and goes out after approval (rule 3).
- Merging and resolving threads belong to the user (rule 4).
- Finished work in a project repo goes out as a branch plus a draft PR; report-only words mean nothing is pushed; ready, merge, integration-branch push and force-push belong to the user; tedy-kit itself is pushed to main after each approved change (rule 5).
- Push only from a clean tree (rule 11).
- Decisions are asked with AskUserQuestion, and a timeout takes the recommended option only for local, reversible choices (rules 13-15).

## Enforcement
git-gate asks on merge, ready and integration-branch pushes and on a dirty tree; the no-comments gate reports after a push. The rules keep only the instruction and the reason.

## What it avoids
Withdrawn PRs, a broken `dev`, threads closed before the fix was verified, and unanswered questions.
