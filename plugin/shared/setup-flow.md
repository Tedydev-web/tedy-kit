# Setup flow

How `/tedy:setup` builds and updates a project map. This file is the single source; role skills that meet a missing field follow "Filling a gap mid-task" below. Questions follow `<plugin>/shared/decision-points.md`; the schema is `<plugin>/../projects/_schema.md`.

## Three tiers

1. **Mechanical**: a missing remote ref, an unfetched sibling repo. Fix it read-only (`git -C <repo> fetch -q origin`) or print the exact command, then continue.
2. **Verified single answer**: a fact a command proves and only one answer fits, such as the base branch of every recent merged PR or the only repository with `nest-cli.json`. Apply it with one evidence line (`base of 28/30 merged PRs: dev`).
3. **Preference, ambiguity, or anything that writes**: ask. A guess is never the user's answer, however likely it looks. Every question carries `đã tự tìm: …` with what was checked.

## Bare run: `/tedy:setup`

1. `node <plugin>/scripts/project-map.mjs doctor` in the current directory.
2. `READY`: show the result, then offer the update menu below.
3. No map, or `NOT_READY`: run `node <plugin>/scripts/project-map.mjs discover` from the workspace root before asking anything. It prints JSON with:
   - `repos[]`: remote, `origin/HEAD`, the integration branch with its evidence (base of the last 30 merged PRs, else `dev`/`develop`/`staging`), stack markers, and the package scripts that check code.
   - `instructions[]`: `AGENTS.md` and `CLAUDE.md` at the root and in each repository.
   - `prdFiles[]`: PRD markdown under `docs/`.
   - `links`: Google Doc ids with tabs and Figma files with nodes, each with the files it came from (instruction files, READMEs, `docs/`, the project's auto memory).
   Then, for each Doc tab found, `prd-section.mjs index <doc> <tab>` to learn its epic and use case prefix. Old session transcripts are read for links only after the user says yes in this flow.
4. Ask the tier-3 gaps, one topic per call, grouped: repositories (role, readonly), languages, PRD and Figma per epic, tracker, then optional team, gotchas and truth overrides. Offer "bỏ qua" for optional groups.
5. Write `projects/<name>.md` with Write: a two-line note for people, then the ```json block. Run `doctor` again until `READY`.
6. Commit the map in the kit repository (`git -C <plugin>/.. add projects/<name>.md`, then commit with `feat: add <name> project map` or `feat: update <name> project map`). Push only after the user approves it through the push prompt.

## Update: `/tedy:setup update`

One `AskUserQuestion` with these options, then the matching question:

- Add an epic, a PRD tab or a Figma node.
- Change an integration branch or a readonly flag.
- Change tracker rules.
- Change review or tracker language.
- Repoint a source that moved (new tracker host, new doc, new Figma file).
- Change the team split.

Apply the answer, run `doctor`, commit as in step 6.

## Filling a gap mid-task

When a role skill needs a field the map lacks (a Figma node for epic 07, the tracker project), it gathers candidates as in step 3, asks once, writes the field into the map, commits it, and carries on with the task in the same turn.
