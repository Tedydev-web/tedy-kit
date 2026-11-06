---
name: karanb192/claude-code-hooks
pinned: https://github.com/karanb192/claude-code-hooks/tree/57a28c7687305e4a9b9dd50490e9b3c552c71ca4
license: MIT
studied: 2026-11-03
channel: github
domains: guardrails, security, testing
use-when: you add, merge or test a PreToolUse gate, or weigh one dispatcher process against one Node process per gate
---

# karanb192/claude-code-hooks

A marketplace of 22 single-purpose Claude Code hook plugins in plain CommonJS with `node:test` suites (secrets, dangerous commands, git safety, test protection, config tampering, spawn caps, observability), studied as the master plan's reference for declarative gate patterns and gate test architecture. What it adds to the store: `guard-pack`, which runs seven guards in one Node process with byte-identical vendored copies pinned by a test, a measured per-hook startup cost, a regex-backtracking test over every exported rule, a "fake green" test-protection gate, and guards for the agent's own hook config. Its guards fail open per guard and on bad input, the opposite of the kit's `onFailure: block`.

## Evidence
- https://github.com/karanb192/claude-code-hooks/blob/57a28c7687305e4a9b9dd50490e9b3c552c71ca4/plugins/guard-pack/guard-pack.js#L4 "All seven guard hooks in ONE Node process."
- https://github.com/karanb192/claude-code-hooks/blob/57a28c7687305e4a9b9dd50490e9b3c552c71ca4/plugins/guard-pack/guard-pack.js#L13 "skipped so one broken guard can never switch off the other six"
- https://github.com/karanb192/claude-code-hooks/blob/57a28c7687305e4a9b9dd50490e9b3c552c71ca4/plugins/guard-pack/guard-pack.js#L16 "The guard scripts in lib/ are byte-identical copies of the individual"
- https://github.com/karanb192/claude-code-hooks/blob/57a28c7687305e4a9b9dd50490e9b3c552c71ca4/plugins/guard-pack/tests/guard-pack.test.js#L60 "the lib copies must stay byte-identical to the plugin sources"
- https://github.com/karanb192/claude-code-hooks/blob/57a28c7687305e4a9b9dd50490e9b3c552c71ca4/bench/RESULTS.md#L17 "guard-pack.js | 38.0 | 35.7 | 69.1 | 39.9"
- https://github.com/karanb192/claude-code-hooks/blob/57a28c7687305e4a9b9dd50490e9b3c552c71ca4/bench/RESULTS.md#L21 "Numbers are dominated by Node interpreter"
- https://github.com/karanb192/claude-code-hooks/blob/57a28c7687305e4a9b9dd50490e9b3c552c71ca4/CONTRIBUTING.md#L139 "**Never crash the agent loop**: on any error (bad JSON included) print `{}` and"
- https://github.com/karanb192/claude-code-hooks/blob/57a28c7687305e4a9b9dd50490e9b3c552c71ca4/CONTRIBUTING.md#L152 "strip any env vars your hook reads"
- https://github.com/karanb192/claude-code-hooks/blob/57a28c7687305e4a9b9dd50490e9b3c552c71ca4/SECURITY.md#L13 "These hooks are **guardrails, not a sandbox**."
- https://github.com/karanb192/claude-code-hooks/blob/57a28c7687305e4a9b9dd50490e9b3c552c71ca4/tests/regex-backtracking.test.js#L3 "Every exported guard regex must reject a quote-heavy non-match quickly."
- https://github.com/karanb192/claude-code-hooks/blob/57a28c7687305e4a9b9dd50490e9b3c552c71ca4/tests/regex-backtracking.test.js#L39 "which is how the first version of this test passed"
- https://github.com/karanb192/claude-code-hooks/blob/57a28c7687305e4a9b9dd50490e9b3c552c71ca4/plugins/protect-tests/protect-tests.js#L4 "failure mode: an agent that makes a suite pass by"
- https://github.com/karanb192/claude-code-hooks/blob/57a28c7687305e4a9b9dd50490e9b3c552c71ca4/README.md#L87 "Who guards the guards: blocks the agent from tampering with its own guardrail config"
- https://github.com/karanb192/claude-code-hooks/blob/57a28c7687305e4a9b9dd50490e9b3c552c71ca4/README.md#L62 "current Claude Code builds ignore even the universal `continue: false` on it (verified live)"
- https://github.com/karanb192/claude-code-hooks/blob/57a28c7687305e4a9b9dd50490e9b3c552c71ca4/plugins/dead-rules-audit/README.md#L3 "flags chronically-ignored rules to promote into a deterministic hook"

