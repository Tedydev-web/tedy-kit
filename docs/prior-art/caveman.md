---
name: JuliusBrussee/caveman
pinned: https://github.com/JuliusBrussee/caveman/tree/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4
license: Apache-2.0
studied: 2026-10-30
channel: github
---

# JuliusBrussee/caveman

A supplement of sweep 261021-canon, not reference-labelled: a skill, CLI and proxy that wrap many coding agents, with one profile per agent recording the surfaces caveman uses on it (environment injection, skill directories, a PreToolUse command hook and a UserPromptSubmit memory hook for Claude Code) next to the agent version they were verified on and what was observed. Studied for S27 because a probe fails when the installed agent differs from that version, CI installs exactly the pinned version, and a pin moves only after the recorded observation is re-run. Partial: the probe runs only `--version` and `--help`, the scheduled latest-drift lane is continue-on-error and files issues, and no need is matched against the agent's full surface inventory.

## Evidence
- https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/agents/probe-installed.mjs#L117-L120 "const versionMatches = profile.tested_agent_version === "x" || observed === profile.tested_agent_version;"
- https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/agents/probe-installed.mjs#L117-L118 "const versionProbe = run(binary, ["--version"], env); const helpProbe = run(binary, ["--help"], env);"
- https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/agents/probe-installed.mjs#L122-L123 "With --allow-newer a launchable binary that is strictly newer than the pin is // `drift` (report it, do not fail); an older/unknown one is still `broken`."
- https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/agents/probe-installed.mjs#L156 "process.exit(failed ? 1 : 0);"
- https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/agents/profiles/claude.json#L29-L34 ""command_hook": { "method": "claude-pretooluse" }, "memory_hook": { "method": "claude-userpromptsubmit" },"
- https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/agents/profiles/claude.json#L38-L41 ""tested_agent_version": "2.1.308","
- https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/agents/profiles/claude.json#L41 "route probe from a scratch HOME and CLAUDE_CONFIG_DIR with onboarding pre-accepted in ~/.claude.json"
- https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/agents/profiles/schema.json#L200 "The agent-conformance CI matrix pins are derived from this and must equal it (compile.mjs fails closed on a mismatch)."
- https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/agents/compile.mjs#L283-L284 "A declared last_verified_at older than this many days fails closed (re-verify or drop). const STALENESS_DAYS = 365;"
- https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/agents/compile.mjs#L424 "need(ageDays <= STALENESS_DAYS,"
- https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/agents/compile.mjs#L523 "the CI pin must equal the profile pin (issue #135)"
- https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/.github/workflows/agent-conformance.yml#L67-L68 "install: npm install -g @anthropic-ai/claude-code@2.1.308"
- https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/.github/workflows/agent-conformance.yml#L97-L98 "run: node agents/probe-installed.mjs --require "${{ matrix.id }}""
- https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/.github/workflows/agent-conformance.yml#L100-L103 "if: github.event_name == 'schedule' continue-on-error: true"
- https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/.github/workflows/agent-conformance.yml#L149 "--allow-newer --json"
- https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/agents/drift-report.mjs#L6-L7 "Non-blocking by design — the caller runs it with continue-on-error"

## Issues and changelog
- No changelog at the pin (no file named like it within three directory levels). The drift lane's issues are titled `agent-drift: <id> — installed X exceeds pinned Y`; the 30 most recently closed include five for `claude`, closed 2026-10-06 to 2026-10-25 for installed versions 2.1.289 to 2.1.310, one every few days.
- https://github.com/JuliusBrussee/caveman/issues/1327 "Investigated, pin not bumped: I could run step 1 only partially, and the profile claims more than I could verify."
  - Broke: Claude Code moved past the pinned 2.1.302, and the profile's `verified_by` claims an observed request route, not only a launchable binary, so a version bump alone would have claimed what nobody re-checked. Fixed: the route probe was rebuilt (onboarding pre-accepted, explicit model, stdin redirect), re-run on 2.1.308, and the pin moved to the version actually probed (PR 1315).
- https://github.com/JuliusBrussee/caveman/pull/1315 "so none could be bumped on the version number alone"
  - Broke: five agent pins lagged their upstreams. Fixed: each pin moved only after the route probe its `verified_by` names was re-run end to end.
- https://github.com/JuliusBrussee/caveman/pull/1015 "the harness built to catch exactly this could not see it."
  - Broke: the end-to-end conformance harness stayed green while every api-key Codex session failed, because its Codex stub added the path segment the real client does not. Fixed: the stub now matches the real client, checked by mutation (the old route turns it red).

## Lessons
- Each surface choice is stored with the version it was verified on and a `verified_by` naming what was observed, and a re-check re-runs that observation instead of moving the version (S27): `claude.json`, issue 1327, PR 1315. Touches plugin/lib/canon-checks.mjs:163 (the stale-digest error is cleared by setting `inventory` in docs/canon/surface-fit.json:2, with nothing showing the needs were re-judged) and docs/canon/surface-fit.json (reasons, but no date or record of what was checked); gap; low cost, a per-need date and a one-line note of what was re-read, checked against the snapshot date.
- A verification claim older than a fixed budget fails closed, so a choice cannot stay valid by silence (S27): `compile.mjs` lines 283-284 and 424. Touches docs/canon/claude-code-inventory.json:3 (the snapshot date is never checked for age) and docs/canon/surface-fit.json (no date); gap; low cost, one comparison in `surfaceFitErrors`.
- A harness that models the client hides the breakage it exists to catch (S27): PR 1015. Touches docs/canon/surface-fit.json:7 ("a plugin can ship only subagentStatusLine") and :29 ("a subagent cannot call AskUserQuestion"), load-bearing claims about Claude Code that no probe checks, so a release that changes either flips a choice with every check green; gap; medium cost, one `claude -p` probe per load-bearing reason, rerun when the inventory digest moves.
- CI installs exactly the pinned version and fails when the CI pin and the profile pin differ (S27): `agent-conformance.yml` lines 67-68 and 97-98, `compile.mjs` line 523. Touches plugin/lib/canon-checks.mjs:177-186 (`inventoryVersionErrors` returns no error when `claude` is not installed, so a CI runner without it never checks the snapshot); partial; medium cost, install the snapshot's Claude Code version in CI before the test.
- The drift lane against the latest release is report-only: `--allow-newer` turns a newer binary into `drift` with exit 0, the job is continue-on-error, and the report files one idempotent issue per agent (S27): `probe-installed.mjs` lines 122-123, `agent-conformance.yml` lines 100-103, `drift-report.mjs` lines 6-7. Touches plugin/tests/canon-checks.test.mjs:170-175 (the kit's check is a hard failure, but only when the test runs on a machine with Claude Code); partial, the kit has no scheduled lane; low cost, a scheduled job that runs plugin/evals/probes/claude-code-inventory.py and reports a moved digest.
