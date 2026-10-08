---
name: learn
description: Fold what the user corrected in a project into the portable kit - promote repeated feedback from auto memory and the edit log into rules, role references, style samples or the project map, and delete what it replaces. Use when an epic closes, a project's MEMORY.md nears its cap, or the edit rate of a channel drops.
argument-hint: "[project path]"
disable-model-invocation: true
---

Plugin root: `${CLAUDE_PLUGIN_ROOT}`. Use this absolute path wherever shared files say `<plugin>`; the variable is not set in Bash.

You keep the user's working style portable and lean: every lesson lives in exactly one place, and the kit gets shorter as often as it gets longer.

## Iron laws

1. Nothing is written until the user approves the exact diff.
2. Promote a memory only when it repeated at least twice or names a concrete failure.
3. Every promotion deletes its source memory and its `MEMORY.md` line in the same diff.
4. `rules/working-style.md` stays at 55 lines or fewer; going over means merging or dropping an older rule.

## Not this skill

Building or editing the map's sources → `/tedy:setup`. Changing a role's procedure because of a new requirement → edit that skill with the user.

## Procedure

1. **Inputs.**
   - The project's auto memory: `~/.claude/projects/<project path with / as ->/memory/`, every file modified after `learned_until` (`node ${CLAUDE_PLUGIN_ROOT}/scripts/project-state.mjs get learned_until`; empty means every file).
   - The edit log: `node ${CLAUDE_PLUGIN_ROOT}/scripts/edit-rate.mjs`, then the `edited`, `cut` and `added` entries of `~/.local/state/tedy/edit-log.jsonl` since `learned_until`: what the user changed is what the samples get wrong.
2. **Classify each memory** in a table: memory | destination | action | evidence.
   - Personal working rule, true in every project → `${CLAUDE_PLUGIN_ROOT}/../rules/working-style.md`.
   - How a role works → that skill's `references/` or `${CLAUDE_PLUGIN_ROOT}/shared/`.
   - How output reads → `${CLAUDE_PLUGIN_ROOT}/shared/style/*` as a new sample or an Avoid row.
   - A fact about this project → the map (`truth_overrides`, `tracker.rules`, `verify_gotchas`, `team`, `open_questions`).
   - Superseded or wrong → delete.
   - Still project-local and fine where it is → keep.
   Check each claim against its source before promoting it; a memory can be stale.
3. **Subtract.** Delete promoted memories and their `MEMORY.md` lines. Merge rules to stay under the cap. Replace a style sample the edit log shows the user keeps rewriting.
4. **Report.** Write `plans/reports/learn-<yymmdd-hhmm>-<project>.md` in the kit: the table, the full proposed diff, line counts before and after, and broken links in `MEMORY.md` (reported only; the user decides). Quote the table in the reply.
5. **Approve.** One `AskUserQuestion`, header `Học`: `Áp dụng tất cả (Recommended)`, `Chọn từng mục` (a multiSelect follow-up by row number), `Chưa áp dụng`.
6. **Apply** the approved rows, record today with `project-state.mjs set learned_until <YYYY-MM-DD>`, run `claude -p "/doctor prompt-audit"` and fix any new conflict it names, then commit and push the kit (`feat: fold <project> lessons into the kit`).
7. **Next step.** `Bước tiếp`: run the role whose material changed on real work, or `Dừng ở đây` with an 80-character summary.

## Done

Every memory newer than `learned_until` has a row and an action, each promotion removed its source, the rules file is within its cap, the prompt audit is clean, and `learned_until` moved.
