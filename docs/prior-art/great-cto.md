---
name: avelikiy/great_cto
pinned: https://github.com/avelikiy/great_cto/tree/171db2576d39377942c9ae574e1e18a6bde98a0e
license: MIT
studied: 2026-10-18
channel: github
---

# avelikiy/great_cto

## Evidence
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/scripts/hooks/gate-weakening-guard.mjs#L5 "The cheapest way to turn a red check green is to stop it checking: skip the"
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/scripts/hooks/gate-weakening-guard.mjs#L48 "\b(it|test|describe|context|suite)\.(skip|only)\s*\("
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/scripts/hooks/gate-weakening-guard.mjs#L27 "Counts are before vs after, so existing ones are not re-reported, removing one is"
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/scripts/hooks/gate-weakening-guard.mjs#L181 "if (d.tool_name && !['Edit', 'Write', 'MultiEdit'].includes(d.tool_name)) return process.exit(0);"
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/scripts/hooks/frozen-gates-guard.mjs#L33 "Files a shell command writes, truncates, replaces or deletes — the ways to change a"
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/scripts/hooks/gate-weakening-guard.mjs#L60 "@ts-(?:ignore|nocheck|expect-error)"
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/scripts/hooks/gate-weakening-guard.mjs#L69 "// Config that checks less."
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/scripts/hooks/gate-weakening-guard.mjs#L184 "if (!hit || isCovered(GATE)) return process.exit(0);"
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/scripts/hooks/gate-weakening-guard.mjs#L190 "node scripts/lib/exceptions.mjs create --gate ${GATE}"
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/scripts/lib/exceptions.mjs#L10 "The signature is a sha256 over the IMMUTABLE fields, so editing reason/scope/expiry after"
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/scripts/lib/exceptions.mjs#L32 "return createHash('sha256').update(canonicalString(exc), 'utf8').digest('hex');"
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/scripts/lib/exceptions.mjs#L52 "created_by: createdBy || process.env.USER || 'unknown',"
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/scripts/lib/exceptions.mjs#L43 "expiresInDays = 30"
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/commands/exception.md#L74 "Prefer fixing the gate over excepting it. Exceptions are for *external* blockers (a"
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/scripts/lib/count-skips.mjs#L5 "`node --test` exits 0 when tests skip, so a step judged by exit code alone"
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/scripts/lib/count-skips.mjs#L15 "an unreadable log is not "0 skipped""
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/CHANGELOG.md#L2258 "Exit codes are unchanged."
- https://github.com/avelikiy/great_cto/blob/171db2576d39377942c9ae574e1e18a6bde98a0e/CHANGELOG.md#L1308 "Two hooks that looked like protection never ran — the destructive-command check and the write"

## Issues and changelog
- https://github.com/avelikiy/great_cto/pull/78 "signed 'CI billing-locked' exception vs silent --admin"
  - Broke: merges over a billing-locked CI went through a silent `--admin` with no record of who or why. Fixed: the signed, expiring exception registry; gates pass only when a valid record covers them.
- https://github.com/avelikiy/great_cto/pull/82 "it blocks on day one — the tempting "fix" is to weaken the gate"
  - Broke: strict gates refused every legacy repo on day one, inviting a weakened gate. Fixed: gap waves, each deferred gap held by an interim exception that expires on its wave date; the planner CLI prints the exact `/exception create` line for each, so the project's own agent workflows mint exceptions.
- https://github.com/avelikiy/great_cto/pull/172 "Count modern Node TAP skipped summaries accurately, keeping optional live checks distinct from passed checks."
  - Broke: the skip counter missed Node's `# skipped N` spelling, so opt-in live checks vanished from the gate verdict. Fixed in v3.59.1 by widening the summary regex (CHANGELOG.md#L428-L430).