## Issues and changelog
- https://github.com/karanb192/claude-code-hooks/issues/67 "spins at 100% CPU and never returns"
  - Broke: the `grep-env` rule backtracked exponentially on quote-heavy commands that never named `.env`, and with the 600-second default hook timeout a session sat wedged for minutes. Fixed: PR #68 rewrote the rule so each piece kind starts with a different character, capped the PreToolUse command at `timeout: 10`, and added the backtracking test over every exported rule.
- https://github.com/karanb192/claude-code-hooks/pull/68 "the command-hook default timeout is 600 seconds"
  - Broke: see #67. Fixed: the timeout is asserted by the plugin tests, so removing it fails the suite.
- https://github.com/karanb192/claude-code-hooks/issues/51 "leaves you believing six safety guards are active when zero of them are"
  - Broke: `plugin.json` declared `hooks` pointing at the auto-loaded `hooks/hooks.json`, Claude Code rejected the plugin as a duplicate hooks file, and `plugin install` still reported success. Fixed: the key is absent from the manifest at the pinned SHA; the issue was closed as not planned after that. The reporter's proposed guard is `claude plugin validate` in CI.
- https://github.com/karanb192/claude-code-hooks/issues/47 "was not inspected at all and returned matching lines."
  - Broke: the agent adapted around a blocked `Read` of `.env` with `grep` in Bash and with the built-in `Grep` tool, which the plugin never registered. Fixed: grep-family patterns and a `Grep` matcher, with regression tests.
- https://github.com/karanb192/claude-code-hooks/issues/55 "so the regex never matches and `checkFilePath` returns `blocked: false`."
  - Broke: path rules matched only `/`, so Windows backslash paths bypassed the secret guard. Fixed: PR #56 normalizes separators in file and search targets but not in Bash command text, and runs 62 subprocess tests from paths with spaces on native Windows CI.
- https://github.com/karanb192/claude-code-hooks/issues/31 "the parser is anchored to the start of the command string"
  - Broke: a contributed case-collision guard missed `cd x && rm -rf Content` and hard-blocked the harmless `mkdir -p`. Fixed: rewritten to the house standard (tokenize compound commands, resolve targets through `cd`, never block safe no-ops, pure-function exports, hermetic tests).

## Lessons
- One dispatcher process for the PreToolUse gates: touches `plugin/hooks/hooks.json:4-32` (one Bash call starts four Node processes: role, git, profile-guard and tracker-token gates); gap; cost medium. The bench puts one guard at about 33 ms and the seven-guard pack at 38 ms, so the kit pays roughly 130 ms per Bash call where one process would pay about 40 (DERIVED from RESULTS.md lines 10-17, measured on an M3 Pro, not on this machine). A kit dispatcher must keep `onFailure: block` and fail closed when one gate throws, the opposite of guard-pack line 13.
- Vendored copies pinned byte-identical by a test: touches `plugin/scripts/git-gate.mjs:1-2` (the kit uses two-line shims that import `plugin/gates/`, so there is nothing to drift); overlap; kit stronger; no change.
- Test-protection as a gate, not prose: touches `plugin/skills/dev/SKILL.md:39` ("Never weaken, skip or delete a test"); gap; cost medium. protect-tests blocks deleting test files and adding skip or xfail markers to an existing test, and leaves new tests and body edits alone.
- Guard the agent's own hook and settings files: touches `plugin/gates/profile-guard-gate.mjs:11` (guards `config.json` and `rules.md` of the profile only, not `.claude/settings.json`, `hooks.json` or `.mcp.json`); partial; cost low.
- Regex-backtracking test over every exported rule: overlap with `plugin/tests/regex-backtracking.test.mjs:9` (CPU time grows no faster than linear from 50,000 to 200,000 characters and stays under 1,000 ms); kit stronger; no change. Worth copying: test line 39 records that the first version passed on the exponential regex because the input hid the quotes, so a probe must put the hostile text in the segment the rule reads.
- Manifest must not re-declare the auto-loaded `hooks/hooks.json` (#51): overlap; `plugin/.claude-plugin/plugin.json` declares no `hooks` key. A `claude plugin validate` step in `npm test` would catch a regression; cost low.
- Rule compliance tally that flags rules to promote into a hook: touches nothing yet (`plugin/skills/learn/SKILL.md:40` reports from `gate-log.jsonl`, not from rule compliance per edit); gap; cost medium; its judgment is a keyword heuristic, so treat it as a prompt for review, not evidence.
- InstructionsLoaded cannot block (README line 62), so detection there must pair with a UserPromptSubmit or PreToolUse arm: touches nothing yet; the kit has no InstructionsLoaded hook; note for any future instruction-file scan.
