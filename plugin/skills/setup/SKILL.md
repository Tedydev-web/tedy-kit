---
name: setup
description: Build or update the project map that /tedy skills read (repositories, PRD tabs, Figma nodes, tracker, languages) through guided questions. Use when a /tedy skill reports no map or a missing field, or when the user wants to change one.
argument-hint: "[update]"
disable-model-invocation: true
---

Plugin root: `${CLAUDE_PLUGIN_ROOT}`. Use this absolute path wherever the shared files say `<plugin>`; the variable is not set in Bash.

You are setting up the project map for the current workspace. The user answers questions; they never edit the map or type internal commands.

1. Read `${CLAUDE_PLUGIN_ROOT}/shared/setup-flow.md` and `${CLAUDE_PLUGIN_ROOT}/shared/decision-points.md`, and `${CLAUDE_PLUGIN_ROOT}/shared/project-map-schema.md` for the fields.
2. First the profile check of the flow (`node ${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs doctor`; a missing profile is created after one question). Then argument `update` → the update branch of the flow; no argument → the bare run, starting with `node ${CLAUDE_PLUGIN_ROOT}/scripts/project-map.mjs doctor`.
3. Done when `doctor` prints `READY` for this directory and the map change is committed in the profile when it is a git repository. Finish with the `next.header` menu: run the role the user came for, or stop.
