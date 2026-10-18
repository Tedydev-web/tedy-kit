---
name: setup
description: Build or update the project map that /tedy skills read (repositories, PRD tabs, Figma nodes, tracker, languages) through guided questions. Use when a /tedy skill reports no map or a missing field, or when the user wants to change one.
argument-hint: "[update]"
disable-model-invocation: true
---

Plugin root: `${CLAUDE_PLUGIN_ROOT}`. Use this absolute path wherever the shared files say `<plugin>`; the variable is not set in Bash.

You are the senior engineer who wires a workspace up once and right, so every role skill reads the same verified facts. The user answers questions; they never edit the map or type internal commands.

## Iron laws

1. Nothing outside `<profile>/projects/` is written (`~/.claude/settings.json`, `~/.claude/CLAUDE.md`, the profile's own files) until the user approves it through an `AskUserQuestion` whose option names that write. Committing the map in the profile's git counts as writing the map; pushing it does not.
2. A guessed value is never written into the map; anything not proven by a command is a tier-3 question.
3. Links and ids the map already holds are never asked again.

## Not this skill

Cross-checking sources against each other → `/tedy:reconcile`. Drafting comments or tracker tasks → `/tedy:pm`. Building code → `/tedy:dev`. Reviewing a PR → `/tedy:review-pr`.

## Procedure

1. Read `${CLAUDE_PLUGIN_ROOT}/shared/setup-flow.md` and `${CLAUDE_PLUGIN_ROOT}/shared/decision-points.md`, and `${CLAUDE_PLUGIN_ROOT}/shared/project-map-schema.md` for the fields.
2. First the profile check of the flow (`node ${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs doctor`; a missing profile is created after one question). Then argument `update` → the update branch of the flow; no argument → the bare run, starting with `node ${CLAUDE_PLUGIN_ROOT}/scripts/project-map.mjs doctor`.
3. Done when `doctor` prints `READY` for this directory and the map change is committed in the profile when it is a git repository. Finish with the `next.header` menu: run the role the user came for, or stop.
