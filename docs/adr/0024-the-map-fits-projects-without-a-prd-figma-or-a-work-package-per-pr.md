# 0024: The map fits projects without a PRD, Figma or a work package per PR

Status: accepted 2026-11-13 (user decision); amends the PR link rule of [ADR 0004](0004-pull-requests-follow-work-packages.md) and the truth ladder of the reconcile flow.

## Context
- TonX, the next client project (OpenProject project 185 `toncex`), has no PRD and no Figma. Its written spec is the ADRs and architecture docs in the `toncex-research` repository, and its repositories include a Rust engine, an Nx monorepo, proto contracts and infrastructure.
- The code already allowed such a map: `project-map.mjs doctor` printed `READY` for a map with only `name`, `paths`, `repos` and `language.pr_review`, and `github-write.mjs` read `prd.files` or nothing. The skills' prose did not: reconcile items needed a PRD locator, the truth ladder named only PRD and Figma for behaviour, review-pr and the reviewer's spec lens named only `prd-section.mjs`, and the schema listed six repository roles.
- A project without Figma had no way to say so, so "filling a gap mid-task" would ask for a Figma node on every task.
- git-gate refused every PR without `OP#<id>` in a project with a tracker. The user wants a PR without a work package to be possible by choice; the rule came from an empty-body PR that merged while its bug never moved.

## Decision
- **Repository roles are free text.** `FE`, `BE`, `contract`, `admin-FE`, `admin-BE` and `prototype` keep their place on the truth ladder; any other role, such as `engine`, `infra` or `docs`, is read as code with no truth-ladder rank of its own.
- **`prd.files` takes directories.** A directory entry stands for every `.md` file under it, in path order, so a project's ADRs count as its written spec without listing each one.
- **`prd: false` and `figma: false` record that a project has none.** `doctor` stops warning about the field, setup asks about it once, and no role skill asks for it again.
- **The truth ladder falls back.** For behaviour and copy: PRD and Figma when the map has them; otherwise the written spec in `prd.files`, where an accepted decision beats a proposed one; otherwise the work package's checklist and acceptance criteria, or the user's words; code last. Reconcile items come from the work package or the user's words when there is no PRD, coverage counts those items, and a source the project does not have is `match.nosource`, never a stop.
- **`OP#none: <reason>` is the chosen no-package PR.** git-gate accepts a body whose line starts `OP#none:` followed by a reason. `/tedy:dev` asks the user before writing it, as the alternative to running `/tedy:pm` for a package. The status sweep ignores such a PR, because it links no package.

## Prior art

- mattpocock/skills (MIT, studied 2026-11-13, via github)
  - card: mattpocock-skills
  - https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/.agents/adr/0001-explicit-setup-pointer-only-for-hard-dependencies.md#L8 "If the docs aren't there, the skill still works; output is just less sharp."
  - Lesson: a skill that only sharpens with a project's docs should run without them; only a skill whose output is wrong without its config should stop and point at setup.
  - Taken: a missing PRD or Figma degrades reconcile and review to the sources the project has; only the tracker write paths keep requiring their map fields.
- Invariants before spec when docs are missing (the kit's private note, studied 2026-11-13, via local)
  - docs/prior-art/private/notes/invariants-file-before-spec-when-docs-missing.md:11 "record decisions as ADRs"
  - Lesson: where no PRD exists, recorded decisions are the reviewable spec an agent works from.
  - Taken: `prd.files` may point at a project's ADR folder, and an accepted ADR outranks a proposed one.

- Kent C. Dodds on ADRs for agents (public post on X, studied 2026-11-13, via x)
  - https://x.com/kentcdodds/status/2118758407993966953 "ADRs and primitives are a huge leverage point for getting your agents to build the right thing."
  - https://x.com/kentcdodds/status/2118798048101015879 "If they conflict at some point the agent marks it as superseded by #NNNN and that works fine"
  - Lesson: agents read ADRs and follow them, and a conflict between ADRs is settled by the newer one superseding the older.
  - Taken: a project's ADR folder is a valid written spec in `prd.files`, and an ADR's status line decides whether it binds.
- SonarSource/SonarJS (SONAR Source-Available License v1.0, studied 2026-11-13, via github)
  - card: sonarsource-sonarjs
  - https://github.com/SonarSource/SonarJS/blob/9d7da9d1b891dba0610f679bab88553ce4da8fc9/.claude/skills/sonar-docs/SKILL.md#L43 "Use `No-Jira` if there's no ticket."
  - Lesson: a change without a ticket writes a fixed word where the key goes, so a deliberate choice differs from a forgotten link.
  - Taken: `OP#none: <reason>` on the body's first line, with a reason SonarJS does not ask for.
- sscarduzio/elasticsearch-readonlyrest-plugin (GPL-3.0, studied 2026-11-13, via github)
  - card: readonlyrest-pr-conventions
  - https://github.com/sscarduzio/elasticsearch-readonlyrest-plugin/blob/e6585310a63b030365681ae243a519c46a74cead/ci/pr-conventions/checks/10-title-jira-key.sh#L4 "# Escape hatch: the `no-jira` label, for a change that does not need a ticket."
  - Lesson: the ticket check stays strict and names its escape hatch in its own refusal.
  - Taken: git-gate's refusal names `OP#none: <reason>`; the choice sits in the body, because the gate reads the command and not the PR's labels.
- cleartax/jira-lint (MIT, studied 2026-11-13, via github)
  - card: cleartax-jira-lint
  - https://github.com/cleartax/jira-lint/blob/0b90e54c614ba320d44d4d2b02df4c0c7fa70f89/README.md#L169 "A regex to ignore running `jira-lint` on certain branches, like production etc."
  - Lesson: exemptions by branch pattern or bot author are repository-wide and record no reason per PR.
  - Not taken: no project-level switch; the user decides each PR without a work package.

position: tracker-status conforms
