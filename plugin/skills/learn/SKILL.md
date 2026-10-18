---
name: learn
description: Fold what the user corrected in a project into the portable kit - promote repeated feedback from auto memory and the edit log into rules, role references, style samples or the project map, and delete what it replaces. Use when an epic closes, a project's MEMORY.md nears its cap, or the edit rate of a channel drops.
argument-hint: "[project path]"
disable-model-invocation: true
---

Plugin root: `${CLAUDE_PLUGIN_ROOT}`. Use this absolute path wherever shared files say `<plugin>`; the variable is not set in Bash.

You keep the user's working style portable and lean: every lesson lives in exactly one place, and the kit gets shorter as often as it gets longer.

## Iron laws

1. Nothing outside `<profile>/reports/` is written until the user approves the exact diff.
2. Promote a memory only when it repeated at least twice or names a concrete failure.
3. Every promotion deletes its source memory and its `MEMORY.md` line in the same diff; when the memory also holds facts that stay, the diff deletes only the promoted part.
4. `<profile>/rules.md` stays at 6,000 bytes or fewer; going over means merging or dropping an older rule.

## Not this skill

Building or editing the map's sources → `/tedy:setup`. Changing a role's procedure because of a new requirement → edit that skill with the user.

## Procedure

1. **Inputs.** Read `${CLAUDE_PLUGIN_ROOT}/shared/decision-points.md`; headers and options below are label keys that `node ${CLAUDE_PLUGIN_ROOT}/scripts/labels.mjs` prints.
   - The project's auto memory, in the folder of the map's `paths[0]` and of every mapped repo: `cd <project path> && node ${CLAUDE_PLUGIN_ROOT}/scripts/memory-stats.mjs` prints the folders, the counts and `learned_until`; read every memory modified since then (a date counts that whole day; empty means every file). When no earlier `<profile>/reports/learn-*-<project>.md` exists, read every memory: this pass is the baseline.
   - The edit log: `node ${CLAUDE_PLUGIN_ROOT}/scripts/edit-rate.mjs`, then the `edited`, `cut` and `added` entries of `~/.local/state/tedy/edit-log.jsonl` since `learned_until`: what the user changed is what the samples get wrong.
2. **Classify each memory** in a table: memory | form | destination | action | repeat-of | evidence. Put each lesson in the strongest form that can carry it, and say why a row skips a stronger one:
   - A check that runs → a plugin proposal for a kit gate or hook, or a team proposal for a lint rule, test or CI check in that project (its team decides; a readonly repo gets a proposal for the owning team).
   - A line in a role's checklist or reference → a plugin proposal, because the installed plugin directory is replaced on every update.
   - Personal working rule, true in every project → `<profile>/rules.md` (`node ${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs doctor` prints the profile directory).
   - How output reads → `<profile>/style/<name>.md` as a new sample or an Avoid row; when the profile has no copy yet, start from the file `profile.mjs path style/<name>.md` prints.
   - A fact about this project → the map (`truth_overrides`, `tracker.rules`, `verify_gotchas`, `team`, `open_questions`).
   - Superseded or wrong → delete.
   - Still project-local and fine where it is → keep.
   Check each claim against its source before promoting it; a memory can be stale. `repeat-of` names the row of an earlier `<profile>/reports/learn-*.md`, of any project, that already promoted the same lesson: a repeat means that form did not hold, so the row proposes the next stronger one.
   Rows that leave the project (rules, style, plugin proposals) name no client, product, repository, host, person or business number.
3. **Subtract.** Add to the proposed diff the deletion of promoted memories and their `MEMORY.md` lines; nothing is deleted before step 6. Merge rules to stay under the cap. Replace a style sample the edit log shows the user keeps rewriting.
4. **Report.** Write `<profile>/reports/learn-<yymmdd-hhmm>-<project>.md`: the table, the full proposed diff, line counts before and after, and broken links in `MEMORY.md` (reported only; the user decides). Copy the leaving rows to `<report>.leaving.md` and run `node ${CLAUDE_PLUGIN_ROOT}/scripts/public-scan.mjs file <report>.leaving.md --denylist <profile>/public-denylist.txt` when that denylist exists; fix every hit. End with `## Metrics`: the `memory-stats.mjs` counts (feedback, repeats among them, sessions), the `edit-rate.mjs` week rows that overlap the period, `rules.md` bytes and rule count before and after, gate decisions per gate in the period from `~/.local/state/tedy/gate-log.jsonl`, and the previous report's Metrics line for this project, or "baseline". Quote the table in the reply.
5. **Approve.** One `AskUserQuestion`, header `learn.header`: `learn.all`, `learn.pick` (a multiSelect follow-up by row number), `learn.hold`. On `learn.hold`, `project-state.mjs set learn_held <today>` quiets the session-start nudge for the day.
6. **Apply** the approved rows; give every plugin or team proposal a waiting item with `node ${CLAUDE_PLUGIN_ROOT}/scripts/pending.mjs stub "<proposal>"` in the project path; record now with `project-state.mjs set learned_until <ISO timestamp with offset>` in the project path, run `claude -p "/doctor prompt-audit"` and report any new conflict it names as a proposal for the next run; when the command is unknown or replies that the claude-api skill is not available, report "prompt audit unavailable" instead. Then, when the profile is a git repository, commit there (`feat: fold <project> lessons into the profile`).
7. **Next step.** `next.header`: applying a plugin proposal in tedy-kit when the pass made one, otherwise run the role whose material changed on real work, or `next.stop` with an 80-character summary.

## Done

Every memory newer than `learned_until` has a row and an action, each promotion removed its source, the rules file is within its cap, no leaving row has a denylist hit, every proposal has a stub, the report has `## Metrics`, the prompt audit ran clean or its absence is reported, and `learned_until` moved.
