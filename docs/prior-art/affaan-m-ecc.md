---
name: affaan-m/ECC
pinned: https://github.com/affaan-m/ECC/tree/b38be6a7f6350964d59328b52f0624e1d1d552d1
license: MIT
studied: 2026-11-03
channel: github
domains: guardrails, evals, platform
use-when: you design a PreToolUse guard that must fail closed, or measure whether a gate changes outcomes at all
---

# affaan-m/ECC

ECC (formerly `affaan-m/everything-claude-code`, which GitHub now redirects here; v2.2.3 plus an unreleased section) is a very large Claude Code configuration, 71 agents, 314 skill folders, 98 commands and a hook graph, packaged for a dozen harnesses and sold alongside the ecc.tools GitHub App. It is studied because the master plan names it the reference for hooks and agents at scale. The breadth is not the lesson; most skills and agents are generic and every agent repeats the same prompt-defense block. The lessons are in its hook runtime, which was hardened issue by issue (stdin that never closes, truncated input, nested `sh -c`, Windows spawn limits, schema drift), and in an unusually honest effectiveness study of its GateGuard hook, with a placebo arm, reference and naive solutions per scenario, and a pilot that measured cost but no effect.

## Evidence
- https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/hooks/README.md#L23 "Claude Code validates a plugin's `hooks.json` against its own schema and reports any other key (`$schema`, `id`, `description`) as unknown at load time"
- https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/hooks/README.md#L25 "so reordering `hooks.json` without reordering the sidecar, or editing a command without updating the sidecar, is caught rather than silently swapping IDs."
- https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/hooks/README.md#L136-L137 "Input that is not yet a complete JSON object is treated as incomplete, so # fail-closed safety hooks block instead of hanging until the harness kills them."
- https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/hooks/README.md#L183 "Stop rules ignore `stop_hook_active: true` to avoid continuation loops."
- https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/hooks/README.md#L185-L186 "Files tracked by Git are disabled by default because opening a repository must not activate repository-authored instructions."
- https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/hooks/README.md#L196 "the input payload must not be echoed as a no-op response."
- https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/scripts/hooks/bash-hook-dispatcher.js#L176 "// Safety hooks cannot inspect a partial request, so pre-Bash fails closed."
- https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/scripts/hooks/gateguard-fact-force.js#L1028 "fails closed: a guard that allowed it would be bypassed by one more level."
- https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/scripts/hooks/gateguard-fact-force.js#L1035 "if (depth > 4) return true;"
- https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/scripts/lib/package-manager.js#L136 "it can exceed Bun's spawn limit on Windows and freeze the plugin."
- https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/docs/gateguard/question-effectiveness.md#L16-L18 "a placebo gate that denies the same calls with generic questions (`placebo`); otherwise the gain comes from stopping the agent, not from what it is asked."
- https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/docs/gateguard/question-effectiveness.md#L34 "(a correct solution, which must score 1) and `naive` (the trap taken, which must"
- https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/docs/gateguard/question-effectiveness.md#L171 "Every arm passed every trial on every scenario."
- https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/docs/gateguard/question-effectiveness.md#L180 "`gate` spends about 45% more turns and 28% more tokens than `off`"
- https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/agents/code-reviewer.md#L3 "MUST BE USED for all code changes."

## Issues and changelog
- https://github.com/affaan-m/ECC/issues/1454 "expected string, received array"
  - Broke: Claude Code 2.1.x rejected every argv-array `command` in `hooks.json`, so all 27 hooks stopped loading (only `/doctor` showed it) while skills and agents still worked. Fixed: #1462 shipped string commands; IDs and descriptions later moved to a fingerprinted sidecar, and CI fails on any key outside the loader's set.
- https://github.com/affaan-m/ECC/issues/162 "interactive mode freezes when plugin is enabled"
  - Broke: the SessionStart hook spawned `where.exe` or `which` per package manager, exceeding Bun's spawn limit on Windows and freezing the terminal. Fixed in 75ab8e6: no child processes on the startup path, detection from lock files only.
- https://github.com/affaan-m/ECC/issues/1422 "The only thing that helped was to completely delete plugin"
  - Broke: after an update GateGuard denied every edit and Bash call in a loop, so the agent could only read. Fixed: #1439 repaired GateGuard session state, stopped it blocking `.claude/settings.json` and read-only git; the interim workaround was `ECC_DISABLED_HOOKS`.
