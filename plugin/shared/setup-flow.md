# Setup flow

How `/tedy:setup` builds and updates a project map. This file is the single source; role skills that meet a missing field follow "Filling a gap mid-task" below. Questions follow `<plugin>/shared/decision-points.md`; the schema is `<plugin>/shared/project-map-schema.md`; maps live in the user's profile (`<plugin>/shared/profile-layout.md`).

## Three tiers

1. **Mechanical**: a missing remote ref, an unfetched sibling repo. Fix it read-only (`git -C <repo> fetch -q origin`) or print the exact command, then continue.
2. **Verified single answer**: a fact a command proves and only one answer fits, such as the base branch of every recent merged PR or the only repository with `nest-cli.json`. Apply it with one evidence line (`base of 28/30 merged PRs: dev`).
3. **Preference, ambiguity, or anything that writes**: ask. A guess is never the user's answer, however likely it looks. Every question carries `setup.found` with what was checked.

## Profile first

Every run starts with `node <plugin>/scripts/profile.mjs doctor`. When its first line ends with `(missing)` or it prints `rules: missing`, the user has no profile yet:

1. One `AskUserQuestion`, header `profile.header`, with `setup.found` naming the directory doctor printed:
   - `profile.create`: create the profile in that directory.
   - `profile.elsewhere`: the user types a folder in "Other"; the option description says that `~/.claude/settings.json` is backed up and gets `TEDY_PROFILE_DIR` in its `env` block. On this answer, do that so hooks and commands find it in new sessions, and put `TEDY_PROFILE_DIR=<folder>` in front of every `node <plugin>/scripts/...` command for the rest of this run.
   - `profile.stop`: stop setup; nothing is written.
2. One multi-select `AskUserQuestion`, header `conventions.header`, asking which rules the user's team keeps, because each turns on a gate that blocks work that breaks it:
   - `conventions.noComments`: source holds no comments; the description says JSDoc, license headers and `TODO` lines are then blocked and only tool directives pass.
   - `conventions.draftPrOnly`: pull requests open as drafts.
   - `conventions.none`: neither.
3. `node <plugin>/scripts/profile.mjs init` followed by each chosen key (`noComments`, `draftPrOnly`), with `TEDY_PROFILE_DIR=<folder>` in front for another folder. It creates `config.json` with `roleGate`, `ghWrites` and `publishQuote` on plus the chosen keys, `rules.md` from the template and `projects/`, and never overwrites a file.
4. When no line of `~/.claude/CLAUDE.md` imports the profile's `rules.md` (any `@` path that resolves to it, `~` included), ask one `AskUserQuestion` before touching it; on approval back it up and append `@<profile>/rules.md`, so the rules load in every new session.
5. Quote the `profile.mjs doctor` output and say that any gate can be switched in `config.json` (`<plugin>/shared/profile-layout.md`). Then continue with the bare run or the update.

Any other `fail` line in the `profile.mjs doctor` output (`release-worktree`, `rules-size`, `claude-md-imports`, `claude-version`, `config`): quote it, then one `AskUserQuestion` whether to fix it now or continue with it open.

## Bare run: `/tedy:setup`

1. `node <plugin>/scripts/project-map.mjs doctor` in the current directory.
2. `READY`: show the result, then offer the update menu below.
3. No map, or `NOT_READY`: run `node <plugin>/scripts/project-map.mjs discover` from the workspace root before asking anything. It prints JSON with:
   - `repos[]`: remote, `origin/HEAD`, the integration branch with its evidence (base of the last 30 merged PRs, else `dev`/`develop`/`staging`), stack markers, and the package scripts that check code.
   - `instructions[]`: `AGENTS.md` and `CLAUDE.md` at the root and in each repository.
   - `prdFiles[]`: PRD markdown under `docs/`.
   - `links`: Google Doc ids with tabs and Figma files with nodes, each with the files it came from (instruction files, READMEs, `docs/`, the project's auto memory).
   Then, for each Doc tab found, `prd-section.mjs index <doc> <tab>` to learn its epic and use case prefix. When `links` lacks a Doc or Figma the map needs, one `AskUserQuestion` asks whether to read old session transcripts for links, with `setup.skip`; read them only on yes.
4. Ask the tier-3 gaps, one topic per call, grouped: repositories (role, readonly), languages, PRD and Figma per epic, tracker, then optional team, gotchas and truth overrides. Offer `setup.skip` for optional groups.
5. Write `<profile>/projects/<name>.md` with Write (`node <plugin>/scripts/profile.mjs doctor` prints the profile directory): a two-line note for people, then the ```json block. Run `doctor` again until `READY`.
6. When the profile is a git repository, commit the map there (`git -C <profile> add projects/<name>.md`, then commit with `feat: add <name> project map` or `feat: update <name> project map`); otherwise the written file is enough. Before any push, one `AskUserQuestion` names the remote and branch; push only on yes.

## Update: `/tedy:setup update`

Two `AskUserQuestion` steps, because one question holds at most four options. First: sources, repositories, tracker, or people and language. Then the matching question:

- Sources: add an epic, a PRD tab or a Figma node; repoint a source that moved (new tracker host, new doc, new Figma file).
- Repositories: change an integration branch or a readonly flag.
- Tracker: change tracker rules.
- People and language: change the team split; change review or tracker language.

Apply the answer, run `doctor`, commit as in step 6.

## Filling a gap mid-task

When a role skill needs a field the map lacks (a Figma node for epic 07, the tracker project), it gathers candidates as in step 3, asks once, writes the field into the map, commits it, and carries on with the task in the same turn.
