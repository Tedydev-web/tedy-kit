---
name: Q00/ouroboros
pinned: https://github.com/Q00/ouroboros/tree/842b1020d063a4a9968be90de99d5f093c6b196d
license: MIT
studied: 2026-10-28
channel: github
---

# Q00/ouroboros

A specification-first agent workflow engine (interview, seed, execute, evaluate, evolve) shipped as a Claude Code plugin and MCP server. Studied for the canon (sweep `261021-canon`, pass 1): its CI gates each name the rule they enforce, its grandfather list can only shrink against the base branch, and its changelog records gates measured wrong on real runs.

## Evidence
- https://github.com/Q00/ouroboros/blob/842b1020d063a4a9968be90de99d5f093c6b196d/CLAUDE.md#L95-L96 "**enforce-module-size** — 2000-line cap per module; grandfathered modules may shrink, never grow, and no new entries."
- https://github.com/Q00/ouroboros/blob/842b1020d063a4a9968be90de99d5f093c6b196d/scripts/check-module-size.py#L35-L37 "The proposed policy is therefore compared with the base branch's: no key or exclusion may be added, no budget may increase, neither numeric limit may rise, and measurement scope must remain identical."
- https://github.com/Q00/ouroboros/blob/842b1020d063a4a9968be90de99d5f093c6b196d/scripts/check-module-size.py#L417 "baseline policy: an unchecked table can grandfather anything."
- https://github.com/Q00/ouroboros/blob/842b1020d063a4a9968be90de99d5f093c6b196d/scripts/check-max-turns-envelope.py#L13-L15 "The guard walks the AST of ``src/ouroboros/`` and exits non-zero if any keyword call passes ``max_turns=1`` without a co-located empty ``allowed_tools``."
- https://github.com/Q00/ouroboros/blob/842b1020d063a4a9968be90de99d5f093c6b196d/tests/_envelope_wiring.py#L3-L5 "These helpers mirror the production guard at ``scripts/check-max-turns-envelope.py`` so per-file wiring tests cannot drift from the canonical CI-enforced semantics."
- https://github.com/Q00/ouroboros/blob/842b1020d063a4a9968be90de99d5f093c6b196d/scripts/check-auto-perf-budget.py#L5-L7 "it does not parse the table, run any benchmarks, or compare against historical baselines. It only verifies the **presence** of the structured section"
- https://github.com/Q00/ouroboros/blob/842b1020d063a4a9968be90de99d5f093c6b196d/src/ouroboros/orchestrator/evidence/test_reexecution.py#L30 "_SHELL_METACHARACTERS = frozenset("`$;&|<>(){}\n\r")"
- https://github.com/Q00/ouroboros/blob/842b1020d063a4a9968be90de99d5f093c6b196d/skills/evaluate/SKILL.md#L21 "Without an executed Stage 1 check the outcome is `acceptance_state: unverified` (not approved), with the model review attached as feedback."
- https://github.com/Q00/ouroboros/blob/842b1020d063a4a9968be90de99d5f093c6b196d/skills/auto/SKILL.md#L26-L28 "If `ouroboros_start_auto` or a required job wait/result tool is unavailable, stop and report that the required MCP tool is unavailable. A manual fallback is not an `ooo auto` run."
- https://github.com/Q00/ouroboros/blob/842b1020d063a4a9968be90de99d5f093c6b196d/skills/auto/SKILL.md#L76-L77 "Before a fresh start, do not ask about an efficiency policy unless the user raised it"
- https://github.com/Q00/ouroboros/blob/842b1020d063a4a9968be90de99d5f093c6b196d/.github/workflows/release.yml#L77 "echo "Package version $PACKAGE_VERSION does not match release tag $VERSION" >&2"
- https://github.com/Q00/ouroboros/blob/842b1020d063a4a9968be90de99d5f093c6b196d/CHANGELOG.md#L18 "On real product runs the shipped gates rejected about 4 of 10 correct patches and still accepted 3 of 5 wrong ones."

## Issues and changelog
- https://github.com/Q00/ouroboros/issues/765 "The intentional `max_turns=1` setting (`authoring_handlers.py:1254`) collides with modern Claude (Opus 4.x) that frequently emits a tool-use block before final text"
  - Broke: after a model upgrade the interview tool failed about 90% of calls because the model spent its only turn on a tool call. Fixed: an empty `allowed_tools` envelope on that call site (PR 770).
