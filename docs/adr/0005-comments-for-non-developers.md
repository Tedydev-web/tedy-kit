# 0005: Doc and Figma comments speak to non-developers

Status: accepted (2026-10-15, recorded 2026-10-17)

## Context
- The PM and the designer are not developers. PRD, Figma and the PM are the source of truth.
- Comments that explained implementation were noise to them and hid the actual question.
- A scope cut justified by "the PRD was silent" once had to be reverted.

## Decision
- A Doc or Figma comment reads like a quick teammate chat and names only a business rule that changes, or a place that is missing, wrong, redundant, contradictory or infeasible in what the app user sees. Implementation notes stay in the draft's note for the user (rule 2).
- Any scope cut that touches an existing rule goes to the user (rule 8).

## What it avoids
Comments the PM cannot act on, and reverted scope cuts.
