---
name: anthropics/claude-plugins-official
pinned: https://github.com/anthropics/claude-plugins-official/tree/f8c5e7a1dcb71b10cb74586224b5401f3de5db28
license: Apache-2.0
studied: 2026-10-28
channel: github
---

# anthropics/claude-plugins-official

A supplement of sweep 261021-canon, not reference-labelled: the vendor's plugin marketplace, studied because its own plugins match a codebase's needs against Claude Code surfaces (S27), attribute token and cache spend per skill and subagent (S32), and propose CLAUDE.md lines with a reason each (S31), all three partial.

## Evidence
- https://github.com/anthropics/claude-plugins-official/blob/f8c5e7a1dcb71b10cb74586224b5401f3de5db28/plugins/claude-code-setup/skills/claude-automation-recommender/SKILL.md#L11 "**This skill is read-only.** It analyzes the codebase and outputs recommendations."
- https://github.com/anthropics/claude-plugins-official/blob/f8c5e7a1dcb71b10cb74586224b5401f3de5db28/plugins/claude-code-setup/skills/claude-automation-recommender/SKILL.md#L24 "| **Hooks** | Automatic actions on tool events (format on save, lint, block edits) |"
- https://github.com/anthropics/claude-plugins-official/blob/f8c5e7a1dcb71b10cb74586224b5401f3de5db28/plugins/claude-code-setup/skills/claude-automation-recommender/SKILL.md#L28 "| **MCP Servers** | External tool integrations (databases, APIs, browsers, docs) |"
- https://github.com/anthropics/claude-plugins-official/blob/f8c5e7a1dcb71b10cb74586224b5401f3de5db28/plugins/claude-code-setup/skills/claude-automation-recommender/SKILL.md#L45 "ls -la .claude/ CLAUDE.md 2>/dev/null"
- https://github.com/anthropics/claude-plugins-official/blob/f8c5e7a1dcb71b10cb74586224b5401f3de5db28/plugins/session-report/skills/session-report/analyze-sessions.mjs#L49 "const CACHE_BREAK_THRESHOLD = parseInt(flag('--cache-break', '100000'), 10)"
- https://github.com/anthropics/claude-plugins-official/blob/f8c5e7a1dcb71b10cb74586224b5401f3de5db28/plugins/session-report/skills/session-report/analyze-sessions.mjs#L389 "if (uncached > CACHE_BREAK_THRESHOLD) {"
- https://github.com/anthropics/claude-plugins-official/blob/f8c5e7a1dcb71b10cb74586224b5401f3de5db28/plugins/session-report/skills/session-report/analyze-sessions.mjs#L669 "by_skill: Object.fromEntries("
- https://github.com/anthropics/claude-plugins-official/blob/f8c5e7a1dcb71b10cb74586224b5401f3de5db28/plugins/claude-md-management/commands/revise-claude-md.md#L45 "**Why:** [one-line reason]"
- https://github.com/anthropics/claude-plugins-official/blob/f8c5e7a1dcb71b10cb74586224b5401f3de5db28/plugins/claude-md-management/commands/revise-claude-md.md#L54 "Ask if the user wants to apply the changes. Only edit files they approve."
- https://github.com/anthropics/claude-plugins-official/blob/f8c5e7a1dcb71b10cb74586224b5401f3de5db28/plugins/claude-md-management/skills/claude-md-improver/SKILL.md#L146 "**Stale commands**: Build commands that no longer work"
- https://github.com/anthropics/claude-plugins-official/blob/f8c5e7a1dcb71b10cb74586224b5401f3de5db28/.github/workflows/bump-plugin-shas.yml#L3-L4 "for each external entry whose upstream HEAD has moved past # its pinned SHA, validate at the new SHA with `claude plugin validate`"
- https://github.com/anthropics/claude-plugins-official/blob/f8c5e7a1dcb71b10cb74586224b5401f3de5db28/.github/workflows/revert-failed-bumps.yml#L5-L6 "read the per-entry verdicts the scan uploaded, # revert just the failing entries' source.sha back to main's pin"

## Issues and changelog
- https://github.com/anthropics/claude-plugins-official/issues/6341 "As the marketplace changes, the skill recommends entries that may no longer exist."
  - Broke: the recommender's plugin and skill catalog is a static list in SKILL.md, so it drifts from what the marketplace holds. Fixed: open at the pin; the reporter proposes querying the installed marketplaces at run time.
- https://github.com/anthropics/claude-plugins-official/issues/6786 "an agent that sums `cache_breaks[*].uncached` understates it"
  - Broke: the cache-break list is cut to 100 entries with nothing saying so (32.1M of 40.1M uncached tokens listed over 7 days), and `subagent.calls` counts runs, not API calls. Fixed: open at the pin.
- https://github.com/anthropics/claude-plugins-official/issues/6857 "So "% of total tokens" mostly measures cache reads."
  - Broke: findings ranked by token share, where cache reads were 97.7 % of tokens and 45.6 % of cost. Fixed: open at the pin.
- https://github.com/anthropics/claude-plugins-official/issues/6770 "the failure is swallowed, so the validation step never runs"
  - Broke: frontmatter CI passed every PR for months because an unknown `gh pr diff` flag failed behind `|| true`; fixing it exposed 4 failing files. Fixed: PR 6771 proposed, closed unmerged at the pin.

## Lessons
- Before recommending a surface, read the project's existing Claude Code config and map each codebase signal to a surface type (S27): the automation recommender's Phase 1 and its type table. Partial: the table has 5 types while this same repo ships LSP and output-style plugins, and the catalog is static, so nothing re-checks it when the inventory changes (issue 6341). Touches plugin/evals/probes/claude-code-inventory.py and docs/prior-art/claude-code-surfaces.md; partial (the kit has the inventory, and only the dev sweep judges needs against it); low cost, generate the surface list for each need from the inventory script output, never a hand list.
- Token and cache spend is attributed per skill, per subagent type and per prompt, and a call with more than 100k uncached input is listed as a cache break (S32): `analyze-sessions.mjs`. Partial: it reports, nothing fails an artifact, and issues 6786 and 6857 show it understating breaks and ranking by tokens instead of cost. Touches docs/adr/0006-rules-size-budget.md and plugin/tests/skill-size.test.mjs; gap (the kit measures characters, not per-artifact spend); low cost, rank by cost at list prices, not token share.
- Every proposed CLAUDE.md line carries a one-line Why and lands only after the user approves it, and an audit flags stale commands (S31, S25): `revise-claude-md.md`, `claude-md-improver`. Partial for S31: the reason lives in the proposal, not next to the rule, and there is no class or re-measurement. Touches plugin/tests/rule-citations.test.mjs and docs/adr/0006-rules-size-budget.md; gap (kit rules record neither reason nor class); low cost.
- A check that cannot run must fail, not pass (S8): issue 6770, a validator skipped on every PR because `|| true` swallowed a bad flag. Touches plugin/tests/sweep-record.test.mjs (negative cases); overlap for tests; gap for gates (no test shows a gate fires when its input is empty); low cost.
- External copies are pinned at a SHA, advanced by a validated bump, and a failing bump reverts to the previous pin (S5, S15): `bump-plugin-shas.yml`, `revert-failed-bumps.yml`. Issue 6331 reports the nightly bump workflow was disabled, so the pins went stale with no signal. Touches plugin/lib/profile.mjs:149-154; partial; low cost.
