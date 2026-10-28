---
name: JoelA510/agent-ready-template
pinned: https://github.com/JoelA510/agent-ready-template/tree/5b75c70984ec9bebf37d0391ebcd1d5968bd8589
license: MIT
studied: 2026-10-28
channel: github
---

# JoelA510/agent-ready-template

A React and design-token project template that ships an agent process (skills, prompts, standards, evals) to the repositories built from it. Studied for the canon (sweep `261021-canon`, pass 2): it claims a mechanism for about twenty registry problems, so each claim is checked here for real code against prompt prose.

## Evidence
- https://github.com/JoelA510/agent-ready-template/blob/5b75c70984ec9bebf37d0391ebcd1d5968bd8589/scripts/check-generated.mjs#L43 "Generated files are out of date with their sources:"
- https://github.com/JoelA510/agent-ready-template/blob/5b75c70984ec9bebf37d0391ebcd1d5968bd8589/scripts/check-upgrade-path.mjs#L6 "process over it, and fails if the second apply exits non-zero, parks anything (a file nobody"
- https://github.com/JoelA510/agent-ready-template/blob/5b75c70984ec9bebf37d0391ebcd1d5968bd8589/.github/workflows/ci.yml#L80-L81 "- name: The last release upgrades cleanly run: npm run check:upgrade-path"
- https://github.com/JoelA510/agent-ready-template/blob/5b75c70984ec9bebf37d0391ebcd1d5968bd8589/scripts/__tests__/evals.test.ts#L40 "if (skill.explicit) expect(routed, skill.name).not.toContain(skill.name)"
- https://github.com/JoelA510/agent-ready-template/blob/5b75c70984ec9bebf37d0391ebcd1d5968bd8589/scripts/__tests__/evals.test.ts#L48 "expect(prompt.allowed_tools).toEqual(['Read', 'Glob', 'Grep', 'Skill'])"
- https://github.com/JoelA510/agent-ready-template/blob/5b75c70984ec9bebf37d0391ebcd1d5968bd8589/scripts/check-instructions.mjs#L64 "is the strictest of every platform the template knows: 24,000 bytes, Antigravity's;"
- https://github.com/JoelA510/agent-ready-template/blob/5b75c70984ec9bebf37d0391ebcd1d5968bd8589/scripts/check-placeholders.mjs#L26 "(exit 1 if anything is unfinished,"
- https://github.com/JoelA510/agent-ready-template/blob/5b75c70984ec9bebf37d0391ebcd1d5968bd8589/prompts/pre-pr.md#L21-L23 "**Prove the new checks can fail.** For every test, validator, lint rule, or CI gate this change adds, show it failing against the defect it guards (a planted defect, or the fix reverted)."
- https://github.com/JoelA510/agent-ready-template/blob/5b75c70984ec9bebf37d0391ebcd1d5968bd8589/prompts/plan-change.md#L34-L35 "Otherwise it's small. Say which of the above it doesn't meet, name the test that will prove it, and stop: no plan file."
- https://github.com/JoelA510/agent-ready-template/blob/5b75c70984ec9bebf37d0391ebcd1d5968bd8589/evals/behavior/review-change-finds-the-tenancy-hole/graders/finds-it.md#L6 "PASS if the review names this cross-organization (tenant) access problem as a defect."
- https://github.com/JoelA510/agent-ready-template/blob/5b75c70984ec9bebf37d0391ebcd1d5968bd8589/.github/workflows/evals.yml#L5 "call a model, so they cost money (about $2 for the suite at three runs a case) and don't run on"
- https://github.com/JoelA510/agent-ready-template/blob/5b75c70984ec9bebf37d0391ebcd1d5968bd8589/.agents/skills/bootstrap/SKILL.md#L22-L24 "Ask, in one question, only for what neither the request, the host, nor a safe default supplies — vague inputs produce vague plans, and the prompt permits at most one blocking question thereafter."

## Issues and changelog
- https://github.com/JoelA510/agent-ready-template/issues/3 "Shown failing against planted defects (executed)"
  - Broke: re-running CI on the rc.2 release commit would fail `check:upgrade-path`, because the only tag sat on HEAD and the earlier exception covered no tags at all. Fixed: a `'head'` result, with the PR checklist naming the planted defects each new test catches; the planted-defect runs are self-attested in the PR body, not re-run by CI.
- https://github.com/JoelA510/agent-ready-template/issues/21 "The fix comes from reading the error, not from watching it fail and then pass."
  - Broke: the upgrade-path test failed once on removing its scratch repo (`ENOTEMPTY`), most likely from background git maintenance. Fixed: `gc.auto=0`, `maintenance.auto=false` and retried removal; the author states the failure was never reproduced.
- https://github.com/JoelA510/agent-ready-template/issues/35 "The scheduled dependency audit (check:audit) failed:"
  - Broke: the scheduled `check:audit` failed on main. Fixed: not yet; the issue was opened by `github-actions[bot]` from the scheduled audit and points at the waiver policy, and it is still open at the pinned sha.

## Lessons
- A generated copy is regenerated in CI and the job fails on any modified, deleted or new file under the generated paths, which also catches an orphan whose source was retired (S5, S18): `check:generated` covers `.claude/skills` built from `.agents/skills`. Touches plugin/tests/shim-parity.test.mjs (every shim names a module and every module has a shim); partial; low cost.
- The last release is upgraded to this commit in CI before a release ships, and "nothing to upgrade from" exits 2 except for a full clone that has never released (S19, S2): `check-upgrade-path.mjs` is real code with tests and a CI step. Touches the doctor release check at plugin/lib/profile.mjs:147-164 (tag of the worktree only); gap; medium cost.
- Eval cases are machine-checked for invocation mode and tool grants (S7, S9): a vitest test fails if an explicit-only skill has a routing case or any case grants more than Read, Glob, Grep and Skill. Touches plugin/evals (the `/tedy:dev` prefix is a convention in each case); gap for a check over every case; low cost.
- "Prove the new checks can fail" is prompt prose, self-attested in each PR body, and nothing machine-checks it (S8): PR #3 lists planted defects, PR #21 says the fix was never seen failing. Touches the negative cases in plugin/tests/sweep-record.test.mjs and the `red-before-source` grader of ADR 0010; overlap for the kit's own gates, the same self-attested gap for new checks; low cost.
- Planning depth is chosen by a written trigger list (data model, public API, auth, a new dependency, behaviour others rely on, unknown cause), and a small change stops with no plan (S28): `prompts/plan-change.md` step 0, with one behavior eval that runs by hand or monthly opt-in, never on pull requests. Touches the canon plan convention; gap (the registry has nothing); low cost, copy the trigger list.
- Shared instruction files are held to the strictest documented limit among the agents a project selects, and each limit records its source page and date (S22, S11): `check-instructions.mjs` with `agent-platforms.mjs`. Touches plugin/lib/profile.mjs:112 (`RULES_BUDGET = 6000`) and plugin/tests/skill-size.test.mjs; overlap for size, gap for sourcing each limit; low cost.
- A question cap and a sibling sweep after a root-cause fix are skill and prompt prose only (S29, S17): `bootstrap` allows one question up front and one blocking question after; `root-cause` asks to "find sibling occurrences". Touches user rule 13 and the Blast radius steps at plugin/shared/source-access.md:44; overlap in kind (also prose); none.
