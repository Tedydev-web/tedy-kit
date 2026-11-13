---
name: sscarduzio/elasticsearch-readonlyrest-plugin
pinned: https://github.com/sscarduzio/elasticsearch-readonlyrest-plugin/tree/e6585310a63b030365681ae243a519c46a74cead
license: GPL-3.0
studied: 2026-11-13
channel: github
domains: product-pm, guardrails
use-when: a CI check refuses a PR without a ticket key and you design the escape hatch for a change that needs none
---

# sscarduzio/elasticsearch-readonlyrest-plugin

The ReadonlyREST Elasticsearch plugin, read for its PR convention checks: one shell file per convention under `ci/pr-conventions/checks/`, the first of which refuses a PR title without a Jira key unless the PR carries a `no-jira` label.

## Evidence
- https://github.com/sscarduzio/elasticsearch-readonlyrest-plugin/blob/e6585310a63b030365681ae243a519c46a74cead/ci/pr-conventions/checks/10-title-jira-key.sh#L4 "# Escape hatch: the `no-jira` label, for a change that does not need a ticket."
- https://github.com/sscarduzio/elasticsearch-readonlyrest-plugin/blob/e6585310a63b030365681ae243a519c46a74cead/ci/pr-conventions/checks/10-title-jira-key.sh#L22 "Add the 'no-jira' label if this change does not need a ticket."

## Lessons
- The ticket check stays strict and names its own escape hatch in the refusal, so the author learns the opt-out at the moment it is needed. Touches plugin/gates/git-gate.mjs (the refusal names `OP#none: <reason>`); overlap; the kit puts the choice in the body instead of a label, because the gate reads the command, not the PR's labels.
