---
name: fagenorn/nix-config
pinned: https://github.com/fagenorn/nix-config/tree/8212d8fb8e933120db864339e9a8d0d174462268
license: NOASSERTION
studied: 2026-10-30
channel: github
---

# fagenorn/nix-config

A supplement of sweep 261021-canon, not reference-labelled: a personal Nix configuration (no LICENSE file, so `NOASSERTION`; studied and quoted in short excerpts, never copied) whose agent-skills unittest fails when a custom agent's `model` or `effort` drifts from a declared role matrix, and pins the exact set of agents that run with `omitClaudeMd`, studied for S32 techniques T4 (reviewer spawn context) and T6 (reviewer model pinned from measured parity, the pin-matrix test), though the matrix values are declared, not measured for parity, the evaluation runs deterministic trace fixtures without paid agents, and its full reviewer deliberately keeps CLAUDE.md.

## Evidence
- https://github.com/fagenorn/nix-config/blob/8212d8fb8e933120db864339e9a8d0d174462268/home/common/agent-skills/tests/test_agent_model_matrix.py#L393-L394 "self.assertIn("model", metadata, path)"
- https://github.com/fagenorn/nix-config/blob/8212d8fb8e933120db864339e9a8d0d174462268/home/common/agent-skills/tests/test_agent_model_matrix.py#L397-L398 "self.assertEqual(metadata["effort"], data["roles"][role]["effort"], path)"
- https://github.com/fagenorn/nix-config/blob/8212d8fb8e933120db864339e9a8d0d174462268/home/common/agent-skills/tests/test_agent_model_matrix.py#L813 "def test_omitted_agent_model_fails(self):"
  - A fixture agent without `model:` must make the validator report an error.
- https://github.com/fagenorn/nix-config/blob/8212d8fb8e933120db864339e9a8d0d174462268/home/common/agent-skills/model-matrix.json#L86-L88 ""model": "sonnet","
  - The `reviewer-lite` role, at medium effort; `reviewer` at lines 60-62 is opus at high effort.
- https://github.com/fagenorn/nix-config/blob/8212d8fb8e933120db864339e9a8d0d174462268/home/common/agent-skills/tests/test_agent_model_matrix.py#L400 "def test_only_the_brief_driven_agents_omit_claude_md(self):"
- https://github.com/fagenorn/nix-config/blob/8212d8fb8e933120db864339e9a8d0d174462268/home/common/agent-skills/tests/test_agent_model_matrix.py#L411-L412 ""reviewer": None,"
  - The exact map: `mechanic` and `reviewer-lite` omit CLAUDE.md; `implementer`, `issue-owner` and `reviewer` keep it.
- https://github.com/fagenorn/nix-config/blob/8212d8fb8e933120db864339e9a8d0d174462268/home/common/claude-code/agents/reviewer-lite.md#L7 "omitClaudeMd: true"
- https://github.com/fagenorn/nix-config/blob/8212d8fb8e933120db864339e9a8d0d174462268/home/common/claude-code/agents/reviewer.md#L3 "Reviews a diff, plan, or file set against the rubric pasted into the dispatch brief. Read-only."
- https://github.com/fagenorn/nix-config/blob/8212d8fb8e933120db864339e9a8d0d174462268/.agents/artifacts/specs/2026-08-14-cost-aware-model-matrix-design.md#L98-L99 "representative workflow decisions emit role/model/effort records without launching paid remote agents"
- https://github.com/fagenorn/nix-config/blob/8212d8fb8e933120db864339e9a8d0d174462268/.agents/artifacts/specs/2026-08-14-cost-aware-model-matrix-design.md#L176 "keep live dispatch as a manual demo only."
- https://github.com/fagenorn/nix-config/blob/8212d8fb8e933120db864339e9a8d0d174462268/.agents/artifacts/plans/2026-10-25-issue-425-startup-overhead.acceptance.md#L22 "reviewer-lite 1 10.07k 0 - 15.11k"
  - Before: first-request cache write 10.07k tokens, 15.11k characters of instructions.
