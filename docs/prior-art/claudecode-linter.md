---
name: retif/claudecode-linter
pinned: https://github.com/retif/claudecode-linter/tree/94fb3ddd05d16cee82a43cbedc0cead23546c444
license: MIT
studied: 2026-10-30
channel: github
---

# retif/claudecode-linter

A supplement of sweep 261021-canon, not reference-labelled: a linter for Claude Code plugins, skills, agents, hooks and settings whose rule data (tools, hook events, agent models, frontmatter keys, settings, permission and sandbox fields) is extracted from the published Claude Code bundle, studied for S27 because its PR CI fails when the contracts extracted from the latest release differ from the committed set. It guards its own contract table, not a mapping of needs to surfaces: the table holds no key for LSP, monitor, channel, output style or workflow, `effort` appears only as an agent frontmatter key name, and the LSP and monitor schemas it also extracts are refreshed by the scheduled release run but never compared by PR CI.

## Evidence
- https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/.github/workflows/ci.yml#L3-L6 "on: pull_request: push: branches: [main]"
- https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/.github/workflows/ci.yml#L66-L68 "LATEST=$(npm view @anthropic-ai/claude-code version)"
- https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/.github/workflows/ci.yml#L79-L80 "git show HEAD:contracts/claude-code-contracts.json"
- https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/.github/workflows/ci.yml#L82-L89 "if (norm(committed) !== norm(current)) { console.log("Contract values changed — update needed:");"
- https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/.github/workflows/ci.yml#L58-L64 "2.1.197 while the `latest` dist-tag said 2.1.301, so this job"
- https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/scripts/extract-contracts.ts#L6-L7 "Tool names (PascalCase identifiers used in permissions/allowed-tools)"
- https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/scripts/extract-contracts.ts#L111 "That is how the registry froze for ten-plus releases without"
- https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/scripts/extract-contracts.ts#L114-L115 "wrong release under the right name is worse than not extracting at all."
- https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/scripts/extract-contracts.ts#L1215-L1222 "const merged = new Set([...previous, ...current]);"
- https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/scripts/extract-contracts.ts#L735 "if (dropRate > 0.5) {"
- https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/scripts/extract-contracts.ts#L1207 "Contract gate FAILED — extraction degraded >30%:"
- https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/contracts/claude-code-contracts.json#L172-L178 ""agentFrontmatter": [ "autoCompactWindow", "background", "criticalSystemReminder_EXPERIMENTAL", "description", "disallowedTools", "effort","
- https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/.github/workflows/release.yml#L4-L5 "cron: "0 */6 * * *""
- https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/.github/workflows/release.yml#L68 "npx tsx scripts/extract-plugin-schema.ts --version"
- https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/package.json#L29-L30 ""contracts/lsp.schema.json", "contracts/monitors.schema.json","

## Issues and changelog
- No issues: `gh issue list --state all` on the repository returns none on 2026-10-30. The issues the code comments cite (25, 28, 30, 31 and 50 of an `oleks` repository) are in a repository that no longer resolves, so they are cited through the pinned comments above. 117 merged PRs, most of them dependency bumps; the two below are the ones about the contract extraction.
- https://github.com/retif/claudecode-linter/pull/5 "were not exercised by PR CI, allowing regressions to reach the scheduled release undetected"
  - Broke: an extractor regression reached the scheduled release run because PR CI never ran the extraction. Fixed: the `release-dry-run` job runs the release's extract and generate steps on every PR and fails on uncommitted output; it later became the contract-value comparison.
- https://github.com/retif/claudecode-linter/pull/85 "workflow has failed on every run for days."
  - Broke: Claude Code 2.1.197 moved the plugin schema validator and 2.1.209 added a non-literal numeric bound, so the bundle parser lost its anchor and the release run failed for days. Fixed: a fallback anchor and dropping non-literal bounds, with three regression tests.
- https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/CHANGELOG.md#L259-L267 "- **Tools**: +OfferChromeSetup"
  - Broke: patch release 2.1.301 added a tool, an agent frontmatter key and an MCP server field. Fixed: the six-hourly release run extracted and committed them; until it ran, every PR's contract comparison failed.
- https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/CHANGELOG.md#L227-L233 "- **Agent Colors**: +olive, +teal, +violet"
  - Broke: patch release 2.1.302 added three agent colours. Fixed: the same scheduled sync. A search of the 202 release sections at the pin finds no removal entry, which matches the union merge above: a value Claude Code drops stays in the contracts.

## Lessons
- The surface lists are extracted from the shipped CLI bundle and compared on every PR, so a new tool or hook event fails CI without anyone editing the extractor (S27): `ci.yml`, `extract-contracts.ts`. Touches plugin/evals/probes/claude-code-inventory.py:48-66 (component kinds are a hand-kept list; a new kind reaches `components` only when someone edits the probe, although a new docs page moves `docsDigest` and so the inventory digest) and :25-31 (hook events come from the docs page headings); partial; high cost, because parsing the minified bundle broke on layout changes in 2.1.197, 2.1.209 and 2.1.259 (PR 85, `extract-contracts.ts` lines 108-115). The docs-based probe is the cheaper source; the lesson is to derive the component kinds from the docs index rather than a list in the probe.
- A snapshot built from one release but stamped with another is refused, because a wrong release under the right name froze the registry for ten releases with every run green (S27): `assertResolvedVersion`, `extract-contracts.ts` lines 108-115. Touches plugin/evals/probes/claude-code-inventory.py:77-87 (stamps the local `claude --version` while `llms.txt` and `hooks.md` are fetched live, describing whatever the docs say that day; nothing ties the two); gap; low cost, refuse to write `--json` when the installed version differs from `npm view @anthropic-ai/claude-code version`.
- Patch releases add surfaces: 2.1.301 added a tool, an agent frontmatter key and an MCP server field, 2.1.302 added agent colours (S27): CHANGELOG lines 227-233 and 259-267. Touches plugin/lib/canon-checks.mjs:177-181 (`inventoryVersionErrors` fails only at a minor-version gap; plugin/tests/canon-checks.test.mjs:162 passes a snapshot 12 patches behind); partial. This is evidence against the minor-version rule of commit 5615084, not a reason to reverse it: a patch-level rule would fail on almost every release, and retif keeps up only by re-extracting every six hours (`release.yml` lines 4-5). Low cost to change, high churn; the user's call.
- Merging each extraction with the previous one keeps every value ever seen, so a removed surface never shows up as drift (S27): `mergeWithPrevious`, and no removal entry in 202 changelog sections. Touches plugin/evals/probes/claude-code-inventory.py:85-88 (the snapshot is rewritten whole) and plugin/lib/canon-checks.mjs:164-167 (a judged surface missing from the inventory is an error, plugin/tests/canon-checks.test.mjs:152-154); overlap, the kit already reports removals; none.
- An extraction that loses more than half of a field's values fails instead of passing as an upstream removal, though its message says 30% where the code tests 50% (S27): `extract-contracts.ts` lines 735 and 1207. Touches plugin/tests/canon-checks.test.mjs:172 (at least 30 hook events and 8 needs); overlap, an absolute floor instead of a relative one; none. Keep a threshold and the message that states it in one constant.
