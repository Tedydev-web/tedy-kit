---
name: SonarSource/SonarJS
pinned: https://github.com/SonarSource/SonarJS/tree/9d7da9d1b891dba0610f679bab88553ce4da8fc9
license: SONAR Source-Available License v1.0
studied: 2026-11-13
channel: github
domains: product-pm, agent-skills
use-when: you require every PR or commit to name its ticket and need a written form for the change that has none
---

# SonarSource/SonarJS

SonarSource's JavaScript analyzer, read for one convention in its agent skill for documentation changes: a PR title carries its Jira key, and a change without a ticket says so with a fixed word instead of leaving the key out.

## Evidence
- https://github.com/SonarSource/SonarJS/blob/9d7da9d1b891dba0610f679bab88553ce4da8fc9/.claude/skills/sonar-docs/SKILL.md#L43 "Use `No-Jira` if there's no ticket."

## Lessons
- A ticket-less change is written as an explicit word in the place the ticket key goes, so a reader and a check can tell a deliberate choice from a forgotten link. Touches plugin/gates/git-gate.mjs (`OP#none: <reason>` on the PR body's first line); overlap; the kit also demands a reason, which SonarJS does not.
