# 0011: The kit's development standard (canon): a versioned rule ledger with a check behind every rule

Status: accepted (2026-10-28): option A, built in the four phases below

## Context
- The registry `docs/prior-art/problems-canon.md` lists 32 behaviours a kit-development standard must get right (S1-S32): versioning the standard, redoing or waiving old artifacts, naming what enforces each rule, release, retirement, measurement and cost. Its "mitigated by" column shows most of them held by prose or by one check each.
- Sweep `261021-canon` stopped at the scale checkpoint (`docs/prior-art/sweeps/261021-canon.md`): stage 1 and the judges could not be certified, and the user chose deep reading. Eighteen cards cover fifteen purposive picks from the reference-eligible rows and a three-source supplement; every registry problem is held by two or more studied sources, S27, S30, S31 and S32 only in part.
- Across the 120 lessons in those cards, the gaps marked most often are: the manifest version against the release tag (S15, 11 lessons mark a gap), a check on the commands and links in published docs (S6, 7), old artifacts judged by the rules they were made under and waivers that can only shrink (S1 and S2, 11 gaps and 6 partial), a named check behind each rule (S23, 5), and model change, rule re-measurement and quota checks (S30, S31, S32, 10).
- Deep reading also showed what to avoid: in 9 of the 15 picks a "machine check" was weaker than claimed (a test that checks its own fixtures, a preflight that regenerates its snapshots, advisory gates, a gate that only checks a section exists). A check that cannot fail is the most common failure of a standard.
- The user decided (2026-10-28) that the canon is a knowledge base for building new skills and roles: the cards, the registry and this ADR form the canon, and each future role gets its own topic config that reuses the canon cards and adds its own problems.

## Options

Each option is scored by the registry problems it would hold with a machine check (full) or with a check that reports but does not fail (part).

| Option | What is built | Full | Part | Cost |
|---|---|---|---|---|
| A. Versioned rule ledger with a check behind every rule | `docs/canon/standard.json`: each rule has an id, its text, the standard version that added it, its reason and class (model gap, user policy, platform) and the test or gate that enforces it; `npm test` fails a rule without an existing enforcing check, an artifact without a standard-version stamp, a waiver list that grows against the base branch, a manifest version that differs from the release tag, a dead link or a command in a published doc that does not run, and a retired surface still named. Evals record the model id and refuse a rebaseline that turns a pass into a fail without an explicit model-change flag; model-gap rules are ablated on a model change and proposed for removal in one batch, never deleted automatically. | S1, S2, S3, S5, S6, S8, S13, S15, S18, S23, S30 | S16, S24, S25, S27, S31, S32 | about 3-4 build sessions, phased |
| B. Missing checks only | The manifest-tag, doc-link, retired-surface and description-length checks in `npm test`; the standard stays prose in README.md and rules.md | S6, S12, S15, S18 | S8 | about 1 session |
| C. Adopt an external config linter | An outside linter for SKILL.md, hooks and agent files (for example agnix) in CI, with the kit's own rules as prose | none | S12, S22 | low build, a new dependency outside the kit's control |
| D. Keep the current state | nothing | none | none | none |

## Recommendation
Option A, built in phases ordered by how many studied sources show the gap, each phase a check that is shown to fail on a wrong fixture before it is trusted (S8):

1. Release and docs: manifest version against the tag (S15), dead links and runnable commands in published docs (S6), retired surfaces (S18).
2. The ledger: `standard.json` with reason, class and enforcing check per rule (S23), the date the user approved it (S25, recorded, not enforced), and the test that fails a rule without its check. A rule no machine can check is enforced by review and must say why no machine can check it (`whyNotMachine`); every other rule names a test by its file and exact title.
3. Versioning: a standard-version stamp on every artifact, checks gated by the version that added them so an old artifact is judged by its own rules, and a waiver list that may only shrink (S1, S2, S3, S13). The user chose (2026-10-28) a central register, `docs/canon/conformance.json`, over a stamp in each file: it maps every skill, ADR, card and sweep record to the version it conforms to, and an artifact missing from it fails. Each rule names its scope (skill, adr, card, sweep or repo); the skill-scoped tests skip a skill registered below the rule's version or waived from it. ADRs keep their grandfathered list and sweep records their pinned criteria, the gating they already had. A waiver may be added only together with a new standard version; against the latest release the list otherwise only shrinks, a registered version never goes down, and a new artifact is registered at the current version. The standard's history records each version's trigger, change and the artifacts it redid.
4. Model change: model ids in eval results, a rebaseline that refuses pass-to-fail without a model-change flag (S30), and a per-rule ablation for model-gap rules that proposes removals and never deletes (S31).

