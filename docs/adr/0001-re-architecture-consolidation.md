# 0001: One engine repository, a private profile, a pinned release

Status: accepted (2026-10-17)

## Context
- The kit mixed the engine (scripts, skills, hooks) with one person's rules, project maps and style overrides in the same repository, so the engine could not be shared and a personal edit could break every session.
- The plugin loads in place from a `directory` marketplace and ignores `version`, so whatever the checkout holds is what every session runs; a half-finished edit on `main` reached live sessions.
- Enforcement lived partly in prose. Shell commands, wrappers and interpreters could reach GitHub or the tracker without a gate seeing them.
- `plugin/scripts/` held gates, libraries, command-line tools and tests side by side.

## Decision
- One engine repository. Personal rules, project maps, style overrides and gate switches live in a profile directory (`~/.config/tedy` by default, `TEDY_PROFILE_DIR` to override), kept in its own local git repository.
- Sessions run a release worktree checked out at a tag; the marketplace points at that worktree. Development happens on `main` and reaches sessions only when the worktree moves to a new tag.
- Gates are Claude Code PreToolUse hooks with `onFailure: "block"`. Always on: git-gate, tracker-token-gate, profile-guard-gate. Personal, switched in the profile: no-comments, role, draft-PR-only, GitHub writes, publish quote. A command the gate cannot classify asks instead of passing.
- `plugin/` is split into `gates/`, `lib/` and `tests/`. Every old `plugin/scripts/<name>.mjs` path stays as a two-line shim that imports the module and calls its exported `run`, so hooks, skills, ask rules and sessions started on an older release keep working.
- Integrations kept: GitHub through `gh`, OpenProject over REST, Google Docs and Figma over their APIs. A local Markdown PRD provider and a GitHub Issues tracker are planned and deferred. Notion, Linear, Jira and Penpot are out of scope.

## What it avoids
Personal data in the shared engine, unreleased edits in live sessions, and writes that bypass a gate because they were wrapped in another command.
