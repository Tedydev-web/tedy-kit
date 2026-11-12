# 0006: The personal rules stay under 6,300 bytes

Status: accepted (2026-10-17); the budget rose from 6,000 to 6,300 bytes on 2026-11-12 (user decision, ADR 0022)

Supersedes: the 55-line limit in `plugin/skills/learn/SKILL.md`.

## Context
- The rules file had grown to 9,413 bytes. Dated incidents and enforcement details made each rule long, and the file is loaded into every session.
- Comparable kits keep always-loaded instructions short and enforce their budgets with a check rather than prose.
- 8 rules are already enforced by hooks and 4 by scripts; repeating the hook's "how" in prose costs context and drifts from the code.

## Decision
- Each rule keeps its instruction and one reason. Dates and incidents move to ADRs 0002-0005.
- For a rule a hook or script enforces, the "how" lives only in that hook or script.
- Rule numbers stay stable; the Decision Protection rule is added as rule 26.
- `profile.mjs doctor` fails when the rules file is over 6,300 bytes.

## What it avoids
An always-loaded file that keeps growing, and two copies of each enforcement detail.