S27 and S32 stay partial: no studied source fails an artifact on a harness-surface or quota-efficiency check, so the kit would be first; they wait for evidence.

## Prior art

- Q00/ouroboros (MIT, studied 2026-10-28, via github)
  - card: ouroboros
  - https://github.com/Q00/ouroboros/blob/842b1020d063a4a9968be90de99d5f093c6b196d/scripts/check-module-size.py#L35-L37 "The proposed policy is therefore compared with the base branch's: no key or exclusion may be added, no budget may increase, neither numeric limit may rise, and measurement scope must remain identical."
  - https://github.com/Q00/ouroboros/blob/842b1020d063a4a9968be90de99d5f093c6b196d/.github/workflows/release.yml#L77 "echo "Package version $PACKAGE_VERSION does not match release tag $VERSION" >&2"
  - https://github.com/Q00/ouroboros/blob/842b1020d063a4a9968be90de99d5f093c6b196d/scripts/check-auto-perf-budget.py#L5-L7 "it does not parse the table, run any benchmarks, or compare against historical baselines. It only verifies the **presence** of the structured section"
  - Lesson: a grandfather list is safe only when the check compares it with the base branch and refuses growth; a check that verifies only that a section exists is not a check.
  - Taken: the waiver list that may only shrink (phase 3), the manifest-tag check (phase 1), and "shown to fail" for every check.
- SerhiiKorniienko/bullshit-detector (MIT, studied 2026-10-28, via github)
  - card: bullshit-detector
  - https://github.com/SerhiiKorniienko/bullshit-detector/blob/d5f6156a8a5c72977bf2d4edae834dd22f7fa736/skills/analysis/bullshit-detector/scripts/tally.py#L368-L370 "Every `*_SINCE` must be <= the version in the manifest. A check gated at a version that never ships never fires, and does so silently"
  - https://github.com/SerhiiKorniienko/bullshit-detector/blob/d5f6156a8a5c72977bf2d4edae834dd22f7fa736/scripts/write-version-files.py#L12-L14 "The single source of truth stays `.claude-plugin/plugin.json`; this script propagates it, and `tally.py --self-test` fails loudly when a VERSION file drifts from the manifest"
  - Lesson: an artifact stamped with the release that made it is judged by that release's rules, and a check's own version gate is itself checked.
  - Taken: version stamps and version-gated checks (phase 3).
- anthropics/claude-agent-sdk-python (MIT, studied 2026-10-28, via github)
  - card: claude-agent-sdk-python
  - https://github.com/anthropics/claude-agent-sdk-python/blob/c01a99416a02805b0a050d058da51bde53f6df64/CLAUDE.md#L75-L76 "It cannot see a job that calls Claude another way, so check new workflows by hand too."
  - https://github.com/anthropics/claude-agent-sdk-python/blob/c01a99416a02805b0a050d058da51bde53f6df64/CLAUDE.md#L79 "Do not skip or weaken the check."
  - Lesson: each rule names the check that enforces it and what that check cannot see.
  - Taken: the enforcing check per rule in the ledger (phase 2), with a "not covered" field.