- https://github.com/Q00/ouroboros/issues/781 "A repository-wide grep for `max_turns=1` (or `max_turns = 1`) finds **9 additional unguarded sites** still using the same risky pattern"
  - Broke: the fix for 765 covered one call site of nine. Fixed: the sweep fixed all sites, then `check-max-turns-envelope.py` and its workflow locked the pairing in CI.
- https://github.com/Q00/ouroboros/issues/2449 "Model judgment can grant acceptance on two paths today, with no executed verification behind it."
  - Broke: the evolve fallback and `ouroboros_evaluate` approved work on a model verdict alone. Fixed: approval now needs at least one executed Stage 1 check; otherwise the result is `unverified`.
- https://github.com/Q00/ouroboros/issues/1802 "Today that lease never expires — terminal runs leave their worktrees behind, and reclamation depends on a human remembering `ouroboros cleanup`."
  - Broke: managed task worktrees piled up (26 GB on one machine, a disk filled before). Fixed in part: PR 1803 made `prune-merged` the default; reclaiming at run end and at startup is still open.
- https://github.com/Q00/ouroboros/blob/842b1020d063a4a9968be90de99d5f093c6b196d/CHANGELOG.md#L28 "The no-evidence check now fires. It required no untracked file at all, but the product writes `.ouroboros/context_pack.json` and `.ouroboros/traces/` into the workspace before the worker starts, so it never fired on a real run."
  - Broke: a check that passed its tests never fired on a real run, because the product itself writes files before the worker starts. Fixed: "no change" now compares `HEAD`, the diff and the untracked files with the run start, leaving out the product's own state directory.

## Lessons
- A grandfather list is checked against the base branch's copy, so an entry can be removed or its budget lowered but never added or raised, and the gate fails when it cannot read the base copy (S2, S25): `check-module-size.py`. Touches plugin/lib/prior-art.mjs:5 (names only, can grow freely) and plugin/lib/sweep-method-evidence.mjs:8 (keyed by sha256, so an edit drops the waiver); partial; low cost, one test comparing the set with the previous tag.
- A defect class found at one call site is grepped across the tree, fixed everywhere, then locked by a CI guard whose test helpers import the guard's own logic (S17, S4): issues 765 and 781, `check-max-turns-envelope.py`, `tests/_envelope_wiring.py`. Touches plugin/skills/dev/SKILL.md:37 (Blast radius steps); partial (the kit sweeps but adds no guard that keeps the class out); low cost per class.
- A gate is measured on real runs, and one that misjudges is demoted to record-only until fixed; a check that never fires on a real run is a bug even when its tests pass (S8): CHANGELOG lines 18 and 28. Touches plugin/evals and plugin/tests; gap (the kit validates graders on fixtures, never logs a gate's false accepts and rejects on real sessions); medium cost.
- Model verdicts can withhold approval but never grant it; with no executed check the outcome is `unverified` (S9, S10): `skills/evaluate/SKILL.md`, issue 2449. Touches plugin/skills/dev/SKILL.md:37 and docs/adr/0010-dev-red-step-and-honest-green.md; overlap; none.
- A behaviour that changed with a newer model (tool use before text) is caught as a production failure, not by re-measurement (S30): issue 765. Touches docs/adr/0010-dev-red-step-and-honest-green.md (model ids recorded); gap, same as the registry; medium cost.
- A command the harness runs on its own authority is refused unless it tokenises with no shell metacharacters, then runs as a direct argv inside the workspace (S26): `test_reexecution.py`. Touches plugin/gates/git-gate.mjs; overlap (refuse what cannot be read, ask for a plain command); none.
- A skill whose tool is missing stops and says so instead of doing the work by hand, and a setting the user did not raise is not asked about (S7, S29): `skills/auto/SKILL.md`. Touches plugin/skills/dev/SKILL.md and plugin/shared/decision-points.md (how a skill asks; the user rules say when); overlap for S29, partial for S7 (a search of plugin/skills and plugin/shared found no rule for a missing script or MCP tool); low cost.
- A gate that checks only that a measurement section is present says so in its own header, and the release fails when the built package version differs from the tag (S10, S15, S23): `check-auto-perf-budget.py`, `release.yml`. Touches plugin/lib/sweep-record.mjs:67-73 (measured ADRs need 2 arms holding numbers, presence only too) and plugin/.claude-plugin/plugin.json; overlap for S10, gap for S15 (no manifest-versus-tag check); low cost.