- Changelog v3.28.5 (CHANGELOG.md#L2255-L2258, #L2275): `ci-local.sh` printed ALL GATES GREEN with skipped tests because `node --test` exits 0 on a skip; fixed by counting skips per step and printing `GREEN, N TEST(S) SKIPPED — NOT CHECKED`, exit codes unchanged. The same release listed a runner summary the counter still missed; count-skips.mjs#L26 now reads it.
- Changelog v3.38.0 (CHANGELOG.md#L1308-L1310, #L1317-L1318): the destructive-command check and the write log read `command` and `file_path` from the top of the payload instead of `tool_input`, so neither ever ran; fixed by a test that drives every inline hook with the payload Claude Code sends. The same release extended the weakening guard from skips to suppressions and weakened configs (#L1331-L1335).

## Lessons
- Deny an edit that adds a skip or `.only` marker, counted before vs after over the whole file so existing markers and moves net zero: touches `plugin/hooks/hooks.json:11` (the matcher that already includes `Bash`) and a new gate beside `plugin/gates/no-comments-gate.mjs`; gap (nothing in the kit stops a skip; `plugin/skills/dev/SKILL.md:37` only runs the scripts); cost medium (gate, per-runner patterns, tests). Port with Bash write-target parsing as frozen-gates-guard does (#L33), because great_cto's guard returns early on anything but Edit/Write/MultiEdit (#L181), so `sed -i` adding `.skip` passes. Marker counting cannot see a deleted `it(` block or test file, so P2's "deleted" leg needs a separate signal: the test count on the commit against the integration branch in step 6.
  - Surface: PreToolUse on `Edit|Write|MultiEdit|NotebookEdit|Bash`. Survives: no failure mode found; the Bash and deletion holes are scope to close, not disqualifiers.
- Deny an added lint or type suppression and a config that checks less: touches `plugin/lib/comment-scan.mjs:3`, whose `DIRECTIVE` allowlist lets `eslint-` and `@ts-` comments through the no-comments gate, so `// @ts-ignore` passes today, and `plugin/hooks/hooks.json:5`; gap; cost low (same gate and matcher, pattern table only). Denying `eslint-disable-next-line` in client repos touches the user's rule that tool directives are allowed in source, so the user decides scope before adoption.
  - Surface: PreToolUse on `Edit|Write|MultiEdit`. Survives.
- Signed, expiring exception as the only way past a guard: touches `plugin/lib/hook-io.mjs:49-50`, which already emits `permissionDecision: "ask"`; gap; cost low in the `ask` form. In Claude Code the signature proves integrity, not a grantor: it is an unkeyed sha256 (exceptions.mjs#L32), `created_by` is `process.env.USER`, the same OS user the agent's Bash runs as (#L52), no hook in `scripts/hooks/` guards `exceptions.mjs create` or the registry (only consumers reference it), the deny reason prints the mint command (gate-weakening-guard.mjs#L190), `isCovered(GATE)` passes no scope so one record covers every file (#L184) for a 30-day default (#L43), and PR #82 has agent workflows emit the create line. Derived from code; no reported incident. The form that keeps the human as grantor is the guard answering `ask`, so the user approves each weakening edit in the permission prompt; the reason-and-expiry record survives as a draft under `plans/drafts/`.
  - Surface: PreToolUse `ask`. Signed registry disqualified in Claude Code: the agent can mint its own exception and retry. Unverified: whether `ask` still prompts under `bypassPermissions`; check before relying on it.
- A run with skips is not green, and the count comes from the runner's summary: touches `plugin/skills/dev/SKILL.md:37` (Verify) and `:39` (the report carries verify output); gap (the kit judges by exit code). great_cto never detects zero tests and keeps exit codes unchanged, and its summary parser shipped in v3.28.5 already noting a runner it missed, then was widened twice (count-skips.mjs#L26, v3.59.1). Cheaper kit form: a Verify clause requiring the runner's passed, skipped and total counts in the report, where total 0 or a skipped test in a touched file is not green, plus one anti-rationalization row at `:41-48`; cost low.
  - Surface: skill line in the dev Verify step. Survives as a skill line; a Stop or PostToolUse summary parser is not disqualified but inherits the per-runner format brittleness the changelog records.
- Drive every gate with the payload Claude Code sends (v3.38.0): overlap; kit gate tests already feed `tool_input` (`plugin/tests/no-comments-gate.test.mjs`, `plugin/tests/git-gate.test.mjs`); no change, and any new gate above gets the same test.
  - Surface: test suite. Survives.
- P1 (test written and run red before the fix): no mechanism in the files read, and `tdd` returned no closed issues or PRs; nothing to take from this source.