- https://github.com/fagenorn/nix-config/blob/8212d8fb8e933120db864339e9a8d0d174462268/.agents/artifacts/plans/2026-10-25-issue-425-startup-overhead.acceptance.md#L35 "reviewer-lite 1 2.02k 2.23k"
  - After: 2.02k written, 2.23k read, no instructions; one subagent per arm.
- https://github.com/fagenorn/nix-config/blob/8212d8fb8e933120db864339e9a8d0d174462268/.agents/artifacts/plans/2026-10-25-issue-425-startup-overhead.acceptance.md#L184 "VERDICT: PASS (9/9 asserts)"
  - The no-regression check: one trial of a from-issue pipeline eval with structural asserts (worktree, spec, plan, commits), not a score of reviewer-lite's review output.

## Issues and changelog
At least 200 closed issues; the most-commented are about release and platform design, so the items below were picked by relevance to Q16 and Q20 (issue 425 has 3 comments, issue 15 none, PR 427 none). No changelog file.
- https://github.com/fagenorn/nix-config/issues/15 "Give the issue-delivery pipeline an explicit, cost-aware model matrix so no important role silently inherits the caller's model."
  - Broke: the implementer and reviewer omitted a model and several dispatches inherited the caller's, so one role ran at different cost by caller. Fixed: the role matrix, `model` and `effort` on every agent, and the drift test; the acceptance asks for a trace, not parity.
- https://github.com/fagenorn/nix-config/issues/425 "`omitClaudeMd` only on reviewer-lite and mechanic."
  - Broke: every subagent carried the skill listing, CLAUDE.md and connector instructions at start-up, put at about USD 0.9k list price per 14 days. Fixed: PR 427 below, with a before and after cost table and a one-trial pipeline eval.
- https://github.com/fagenorn/nix-config/pull/427 "The mechanic and reviewer-lite agent definitions declare omitClaudeMd: true, so these brief-driven agents start without CLAUDE.md; implementer and reviewer keep it."
  - Broke: see issue 425. Fixed: the flag on two agents, the exact-set test, hidden skills and a connector-free orchestration launcher.

## Lessons
- Pin each agent's `model` and `effort` against one declared matrix and fail on drift or omission (Q20, S32): test lines 393-398 and 813. Touches plugin/agents/reviewer.md:1-5 (pins neither) and plugin/skills/review-pr/SKILL.md:33 (spawns `tedy:reviewer` with no model); gap; low cost for the static pin, but T6 asks for the pin from measured parity, and this source has none: its evaluation is trace fixtures (spec lines 98-99, 176) and issue 15 asks for a trace. The parity eval of T6 (USD 9-12 per model tried) is not replaced by this test.
- Pin the exact set of agents that omit CLAUDE.md, so adding or dropping the flag is a visible test change (Q16, S32): test lines 400 and 411-412. Touches plugin/agents/reviewer.md:1-5 and a case beside the canon checks in plugin/tests/canon-checks.test.mjs; gap; low cost.
- The source omits CLAUDE.md only on brief-driven agents and keeps it on the full reviewer, a counter-signal to T4 as written (Q16): PR 427, issue 425, test line 411. The kit's reviewer gets a structured brief (reviewer.md:9-17) but its standards lens judges against the repository's own rules (reviewer.md:27), closer to this source's full reviewer than to reviewer-lite. Neither source measured review quality with and without the flag, so the T4 arm decides; renchris/claude-infrastructure (see its card) applies the flag to write-capable research agents with the contract restated.
- Measure start-up tokens before and after per agent type, then run a no-regression eval (Q16, Q24, Q25): acceptance lines 22, 35 and 184. Touches plugin/evals/pressure/grade-pressure.mjs and docs/adr/0009-fact-based-ablation-evals.md; partial, one subagent per arm and one eval trial is a smoke check, short of the n=5 arms the quota matrix plans; low cost to borrow the table shape.
- Not covered: effort chosen per task at run time, plugin SubagentStart injections, any measured parity for the cheaper roles (reviewer-lite on sonnet, explorer on sonnet), quality of a reviewer without CLAUDE.md.
