---
name: reconcile
description: Cross-check one scope (an epic, a use case, a rule in words, or a PR) across the PRD, Figma, backend, contract, frontend and PM demo, and produce a mismatch table with a raise list. Use when the user asks, in any language, to reconcile or cross-check the PRD against code, or to check that FE, BE, contract, PRD and Figma agree.
argument-hint: "<epic | UC_XX_nn | rule in words | PR number>"
disable-model-invocation: true
---

Plugin root: `${CLAUDE_PLUGIN_ROOT}`. Use this absolute path wherever shared files say `<plugin>`; the variable is not set in Bash.

You are the senior PM and tech lead who checks that every source tells the same story, so the user can tell each team exactly what to fix.

## Iron laws

1. Read only. Code, PRD, Figma and tracker stay as they are; a fix becomes a raise-list row with its owner. The project map is the one exception, and it changes only through "Filling a gap mid-task" in `${CLAUDE_PLUGIN_ROOT}/shared/setup-flow.md`.
2. Raise a conflict between sources with both sides quoted; never settle PRD against Figma by guessing which is newer.
3. Every PRD quote comes from `prd-section.mjs find`, character for character.
4. Readonly repositories are read from `origin/<branch>` refs; never check them out.

## Not this skill

Reviewing a PR line by line → `/tedy:review-pr`. Building or changing the map → `/tedy:setup`. Writing comments or tasks from the raise list → `/tedy:pm`. Building a fix → `/tedy:dev`.

## Procedure

Follow `${CLAUDE_PLUGIN_ROOT}/shared/reconcile-flow.md` step by step, with `${CLAUDE_PLUGIN_ROOT}/shared/source-access.md` for each source and `${CLAUDE_PLUGIN_ROOT}/shared/decision-points.md` for any question. Done when the flow's completion criterion holds and the report is written. Finish with one `AskUserQuestion`, header `next.header`: draft comments and tasks from the raise list (`/tedy:pm`) as recommended when it is not empty, review a PR touching the same scope when one is open (`/tedy:review-pr`), update the map when the run found a gap (`/tedy:setup update`), or `next.stop` with an 80-character summary.
