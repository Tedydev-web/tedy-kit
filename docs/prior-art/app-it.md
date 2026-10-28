---
name: Christian-Katzmann/app-it
pinned: https://github.com/Christian-Katzmann/app-it/tree/9ad064e62c2f2cdde7125e9f6577a0c487906e94
license: MIT
studied: 2026-10-28
channel: github
---

# Christian-Katzmann/app-it

A Claude Code and Codex plugin that wraps a local web project in a macOS Dock app. Studied for the canon (sweep `261021-canon`, pass 1): its AGENTS.md names, per repo convention, the line of `scripts/validate.sh` that fails the build, and CI runs that one script plus a behavioral fixture suite.

## Evidence
- https://github.com/Christian-Katzmann/app-it/blob/9ad064e62c2f2cdde7125e9f6577a0c487906e94/scripts/validate.sh#L236 "shared template drift: $shared differs between app-it and app-it-static (keep them byte-identical; edit app-it's copy and re-sync)"
- https://github.com/Christian-Katzmann/app-it/blob/9ad064e62c2f2cdde7125e9f6577a0c487906e94/AGENTS.md#L29 "**`app-it-static` reuses five `app-it` templates byte-for-byte**"
- https://github.com/Christian-Katzmann/app-it/blob/9ad064e62c2f2cdde7125e9f6577a0c487906e94/scripts/validate.sh#L144 "assert codex_plugin["version"] == plugin["version"]"
- https://github.com/Christian-Katzmann/app-it/blob/9ad064e62c2f2cdde7125e9f6577a0c487906e94/AGENTS.md#L41 "`validate.sh` greps for it and fails the build."
- https://github.com/Christian-Katzmann/app-it/blob/9ad064e62c2f2cdde7125e9f6577a0c487906e94/scripts/validate.sh#L266 "if grep -R "__APP_NAME__" README.md docs .claude-plugin .agents scripts"
- https://github.com/Christian-Katzmann/app-it/blob/9ad064e62c2f2cdde7125e9f6577a0c487906e94/scripts/validate.sh#L175 "note: claude CLI not found; skipping claude plugin validate"
- https://github.com/Christian-Katzmann/app-it/blob/9ad064e62c2f2cdde7125e9f6577a0c487906e94/.github/actions/app-it-verify/assert_contract.py#L76-L77 "status = payload.get("status") if status != "pass":"
- https://github.com/Christian-Katzmann/app-it/blob/9ad064e62c2f2cdde7125e9f6577a0c487906e94/plugins/app-it/skills/app-it/templates/desktop-upgrade.sh#L166 "manifest is BEHIND ($CUR_TEMPLATE_VERSION < $SRC_TEMPLATE_VERSION) — a re-vendor is due"
- https://github.com/Christian-Katzmann/app-it/blob/9ad064e62c2f2cdde7125e9f6577a0c487906e94/plugins/app-it/skills/app-it/templates/desktop-upgrade.sh#L300 "Refused: post-upgrade verify failed an ownership/identity check. Rolled the vendored scripts and manifest back to their pre-upgrade state."
- https://github.com/Christian-Katzmann/app-it/blob/9ad064e62c2f2cdde7125e9f6577a0c487906e94/CONTRIBUTING.md#L39 "**No new framework recipe is merged unless it's backed by a fixture in"
- https://github.com/Christian-Katzmann/app-it/blob/9ad064e62c2f2cdde7125e9f6577a0c487906e94/docs/RELEASE_CHECKLIST.md#L21 "**Manual GUI smoke** (the rows CI can't see"

## Issues and changelog
- https://github.com/Christian-Katzmann/app-it/issues/16 "On first contact with a real framework, the suite surfaced a genuine pre-existing bug"
  - Broke: the ownership descendant walk reached only the first child generation on macOS, so warm-reattach silently cold-started a new server on every Dock click while every static check passed. Fixed: one PID per `pgrep -P` call, guarded by a `deep-tree` fixture in the CI fixture suite; the PR shows closed unmerged, but the suite and fixture are on main at the pinned sha, so it landed outside the merge button.
- https://github.com/Christian-Katzmann/app-it/issues/22 "Three bugs that pass PSScriptAnalyzer but break the first time the scripts run on a real Windows shell"
  - Broke: the Windows Edge fallback never started the dev server and a quit script reported "Stopped" on a stale pid, all lint-clean. Fixed: the Edge quoting and StrictMode fixes were cherry-picked to main (the PR shows closed unmerged); the stale-pid hunk was left out as already handled a level up.
- https://github.com/Christian-Katzmann/app-it/issues/24 "Backs the Vite + React, SvelteKit, and Astro recipes (added in #15) with the fixtures the recipe-governance rule requires"
  - Broke: #15 merged three framework recipes without the fixtures the CONTRIBUTING rule demands, because that rule is enforced by review only. Fixed: not yet; this PR adding the fixtures is still open at the pinned sha.

## Lessons
- Byte-identical copies are diffed by the build gate, and the doc that describes them drifts from the gate (S17, S5): `validate.sh` diffs seven shared templates while AGENTS.md says five, so the code is right and the prose is stale. Touches plugin/tests/shim-parity.test.mjs (checks each shim names a module, not that copies match); partial; low cost, derive the doc list from the check or drop the count.
- Every manifest of a plugin carries the same version and one script asserts it (S15): `validate.sh` compares the Claude, Codex and marketplace versions. Touches plugin/.claude-plugin/plugin.json and the doctor release check at plugin/lib/profile.mjs:147-164; gap (no test compares the plugin.json version with the release tag); low cost.
- A leak guard must match the class, not one instance (S14): the local-path guard greps a single hardcoded maintainer path and the placeholder guard only `__APP_NAME__`, while AGENTS.md claims `/Users/<name>` and every `__PLACEHOLDER__`; only prose, not the check, covers the class. Touches plugin/lib/public-scan.mjs:7 (a generic home-path regex); overlap, the kit's check is stronger; none.
- A check whose tool is absent prints a skip instead of passing silently, but CI still goes green (S12, S8): `claude plugin validate` is skipped when the CLI is missing, and the release checklist asks for it by hand. Touches README.md:190-195 (skill authoring rules) and plugin/tests/skill-size.test.mjs; partial (the kit checks size only); low cost, make a skipped check a visible non-pass.
- Generated output records the template version it came from, and an upgrade compares, re-vendors, re-verifies and rolls back on a failed verify (S1, S2): `upgrade --check` exits 3 when the stamp is behind. Touches plugin/lib/sweep-record.mjs (criteria pin in sweep records only) and plugin/lib/prior-art.mjs:5 (GRANDFATHERED by name); gap for S1, partial for S2; medium cost.
- A rule enforced only by review was broken by the maintainer's own PR (S23, S12): "no recipe without a fixture" is CONTRIBUTING prose, #15 shipped three recipes without one and #24 is still open to backfill them. Touches README.md:190-195, whose rules name no enforcing check; gap; low cost, an `enforced by:` note per rule.
- Static checks are not evidence a script works; a behavioral suite that drives the real scripts found a bug on its first run (S8): #16 and #22. Touches plugin/evals/probes/run-probes.sh (run by hand); partial; medium cost.
