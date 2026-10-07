# tedy-kit

Personal Claude Code kit that carries one engineer's way of working (PR review, development, project management) into every session and project. It is a local directory marketplace (`tedy-kit`) that ships one plugin (`tedy`).

Plan and evidence: `~/Documents/workspace/plans/261006-1429-personal-working-style-kit/`.

## Layout

| Path | Role | Loaded |
|---|---|---|
| `rules/working-style.md` | Always-on personal rules, imported from `~/.claude/CLAUDE.md` | Every session, survives compaction |
| `plugin/skills/` | Role skills (`/tedy:review-pr`, …) | On invocation |
| `plugin/shared/` | Procedures and style samples the skills read | When a skill reads them |
| `plugin/hooks/`, `plugin/scripts/` | Mechanical gates and helpers (Node, `node:test`) | On hook events |
| `projects/` | Project maps written by `/tedy:setup`; fields in `projects/_schema.md` | When a skill resolves the current project |
| `evals/` | Probes for platform assumptions, pressure tests, plugin evals | Manual |

## Commands

| Command | Invocation | Does |
|---|---|---|
| `/tedy:review-pr <PR>` | User or model | Reviews a teammate's PR against PRD, Figma and backend code, drafts hints, posts after approval |
| `/tedy:setup [update]` | User only | Builds or updates the project map through guided questions |
| `/tedy:reconcile <scope>` | User only | Cross-checks PRD, Figma, backend, contract, frontend and demo for one scope; writes a mismatch table and raise list |
| `/tedy:dev <task> \| rebut <review>` | User only | Builds one task (reconcile, branch, verify on the commit, two reviewer lenses, commit, report) or rebuts an external review claim by claim before any edit |

## Install

```bash
claude plugin marketplace add ~/Documents/workspace/tedy-kit
claude plugin install tedy@tedy-kit
```

The plugin runs from this source directory: edits apply in a new session or after `/reload-plugins`, with no reinstall.

`~/.claude/CLAUDE.md` must keep this line after the shared-core import:

```text
@~/Documents/workspace/tedy-kit/rules/working-style.md
```

AgentKit does not manage `~/.claude/CLAUDE.md`; if the line ever disappears, add it back.

User settings this kit relies on (`~/.claude/settings.json`):
- `outputStyle: "God Mode (Level 5)"`.
- `skillOverrides` set to `"user-invocable-only"` for `ak-review-pr`, `ak-code-review`, `pg-review-pr`, `pg-project-management`, `code-review`.
- `permissions.ask` covering push, PR create/merge and `github-write.mjs`, in plain form (rtk was removed on 2026-10-07; while it was installed, its rewrite hook made permission rules miss commands). Verified 2026-10-07: a fresh session prompts for `node …/github-write.mjs` and runs other `node` commands freely.

After every Claude Code update, run `bash evals/probes/run-probes.sh` and compare with `plans/reports/probe-261007-tedy-kit-open-questions-resolved.md`.

## Data in this repository

Project maps hold internal company data: PRD document ids, Figma file keys, OpenProject project ids, team member names. The repository is private. It holds no credentials: tokens stay in `~/.config` (mode 600) and are read at run time.

## Authoring standard

- Each SKILL.md opens with a senior persona, the iron laws, and a "not for this skill" section naming the sibling that owns that work.
- Make a skill model-invocable only when the agent must reach it on its own; otherwise set `disable-model-invocation: true`. Always-on rules carry a routing line for each model-invocable skill, because the skill listing is over budget and new skills appear by name only.
- Every step ends on a checkable, exhaustive completion criterion.
- State rules positively with a one-clause reason. Use a prohibition only for a hard guardrail, paired with the target behavior.
- Leading words, each defined once: _draft_ (unpublished text waiting for approval), _hint_ (one-sentence statement of the current state, no fix), _rebut_ (verify then accept or refute a claim), _raise_ (surface a conflict now, quoting both sides), _truth ladder_ (FE matches BE and contract; BE and contract match PRD and Figma), _write-guard_ (`WRITE → <target> : 1 review · K comments`, printed by `github-write.mjs` before any external write), _READY_ (doctor verdict), _docs-claim_ (a fact from docs not yet checked against code).
- Anti-rationalization tables hold only excuses observed in real runs.
- Limits: SKILL.md body at most about 9,000 English characters (5,000 tokens is the post-compaction re-injection cap); each reference under 300 lines; description up to 1,024 characters stating trigger conditions, not a workflow summary.
- Skills that ask the user never use `context: fork`, and never list AskUserQuestion in `allowed-tools`.
- Mark exact external-write command blocks with `<!-- fragile -->`.
- Quote script-printed canonical blocks in full in the reply.
- Gates before calling a change done: `claude plugin validate`, `python3 ~/.claude/skills/ak-skill-creator/scripts/quick_validate.py <skill>`, `python3 ~/.claude/skills/ak-skill-creator/scripts/lint_cruft.py <skill> --routing` (0 High), `node --test plugin/scripts/*.test.mjs`. The machine-global gitignore excludes `*.test.*`; `.gitignore` re-includes `*.test.mjs`, so check `git status` shows new test files.

## Considered and rejected

| Option | Reason |
|---|---|
| Role persona through `claude --agent` | Replaces the default Claude Code system prompt (kill-test 2026-10-06) |
| Agent `memory:` for accumulated experience | `code-reviewer` ran 97 times with an empty memory directory |
| New MCP servers for GitHub, Figma, Google Docs, OpenProject | Existing CLIs and REST cover them; the Figma MCP cannot read or write comments |
| Router skill | `/tedy:` autocomplete already lists every command |
| Self-update gate, version parity, CHANGELOG | Plugin loads in place from source; git history is enough for a personal kit |
| Blind LLM-judge acceptance | Circular (judge reads the same style docs), underpowered at 6 pairs, self-preference bias; the edit rate on real approvals replaces it |
| Recall ≥ 90% routing target | Skill listing is over budget and is not re-injected after compaction; manual invocation plus routing lines is the path |
| `CLAUDE_CODE_THRIFTY_SONIC=0` | Undocumented internal flag; the commit and push gate covers Bash-side writes |
| `skillOverrides` for `mattpocock-skills:code-review` | Plugin skills ignore `skillOverrides`; the plugin stays enabled by the user's choice |
| Footer disclosing AI-drafted review comments | User's decision on 2026-10-07: no disclosure |