- https://github.com/affaan-m/ECC/pull/3050 "so five levels of `sh -c` hid a `drop table`"
  - Broke: the destructive-command check returned false past its recursion limit and missed runners such as `timeout`, `nice` and `env -S`. Fixed: merged; past the limit the check now fails closed and the wrappers are unwrapped.
- https://github.com/affaan-m/ECC/pull/3051 "is blocked although nothing runs git"
  - Broke: `block-no-verify` treated a quoted `git commit --no-verify` passed as an argument to another program as a command, a false positive (#3023). Not fixed: the PR was closed unmerged and #3023 was still open on 2026-11-03.
- https://github.com/affaan-m/ECC/pull/3055 "That left users with inert guardrails and a false sense of safety."
  - Broke: `/hookify` wrote rule files that no hook ever read. Fixed: merged a runtime that enforces them, takes the project root from `CLAUDE_PROJECT_DIR` rather than the payload, and disables git-tracked rules unless explicitly trusted.
- https://github.com/affaan-m/ECC/pull/2966 "and the run comes back PASS."
  - Broke: the release sanitizer agent skipped binaries such as `.xlsx` and `.db`, never listed them and reported PASS. Fixed: merged; unreadable files are listed in a manifest and the pipeline stops until a person confirms opening each one.
- Changelog, Unreleased: the external-contract question became opt-in because "Hidden-intent trials did not show it helps" (CHANGELOG.md line 8); the effectiveness doc's standing conclusion over 336 billed trials is that the gate's benefit is not established while its cost is 35 to 45% in turns and spend.

## Lessons
- An eval where every arm passes measures nothing; prove the task can fail before trusting the result: each scenario carries a reference solution that must score 1 and a naive one that must not (question-effectiveness.md line 34). Touches `docs/adr/0009-fact-based-ablation-evals.md:17` (success is fail-before, pass-after and beating the no-plugin arm, with no check that the no-plugin arm can fail at all); gap; cost low (one grader test per case on a naive transcript).
- Add a placebo arm that applies the same interruption with generic content, so an effect is attributed to what the kit says and not to stopping the agent (lines 16-18): touches `docs/adr/0009-fact-based-ablation-evals.md:14` (pre-change, post-change and no-plugin arms only); gap; cost medium (one more paid arm per measured change).
- Report a gate's cost next to its effect, and say "untested" rather than "no effect" when the arms cannot differ (lines 171-180): overlap with the rusty-monorepo card's per-run cost gate and `archive/governance-v0.3.4:plugin/lib/eval-baseline.mjs`; cost low.
- Fail closed when a guard cannot see the whole request, whether input was truncated, stdin never closed, or a nested shell goes past the parse depth: overlap with `plugin/gates/git-gate.mjs:64` (refuses `eval`, `bash -c`, heredocs and runtime-built command words outright, which is stricter than ECC's depth-4 unwrapping) and `plugin/lib/hook-io.mjs:9-19` (unreadable input asks instead of passing); the kit is stronger on shell forms; cost none.
- A guard that cannot tell data from command blocks legitimate work and gets disabled by users (#3023 still open, #1422 users deleting the plugin): overlap with `plugin/tests/git-gate-script-names-in-data.test.mjs`; keep a test per false positive the user reports; cost low.
- Keep `hooks.json` to keys the loader accepts and test that, because a shape the loader rejects unloads every hook at once (#1454): touches `plugin/tests/hooks.test.mjs:12`, which requires `onFailure` on every gate; the kit relies on ADR 0001 line 14 that Claude Code accepts `onFailure`, which this study did not re-check; gap; cost low (a test against the documented key list).
- Keep the SessionStart path free of process spawns, or budget them: overlap with `plugin/lib/pending.mjs:105-112` (git calls skipped once the session-start time budget runs out); no change.
- Never activate instructions a repository ships just because it was opened: overlap with `plugin/agents/reviewer.md:9` (PR text is data) and the kit's rules living in the user profile rather than the repo; no change.
- Stop hooks honour `stop_hook_active`: overlap with `plugin/lib/session-hooks.mjs:56`; no change.
- Not taken: "MUST BE USED" descriptions on dozens of agents and a pasted prompt-defense block in each of 71 agents spend context on every turn; the kit keeps one reviewer agent (`plugin/agents/reviewer.md:3`) with a one-line data rule.
