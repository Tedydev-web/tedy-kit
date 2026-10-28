---
name: ucsandman/DashClaw
pinned: https://github.com/ucsandman/DashClaw/tree/704824de5f5f2fa052d4c36ec269a1ab0dbfcc8a
license: MIT
studied: 2026-10-28
channel: github
---

# ucsandman/DashClaw

A governance control plane that grades and holds agent actions through Claude Code, Codex and Hermes hooks. Studied for the canon (sweep `261021-canon`, pass 1): it proves its own hook still blocks after harness changes, keeps a two-sided calibration corpus for its gates, and runs a long list of drift checks in CI.

## Evidence
- https://github.com/ucsandman/DashClaw/blob/704824de5f5f2fa052d4c36ec269a1ab0dbfcc8a/hooks/enforcement_liveness_probe.py#L8-L10 "never by reading the decision ledger, because the ledger is exactly what kept lying in v4.72.1 (a hook timeout misconfig cancelled the pretool hook; guard rows kept flowing while every block failed open)."
- https://github.com/ucsandman/DashClaw/blob/704824de5f5f2fa052d4c36ec269a1ab0dbfcc8a/hooks/enforcement_liveness_probe.py#L35-L38 "unprovable — the seam ran but enforcement cannot be proven: no hook entry installed, observe mode, no policy holds the probe action, or the hook hung past the probe's wait budget. Rendered broken on the surfaces — you cannot claim enforcement you cannot prove."
- https://github.com/ucsandman/DashClaw/blob/704824de5f5f2fa052d4c36ec269a1ab0dbfcc8a/hooks/enforcement_liveness_probe.py#L500 "Values are probe-reported operational evidence, not runtime attestation."
- https://github.com/ucsandman/DashClaw/blob/704824de5f5f2fa052d4c36ec269a1ab0dbfcc8a/__tests__/fixtures/risk-calibration-golden-vectors.json#L13 "so a false positive in ANY layer interrupts an agent."
- https://github.com/ucsandman/DashClaw/blob/704824de5f5f2fa052d4c36ec269a1ab0dbfcc8a/__tests__/fixtures/risk-calibration-golden-vectors.json#L14 "TO ADD A CASE: when an interruption is judged wrong (or a dangerous action"
- https://github.com/ucsandman/DashClaw/blob/704824de5f5f2fa052d4c36ec269a1ab0dbfcc8a/__tests__/unit/risk-calibration-golden.test.js#L11 "risky vectors at/above min_risk (calibration can't be gamed downward)."
- https://github.com/ucsandman/DashClaw/blob/704824de5f5f2fa052d4c36ec269a1ab0dbfcc8a/.claude/hooks/dashclaw_agent_intel/bash_classifier.py#L610 "execute commands this classifier never sees as text, defeating every check"
- https://github.com/ucsandman/DashClaw/blob/704824de5f5f2fa052d4c36ec269a1ab0dbfcc8a/CHANGELOG.md#L10 "always share the same version — enforced by `npm run version:sync:check` in CI and the pre-commit hook."
- https://github.com/ucsandman/DashClaw/blob/704824de5f5f2fa052d4c36ec269a1ab0dbfcc8a/scripts/check-version-sync.mjs#L17 "they drifted 2.15.0/2.14.2/2.14.1 before this"
- https://github.com/ucsandman/DashClaw/blob/704824de5f5f2fa052d4c36ec269a1ab0dbfcc8a/scripts/check-doc-counts.mjs#L14 "Counts → ERROR on drift (exit 1 under --strict; wired into CI)"
- https://github.com/ucsandman/DashClaw/blob/704824de5f5f2fa052d4c36ec269a1ab0dbfcc8a/.claude/skills/dashclaw-agent/build-dashclaw/SKILL.md#L32 "**The 7-route boundary is CI-enforced.** Adding a new core route requires justification."
- https://github.com/ucsandman/DashClaw/blob/704824de5f5f2fa052d4c36ec269a1ab0dbfcc8a/.claude/skills/dashclaw-agent/build-dashclaw/SKILL.md#L134-L135 "# 1. Governance boundary — enforces 7-route API limit npm run governance:boundary:check"

