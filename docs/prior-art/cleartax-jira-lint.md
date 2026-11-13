---
name: cleartax/jira-lint
pinned: https://github.com/cleartax/jira-lint/tree/0b90e54c614ba320d44d4d2b02df4c0c7fa70f89
license: MIT
studied: 2026-11-13
channel: github
domains: product-pm, guardrails
use-when: you lint PRs for a Jira key and decide which PRs are exempt
---

# cleartax/jira-lint

A GitHub Action that checks a PR's branch and title for a Jira key and comments on the PR. Its exemptions are set for the whole repository: a branch-name regex and a list of bot authors.

## Evidence
- https://github.com/cleartax/jira-lint/blob/0b90e54c614ba320d44d4d2b02df4c0c7fa70f89/README.md#L169 "| `skip-branches` | A regex to ignore running `jira-lint` on certain branches, like production etc."

## Lessons
- Exemption by branch pattern or author is a repository-wide rule, so a single PR cannot record why it has no ticket. Touches plugin/gates/git-gate.mjs; gap by design: the kit chose a per-PR `OP#none: <reason>` the user decides each time, not a project-level switch.
