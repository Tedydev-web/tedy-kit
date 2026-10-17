# 0007: Options considered and rejected

Status: accepted (2026-10-06 to 2026-10-07, recorded 2026-10-17)

## Context
These options came up while building the kit. Each was tried or measured, and the reason it was dropped is recorded so it is not proposed again without new evidence.

## Decision

| Option | Reason |
|---|---|
| Role persona through `claude --agent` | Replaces the default Claude Code system prompt (kill-test 2026-10-06) |
| Agent `memory:` for accumulated experience | `code-reviewer` ran 97 times with an empty memory directory |
| New MCP servers for GitHub, Figma, Google Docs, OpenProject | Existing CLIs and REST cover them; the Figma MCP cannot read or write comments |
| Router skill | `/tedy:` autocomplete already lists every command |
| Self-update gate, version parity, CHANGELOG | The plugin loads in place from a checkout; git history and release tags are enough for a personal kit |
| Blind LLM-judge acceptance | Circular (the judge reads the same style docs), underpowered at 6 pairs, self-preference bias; the edit rate on real approvals replaces it |
| Recall ≥ 90% routing target | The skill listing is over budget and is not re-injected after compaction; manual invocation plus routing lines is the path |
| `CLAUDE_CODE_THRIFTY_SONIC=0` | Undocumented internal flag; the report after each push covers Bash-side writes |
| `skillOverrides` for `mattpocock-skills:code-review` | Plugin skills ignore `skillOverrides`; the plugin stays enabled by the user's choice |
| Footer disclosing AI-drafted review comments | User's decision on 2026-10-07: no disclosure |

## What it avoids
Re-litigating settled options without new evidence.