## Issues and changelog
- https://github.com/ucsandman/DashClaw/blob/704824de5f5f2fa052d4c36ec269a1ab0dbfcc8a/CHANGELOG.md#L2653-L2659 "Every DashClaw hook installer wrote the PreToolUse timeout as `3600000`, a milliseconds value in a field Claude Code reads as **seconds**."
  - Broke: the hook timeout overflowed Claude Code's 32-bit timer, the harness cancelled the hook and let every tool call through, while guard decisions still reached the ledger, so the gap stayed invisible. Fixed: 4.72.1 set `3660` seconds in every installer surface, a test pins the value under the overflow ceiling, and the liveness probe now witnesses the block end to end.
- https://github.com/ucsandman/DashClaw/issues/246 "a deliberate detection is indistinguishable from infrastructure being down."
  - Broke: an HTTP 400 refusal from the guard was reported as "unreachable", and an outage policy set to allow or warn turned an explicit refusal into a pass. Fixed: #247 reads the refusal body and reports 408, 429 and 5xx as "answered, no verdict".
- https://github.com/ucsandman/DashClaw/blob/704824de5f5f2fa052d4c36ec269a1ab0dbfcc8a/CHANGELOG.md#L73 "Every prior bump left `guide:drift:check` red on those two fields"
  - Broke: the version-bump recipe never stamped two guide fields, so every release left a CI drift check red until one finally blocked a cut. Fixed: `version:set` stamps them.

## Lessons
- After a harness change, prove the gate still blocks by driving a synthetic forbidden action through the installed hook and witnessing whether it ran, never by reading the gate's own log (S16, S8); a run that cannot prove it is reported broken, and the probe records the measured runtime version and a sha256 of the hook source. Touches plugin/evals/probes/run-probes.sh; partial: the probes exercise a separate probe plugin and print results for a human, and record no Claude Code version or gate fingerprint; medium cost.
- A hook timeout is a unit-sensitive contract with the harness, and a cancelled hook fails open there (S16, S26): 4.72.1. Touches plugin/hooks/hooks.json (timeouts 15 to 60 seconds, `onFailure: block` on every gate); partial, the cancel path of those gates was not probed in this study; low cost, one probe case.
- A gate keeps a two-sided corpus: every wrong interruption becomes a benign vector with a ceiling and a source naming the incident, every dangerous one a risky vector with a floor, shipped with the fix in one commit (S8, S29). Touches plugin/tests/git-gate.test.mjs:376 and :413 (hostile inputs refused, everyday commands allowed); overlap for git-gate; gap for the other gates and for recording which incident each case came from; low cost.
- Code the gate cannot read as text (eval, a decode-to-shell pipe, `sh -c`) is blocked outright, and a legitimate use is surfaced for one-click approval rather than silently allowed (S26). Touches plugin/scripts/git-gate.mjs; overlap in the refusal, the kit refuses with a rewrite instead of asking, since the user cannot judge those commands (S29); none.
- One version across several manifests is a CI check that fails with the files and the fix, and it grew a second group after three plugin manifests drifted (S15). Touches plugin/lib/profile.mjs:147-164; gap: no check compares plugin.json with the release tag; low cost.
- Numbers that docs repeat are derived from source and fail CI on drift (S6): `check-doc-counts.mjs --strict`, with `--write` to regenerate them. Touches README.md; gap (nothing checks counts, links or install lines in the README); low cost.
- A skill naming its enforcing check is only as good as that check existing (S23, S6): build-dashclaw says the 7-route boundary is CI-enforced through `npm run governance:boundary:check`, but no such script is in package.json or ci.yml at this sha. Touches README.md:191-195 and docs/adr/0006-rules-size-budget.md; gap: no kit test checks that a command or script a skill or rule names exists (rule-citations.test.mjs:11 only bans rule numbers); low cost.
- Copies of one hook drift (S5): the `.claude/hooks` liveness probe is 521 lines against 948 in `hooks/`, and lacks the version and fingerprint code; the bash classifier ships in three trees. Touches plugin/tests/shim-parity.test.mjs; overlap, the kit keeps one source with tested shims; none.
