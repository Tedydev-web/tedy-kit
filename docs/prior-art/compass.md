---
name: dshakes/compass
pinned: https://github.com/dshakes/compass/tree/fb41822123b4b556079b9a1c945c2521404ec978
license: MIT
studied: 2026-10-28
channel: github
---

# dshakes/compass

A shell-based Claude Code configuration kit (hooks, skills, guardrail policy, spend gate, SDLC workflows). Studied for the canon (sweep `261021-canon`, pass 2): it claims a mechanism for fifteen registry problems, so each claim is checked here for real code against skill prose; its per-rule ablation gate is the only one in the sweep so far.

## Evidence
- https://github.com/dshakes/compass/blob/fb41822123b4b556079b9a1c945c2521404ec978/scripts/compass-ablate.sh#L23 "unmeasured    removing it changes nothing. Add a corpus case, THEN decide. Never auto-delete."
- https://github.com/dshakes/compass/blob/fb41822123b4b556079b9a1c945c2521404ec978/scripts/compass-ablate.sh#L163-L164 "if ! bash -n "$POLICY" 2>/dev/null; then verdict=inconclusive;"
- https://github.com/dshakes/compass/blob/fb41822123b4b556079b9a1c945c2521404ec978/scripts/compass-ablate.sh#L206 "FAIL: %d rule(s) actively hurt the score."
- https://github.com/dshakes/compass/blob/fb41822123b4b556079b9a1c945c2521404ec978/.github/workflows/ci.yml#L129 "run: bash scripts/compass-ablate.sh --gate"
- https://github.com/dshakes/compass/blob/fb41822123b4b556079b9a1c945c2521404ec978/scripts/check-mcp.sh#L51 "uses '@latest' (floating) — pin an explicit version"
- https://github.com/dshakes/compass/blob/fb41822123b4b556079b9a1c945c2521404ec978/scripts/check-vendor.sh#L26 "version drift: ext=$vext plugin=$vplug"
- https://github.com/dshakes/compass/blob/fb41822123b4b556079b9a1c945c2521404ec978/scripts/check-docs.sh#L57 "case "$link" in http*|\#*|mailto:*|"") continue ;; esac"
- https://github.com/dshakes/compass/blob/fb41822123b4b556079b9a1c945c2521404ec978/claude/hooks/budget-gate.sh#L28 "Fail-open by design: if no cap is set, or spend can't be read yet, it does NOT block"
- https://github.com/dshakes/compass/blob/fb41822123b4b556079b9a1c945c2521404ec978/scripts/compass-sandbox.sh#L59 "compass sandbox: no sandbox backend available — refusing to run unconfined."
- https://github.com/dshakes/compass/blob/fb41822123b4b556079b9a1c945c2521404ec978/claude/hooks/lib/policy.sh#L323 "invisible chars, decodes base64 blobs, and folds leetspeak + homoglyph lookalikes,"
- https://github.com/dshakes/compass/blob/fb41822123b4b556079b9a1c945c2521404ec978/claude/skills/pr-shepherd/SKILL.md#L46 "**Three strikes**: after 3 failed fix attempts on one PR, stop"
- https://github.com/dshakes/compass/blob/fb41822123b4b556079b9a1c945c2521404ec978/scripts/test-audit-plugin.sh#L2 "test-audit-plugin.sh — exercise compass-audit-plugin against the fixture dirs."

## Issues and changelog
- https://github.com/dshakes/compass/issues/106 "I fixed the **identical** secrets bug in the dry-run one commit ago (#105) and left its twin in the real-run path."
  - Broke: `compass enable` on a fully configured repo warned that secrets and the ruleset were missing, because the real-run path still checked only the local shell. Fixed: both paths query the repo (`gh secret list`); the author names it a fix-one-caller-not-the-class error made twice that day.
- https://github.com/dshakes/compass/issues/100 "**The old hint was actively harmful.**"
  - Broke: the workflow-mirror drift hint always copied template to live, so following it after a Dependabot bump reverted the security update. Fixed: `check-actions.sh --fix` picks the source by asking git which side moved and refuses when both did.
- https://github.com/dshakes/compass/blob/fb41822123b4b556079b9a1c945c2521404ec978/CHANGELOG.md#L27-L28 "**The drift hint told you to discard security updates.** It always printed `cp sdlc/workflows/X .github/workflows/` — template → live."
  - Broke: same defect as #100, recorded in the 2.2.0 release notes. Fixed: 2.2.0, with an automatic mirror sync on Dependabot PRs.

## Lessons
- Each guardrail rule is ablated against a labelled corpus and classed load-bearing, unmeasured, broken or inconclusive; CI fails on any broken rule or on unmeasured rules above a floor of 0, an unparseable ablation is inconclusive rather than a finding, and nothing is deleted automatically (S31, S10). Touches docs/adr/0009-fact-based-ablation-evals.md (per change, not per rule) and docs/adr/0006-rules-size-budget.md (size only); gap; high cost, it needs a scored corpus per rule, and user-policy rules stay out of it by the registry's own clause.
- CI runs the MCP pin check and the doctor (also run in CI) runs the vendor manifest drift check (S12, S15, S5): `@latest` fails, and the extension version must equal the plugin manifest version. Touches the doctor at plugin/lib/profile.mjs:147-164 and plugin/.claude-plugin/plugin.json; partial (no version-equals-tag check); low cost.
- The docs check resolves relative links, site nav and asset mirrors but skips every `http` link (S6), so it would not have caught the kit's own incident, an install line naming a GitHub repository that never existed. Touches README.md install lines; gap (the registry lists nothing); low cost, resolve each named repository with `gh api` before a release.
- A PreToolUse hook denies the next tool call once a user-set session or daily cap is reached, and does nothing when no cap is set (S24): budget-gate.sh is fail-open by design and says it is a cost guardrail, not a security boundary. Touches ADR 0009 (`--max-cost-usd`) and the canon spend ledger; partial (no in-session halt); low cost, low value under the user's no-cap choice.
- Shell commands are normalised (quotes, `$HOME`, `~`, rm flags in any form) before the PreToolUse policy matches them, untrusted text is decoded (base64, invisible characters, homoglyphs) for injection matching, and the sandbox refuses to run unconfined when no backend exists (S26): policy.sh calls its own decoding best-effort. Touches plugin/gates/git-gate.mjs (refuses forms it cannot read, with a rewrite); overlap, and refusal is the stronger design; none.
- A negative-fixture test that nothing runs proves nothing (S8): test-audit-plugin.sh and its malicious and clean fixtures exist, but no CI step, Makefile target or doctor check calls it. Touches plugin/tests (`node --test` picks up every test file); overlap; none.
- A cap on fix attempts and a class sweep after a fix are skill prose here (S29, S17): pr-shepherd's three strikes lives in SKILL.md, and #106 shows the class sweep missed twice in one day. Touches the Blast radius steps at plugin/shared/source-access.md:44; overlap in kind (also prose); none.
