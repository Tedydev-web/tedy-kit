---
name: wangqiqi/planrun
pinned: https://github.com/wangqiqi/planrun/tree/80d200fc0cd50661ae7f7449965ed7f34d9b160d
license: MIT
studied: 2026-10-28
channel: github
---

# wangqiqi/planrun

A skill, preset and guard-script bundle that seeds plan-driven agent runs into a project. Studied for the canon (sweep `261021-canon`, pass 2): an install records the version and file hashes it seeded, a doctor proves drift against that record, and a release verify script fails on retired surfaces, forbidden tokens, broken links, stale builds and a wrong skill invocation mode.

## Evidence
- https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/scripts/planrun-manifest.mjs#L3-L4 "record what `install-planrun.sh` seeded into a project, * so version drift is *provable* instead of a feeling."
- https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/scripts/planrun-manifest.mjs#L15 ""planrunVersion": "1.9.0","
- https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/scripts/planrun-doctor.mjs#L11-L13 "installed `planrun` / `@planrun/*` versions agree with each * other, with the reference build, and with what the project * recorded at install time"
- https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/scripts/planrun-doctor.mjs#L19 "Exit codes: 0 no drift · 1 drift found (with FIX lines) · 2 cannot determine"
- https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/scripts/planrun-doctor.mjs#L20-L21 "A check that has no reference to compare against is * SKIP — never a fabricated failure."
- https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/scripts/verify-planrun.sh#L16 "RETIRED_PATTERNS='install-planrun\.sh --preset|\.agent-presets|session-start'"
- https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/scripts/verify-planrun.sh#L210 "FAIL: $skill_md references a retired surface"
- https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/scripts/verify-planrun.sh#L180 "FAIL: skills/$base/SKILL.md contains forbidden Cursor-only token"
- https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/scripts/verify-planrun.sh#L40 "FAIL: $name is user-only — the model can never load it"
- https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/scripts/verify-doc-links.mjs#L3 "every repo-relative markdown link must resolve."
- https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/scripts/verify-lib-sync.sh#L25 "FAIL: committed runtime is stale — rebuild and commit these:"
- https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/.cursor/hooks/run-stop.sh#L41 "run: MAX_LOOPS=${max_loops}. Review plan and continue manually."

## Issues and changelog
- https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/CHANGELOG.md#L14-L15 "a DSH profile running 1.9.0 alongside 1.8.1 guard scripts had no way to say so."
  - Broke: a profile ran 1.9.0 packages over 1.8.1 guard scripts and nothing recorded which version seeded the project. Fixed: the install manifest, `pnpm run doctor` and seven guard fixtures (Unreleased).
- https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/CHANGELOG.md#L57-L59 "both exited 0 having done nothing — the install wrote no manifest and `doctor` reported a clean project it had never inspected."
  - Broke: behind a symlink the manifest writer and the doctor failed their CLI-entry check and exited 0, so the drift check reported clean. Fixed: real-path comparison and a `path-canon` fixture.
- https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/CHANGELOG.md#L101-L103 "23 markdown links used `../../../../docs/...` / `templates/...`, which resolve in the repo but point at `<profile>/node_modules/docs/...` once `@planrun/skill-provider` is installed from npm."
  - Broke: bundled skills shipped links that resolved only in the source checkout. Fixed: links point at the docs site or in-project paths, and `verify:links` checks links that escape their package.

## Lessons
- An install records the tool version and a sha256 per seeded file, and a doctor re-reads that record and exits 1 with a FIX line per drifted component, 2 when it cannot determine (S1, S2): `planrun-manifest.mjs`, `planrun-doctor.mjs`. Touches plugin/lib/profile.mjs:147 (release worktree must sit on a clean tag) and plugin/lib/sweep-record.mjs (criteria pin in sweep records only); partial for the installed copy, gap for a standard version per skill, gate or eval case; low cost.
- The drift report lists every component as pass, drift or skip, and a check with no reference is a skip, never a fabricated failure (S13): `planrun-doctor.mjs:20-21`. Touches `checkSweepFolder` in plugin/lib/sweep-record.mjs; partial, the kit's report covers sweeps, cards and ADRs only; medium cost.
- A drift check that silently does nothing reports clean, so the checker itself needs a fixture for the no-op path (S8): the symlink bug, fixed with a `path-canon` fixture. Touches plugin/tests (negative cases for the sweep gate); partial, no kit test proves the doctor fails when it inspects nothing; low cost.
- A release check fails when a bundled skill still names a retired surface, from a kept list of retired patterns, and the same script scans published skill text for tokens of the platform it was ported from (S18, S14): `RETIRED_PATTERNS` and `FORBIDDEN_PATTERNS` in `verify-planrun.sh`. Touches plugin/tests/rule-citations.test.mjs:11, docs/adr/0007-considered-and-rejected.md and plugin/lib/public-scan.mjs; partial for S18, the kit has no retired-name denylist over skills, overlap for S14; low cost.
- A skill's invocation mode is checked from its frontmatter, and a skill that must be model-invocable fails when it sets `disable-model-invocation: true` (S7, S12). Touches README.md:192 (the authoring rule) and plugin/tests/skill-size.test.mjs; gap, no kit test reads invocation mode; low cost.
- Every repo-relative markdown link must resolve, including links that escape the package they ship in (S6): `verify-doc-links.mjs`, after 23 links broke on npm install. Touches README.md and docs/; gap (the registry lists nothing); low cost.
- An autonomous run is capped by a stop hook that counts loops and hands back to the user at the cap, instead of asking at every step (S29): `run-stop.sh`. Touches plugin/hooks and rule 13 of the user rules (ask only for critical steps); partial, the kit counts no prompts or loops; low cost.
- A committed build output is rebuilt and compared with `git diff HEAD`, not the index, so a staged stale build cannot pass (S5): `verify-lib-sync.sh`. Touches plugin/tests/shim-parity.test.mjs (entry shims kept in step); partial, the kit commits no build output; low value.