- orchidautomation/pluxx (MIT, studied 2026-10-28, via github)
  - card: pluxx
  - https://github.com/orchidautomation/pluxx/blob/80f67d2486e437e82839b06f2b7b9f9589b82b91/scripts/check-proof-freshness.ts#L38-L39 "const expectedTag = `v${packageJson.version}` const tagExists = git('tag', '--list', expectedTag) === expectedTag"
  - https://github.com/orchidautomation/pluxx/blob/80f67d2486e437e82839b06f2b7b9f9589b82b91/src/proof-freshness.ts#L214 "if (/\bhistorical\b/i.test(line)) return"
  - Lesson: a release proof is tied to the package version and tag, but a waiver keyed on a free word in a line is a hole.
  - Taken: the manifest-tag check (phase 1); waivers carry a reason field, never a keyword.
- wangqiqi/planrun (MIT, studied 2026-10-28, via github)
  - card: planrun
  - https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/scripts/verify-planrun.sh#L210 "FAIL: $skill_md references a retired surface"
  - https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/scripts/verify-doc-links.mjs#L3 "every repo-relative markdown link must resolve."
  - https://github.com/wangqiqi/planrun/blob/80d200fc0cd50661ae7f7449965ed7f34d9b160d/scripts/planrun-doctor.mjs#L20-L21 "A check that has no reference to compare against is * SKIP — never a fabricated failure."
  - Lesson: retired names and dead links are cheap machine checks; a check without a reference reports skip, not fail.
  - Taken: retired-surface and doc-link checks (phase 1).
- nano-step/eval-harness (MIT, studied 2026-10-28, via github)
  - card: eval-harness
  - https://github.com/nano-step/eval-harness/blob/002aafee3ed60ab6cde5acda8cdb49f70e2ca2c5/scripts/eval/rebaseline.sh#L58 "rebaseline refuses PASS-to-FAIL changes without --accept-model-change"
  - https://github.com/nano-step/eval-harness/blob/002aafee3ed60ab6cde5acda8cdb49f70e2ca2c5/scripts/eval/lib/budget.sh#L19 "Sum measured cost_usd only; unavailable entries never masquerade as zero spend."
  - Lesson: a model upgrade must not launder a regression into a new baseline, and missing cost is reported as missing, not zero.
  - Taken: the model-change rebaseline rule (phase 4).
- dshakes/compass (MIT, studied 2026-10-28, via github)
  - card: compass
  - https://github.com/dshakes/compass/blob/fb41822123b4b556079b9a1c945c2521404ec978/scripts/compass-ablate.sh#L23 "unmeasured    removing it changes nothing. Add a corpus case, THEN decide. Never auto-delete."
  - https://github.com/dshakes/compass/blob/fb41822123b4b556079b9a1c945c2521404ec978/.github/workflows/ci.yml#L129 "run: bash scripts/compass-ablate.sh --gate"
  - Lesson: a per-rule ablation in CI finds rules that hurt or do nothing, and proposes rather than deletes.
  - Taken: the model-gap rule ablation that proposes removals in one batch (phase 4).
- ClaudeDevs post on the Agent Skills roadmap (public post, studied 2026-10-28, via x)
  - https://x.com/ClaudeDevs/status/2113328529911730587 "The committee's first priority is a roadmap: versioned releases, a formal proposal process, and security guidance for skill authors and users."
  - Lesson: the Agent Skills standard itself is moving to versioned releases and a proposal process, so a kit standard that versions its rules and records each change follows the ecosystem.
  - Taken: a version on the standard and a recorded proposal per change (phases 2-3).
- Lance Martin post on the claude-api prompt audit (public post, studied 2026-10-28, via x)
  - https://x.com/RLanceMartin/status/2095170001175199771 "run it in Claude Code to fix common prompting "anti-patterns" that can hobble frontier models"
  - Lesson: instructions written for older models hurt newer ones, so rules that compensate for a model gap need re-measurement on a model change.
  - Taken: the rule class field and the model-gap ablation (phases 2 and 4).

## Consequences
- Option A turns the canon from prose into a ledger the tests read; every new rule costs one enforcing check and one failing fixture.
- The standard version becomes part of every artifact, so a version bump has a migration cost that the waiver list makes visible.
- The weakest link: the picks come from a calibration sample and the reference overstated nine of them, so the canon rests on the code the cards checked, not on the labels.
