---
name: Atmosphere/atmosphere
pinned: https://github.com/Atmosphere/atmosphere/tree/992532da1d04e6896204eea4649e83f64c9de350
license: Apache-2.0
studied: 2026-10-28
channel: github
---

# Atmosphere/atmosphere

A JVM agent and realtime runtime that publishes to Maven Central, npm, GitHub releases, Homebrew and SDKMAN, with its release run by a Claude Code skill. Studied for the canon (sweep `261021-canon`, pass 1, top-up): the release skill and the sample-sweep skill are checklists backed by a release-workflow gate that refuses a commit the sweep did not cover.

## Evidence
- https://github.com/Atmosphere/atmosphere/blob/992532da1d04e6896204eea4649e83f64c9de350/.claude/skills/release/SKILL.md#L13-L17 "**Run every step in order and stop at the first one that fails.** A failed check is reported to the maintainer with the evidence. It is never worked around, and never answered with "CI is green, so it is probably fine": that reasoning shipped 4.0.75 without a sweep of its last three user-facing changes."
- https://github.com/Atmosphere/atmosphere/blob/992532da1d04e6896204eea4649e83f64c9de350/.claude/skills/release/SKILL.md#L27-L29 "Every open entry is either fixed or **explicitly excluded by the maintainer for this release**. An exclusion from a previous release does not carry over: ask again."
- https://github.com/Atmosphere/atmosphere/blob/992532da1d04e6896204eea4649e83f64c9de350/.claude/skills/release/SKILL.md#L50 "Pass the full SHA: `--commit` with a short SHA silently matches nothing."
- https://github.com/Atmosphere/atmosphere/blob/992532da1d04e6896204eea4649e83f64c9de350/.claude/skills/release/SKILL.md#L68-L69 "`skip_sweep_gate` is for an emergency the maintainer declares in words. It is never the agent's call."
- https://github.com/Atmosphere/atmosphere/blob/992532da1d04e6896204eea4649e83f64c9de350/.claude/skills/release/SKILL.md#L82-L84 "`gh run rerun <id> --failed` retries only the jobs that failed; - a full re-run would collide with the tag and the versions that were already published."
- https://github.com/Atmosphere/atmosphere/blob/992532da1d04e6896204eea4649e83f64c9de350/.claude/skills/release/SKILL.md#L104-L105 "Remove the release worktrees and branches. A worktree that has submodules needs `--force`; check first that it is clean and has no unpushed commits."
- https://github.com/Atmosphere/atmosphere/blob/992532da1d04e6896204eea4649e83f64c9de350/.claude/skills/release-sample-sweep/SKILL.md#L259-L262 "**proven to bite**: it must fail against the pre-fix artifact and pass after. Recording only "it passes now" proves nothing."
- https://github.com/Atmosphere/atmosphere/blob/992532da1d04e6896204eea4649e83f64c9de350/.claude/skills/release-sample-sweep/SKILL.md#L312-L317 "`release-4x.yml` runs `scripts/validate-sweep-attestation.sh` before it builds and refuses to release when any user-facing file (samples, framework main sources, the Console frontend, atmosphere.js, the CLI, any `pom.xml`) changed after that SHA."
- https://github.com/Atmosphere/atmosphere/blob/992532da1d04e6896204eea4649e83f64c9de350/scripts/validate-sweep-attestation.sh#L88 "A sweep with open findings does not clear a release."
- https://github.com/Atmosphere/atmosphere/blob/992532da1d04e6896204eea4649e83f64c9de350/.github/workflows/release-4x.yml#L798-L800 "printf '\n> **Note:** this release was published with `skip_sweep_gate`; the pre-release sample sweep does not cover it.\n' >> /tmp/release-notes.md"
- https://github.com/Atmosphere/atmosphere/blob/992532da1d04e6896204eea4649e83f64c9de350/.claude/skills/release-sample-sweep/SKILL.md#L218-L221 "CI covers `list`/`info`, argument validation, the runtime overlays, and the installers — it never boots a sample through `atmosphere run` and looks at the UI, and it has no coverage for `compose` or `checkpoint`."

## Issues and changelog
- https://github.com/Atmosphere/atmosphere/issues/2785 "`src/version.ts` is a hard-coded constant that has drifted from `package.json`"
  - Broke: the published atmosphere.js 5.0.47 reported and sent version 5.0.7 on every request. Fixed: commit 84fb6eeab9 derives `VERSION` from package.json at build time, adds a unit test, and the release preflight checks the derivation.
- https://github.com/Atmosphere/atmosphere/issues/2734 "The weekly upstream conformance check detected drift in `modules/ai/src/test/resources/ms-agent-os/`."
  - Broke: an upstream spec moved its examples, and a scheduled conformance workflow opened this issue on its own. Fixed: commit 4b3b952ae4 points the check at the new upstream spec; later runs are green.

## Lessons
- A regression test is accepted only when it is shown to fail on the pre-fix artifact and pass after (S8): the sweep's fix step. Touches plugin/skills/dev/SKILL.md:35 and :40 (Red first, then break or revert the change once and watch the test fail); overlap; none.
- A release is refused when any user-facing file changed after the commit the end-to-end check last drove, through a committed attestation holding the full SHA and a clean verdict (S6, S15): `validate-sweep-attestation.sh`. Touches README.md:34-40 (release steps; step 3 smokes the tag by hand) and plugin/lib/profile.mjs:160; gap (no record ties the smoke to the tagged commit); low cost, one attestation file and one check.
- An exclusion holds for one release only, a gate skip is the maintainer's call in words, and a skipped gate writes itself into the public release notes (S25, S2): release skill steps 1 and 4, `release-4x.yml` lines 798-800. Touches plugin/gates/profile-guard-gate.mjs and plugin/lib/prior-art.mjs:5 (waivers with no expiry and no approval record); partial; low cost.
- Each channel is checked from outside the workflow after publishing, and a version string is derived from the manifest at build time instead of kept by hand (S15): release step 6, issue 2785. Touches plugin/.claude-plugin/plugin.json and README.md:35 (manifest version equal to the tag, unchecked); gap; low cost.
- Release close-out removes the release worktrees and branches, after checking each is clean with no unpushed commits (S5). Touches plugin/lib/profile.mjs (release worktree check) and the eval arm copies under the temp directory; overlap for the release worktree, gap for eval arm cleanup; low cost.
- A scheduled conformance run against an upstream spec opens an issue when the upstream moves (S16): issue 2734. Touches plugin/evals/probes/run-probes.sh (run by hand after a Claude Code update); partial; low cost, a scheduled probe run.
- A check names the inputs it silently accepts (a short SHA matches nothing) and the surfaces CI does not cover, so a pass is not read as coverage (S8, S23): release step 3, sweep skill CLI section. Touches plugin/skills/dev/SKILL.md:37; partial (the kit names no coverage limit per check); low cost.
