---
name: mattpocock/skills
pinned: https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d
license: MIT
studied: 2026-11-03
channel: github
domains: agent-skills, governance, testing
use-when: you write or prune a skill's text, decide model- versus user-invocation, or record why a requested change was refused
---

# mattpocock/skills

Matt Pocock's small, curated set of about 25 promoted engineering and productivity skills (v1.3.2, shipped as a Claude Code plugin and through skills.sh to other harnesses), studied because the master plan names it the reference for deep, focused skills. Its strongest assets are not the skills' procedures but the authoring discipline around them: the `writing-for-agents` skill (context pointers, the two loads, leading words, no-op hunting, prompting the positive), a strict model-invoked versus user-invoked split with a rule for each description, a one-file-per-concept ledger of rejected ideas in `.out-of-scope/` that issues are closed against, and an issue bar that accepts only failures observed in a real session. Weak spots: no tests or evals of skill behaviour (changesets only), and many fixes are declined as "edit your own copy".

## Evidence
- https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/SCOPE.md#L9 "It describes something that went wrong in a real session"
- https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/SCOPE.md#L12 "Reactions and +1 comments do not count towards it."
- https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/.out-of-scope/subagent-recursion.md#L7 "The harness should be responsible for stopping infinite subagent loops, not skills."
- https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/.agents/invocation.md#L5 "Strip trigger lists"
- https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/.agents/invocation.md#L16 "Naming the tool is what gets it fired"
- https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/AGENTS.md#L27 "Every skill that dispatches a subagent says to start it with a fresh context window."
- https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/productivity/writing-for-agents/SKILL.md#L74 "steering by prohibition drags the forbidden behaviour into context"
- https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/productivity/writing-for-agents/SKILL.md#L79 "Cache what the agent cannot find by looking"
- https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/productivity/writing-for-agents/SKILL.md#L81 "an instruction the model already obeys by default pays load to say nothing"
- https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/tdd/SKILL.md#L31 "Expected values must come from an independent source of truth"
- https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/code-review/SKILL.md#L23 "A bad ref or empty diff should fail here, not inside two parallel sub-agents."
- https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/code-review/SKILL.md#L89 "Reporting them separately stops one axis from masking the other."
- https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/diagnosing-bugs/SKILL.md#L66 "jumping straight to a hypothesis is the exact failure this skill prevents."
- https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/diagnosing-bugs/SKILL.md#L125 "against a pristine copy to prove the mutation landed before you trust it."
- https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/productivity/grilling/SKILL.md#L30 "Do not act on it until the user confirms you have reached a shared understanding."

## Issues and changelog
- https://github.com/mattpocock/skills/issues/955 "a test that never went red has verified nothing."
  - Broke: an agent forced a red with a BSD `sed` edit that exited 0 and changed nothing, then trusted the red. Fixed in v1.3.2 (#1209): Phase 5 step 2 now diffs the forced mutation against a pristine copy before trusting it.
- https://github.com/mattpocock/skills/issues/240 "When GPT runs out of questions, it begins implementing directly."
  - Broke: after a grilling session GPT-5.5 started implementing without being asked. Fixed: `grill-me` and `grill-with-docs` now run the shared `grilling` skill, which ends with "Do not act on it until the user confirms".
- https://github.com/mattpocock/skills/issues/614 "it repeatedly asserted how other skills behaved, or recommended skipping their documented steps, without first checking the relevant SKILL.md"
  - Broke: the `ask-matt` router answered from its own one-line summaries and told the user to skip `/to-spec`. Fixed in v1.3.2 (#1194): the router reads the skill's SKILL.md before stating what it does or recommending a skip.
- https://github.com/mattpocock/skills/issues/573 "those sub-agents regularly invoke `/code-review` themselves, causing each one to spawn two more review agents"
  - Broke: the Standards and Spec reviewers re-invoked the review skill and fanned out recursively. Not fixed in the skill: closed not planned, recursion limits belong to the harness (`.out-of-scope/subagent-recursion.md`); PR #1186 adding leaf-reviewer lines was closed unmerged.
- https://github.com/mattpocock/skills/issues/483 "the collision also bites *inside* the plugin"
  - Broke: a bare `code-review` name resolved to Claude Code's built-in review, so `implement` closed out with the wrong review. Not renamed: closed not planned, the way through is the namespaced `/mattpocock-skills:code-review` (`.out-of-scope/harness-name-collisions.md`).
- https://github.com/mattpocock/skills/issues/508 "Adding configuration is not free, in fact it's a cost you can't walk back."
  - Broke: `implement` committed but never closed or marked the ticket, so the `to-tickets` frontier never advanced. Closed as completed, but nothing changed upstream: the maintainer declined a per-team close-out step and told users to edit their copy.
- https://github.com/mattpocock/skills/issues/360 "I won't strip them or branch the frontmatter per harness"
  - Broke: Codex's validator rejected `disable-model-invocation` and `argument-hint`. Not fixed: closed not planned; the reporter later found Codex ignores the extra keys at install.
- Changelog v1.3.2 (#1341): every skill that dispatches a subagent now says to start it with a fresh context window, because Codex forks the parent conversation by default and the subagent inherits the context it was meant to escape.

## Lessons
- Prove a forced red actually changed the file before trusting it (#955): touches `plugin/skills/dev/SKILL.md:40` ("Break or revert the change once and watch its new test fail"), which never checks the break landed; gap; cost low (one clause: show `git diff` of the break before running the test).
- A user-invoked skill's description is for the human browsing commands, with trigger lists stripped (invocation.md line 5): touches `plugin/skills/dev/SKILL.md:3` and `:5`, and the same pair in `learn`, `reconcile` and `setup`, whose descriptions carry "Use for ..." or "Use when ..." triggers under `disable-model-invocation: true`; gap; cost low. This settles the "description trap" the superpowers card left unverified.
- Keep a one-file-per-concept ledger of rejected ideas listing every prior request, and close issues against it: overlap with `docs/adr/0007-considered-and-rejected.md:10` (option and reason in one table); the kit lacks the prior-request list and the per-concept file; cost low. The kit's rejection of a router skill (0007 line 15) is backed by #614: a router that answers from its own summaries lies.
- Accept a change request only on an observed failure in a real session, never on votes or "it would be better if": touches nothing yet (the kit's `/tedy:learn` promotes repeated user feedback, a stronger trigger for one user); overlap in spirit; cost low if written into the ADR template.
- Fail a bad ref or empty diff before fanning out parallel reviewers (code-review line 23): touches `plugin/skills/dev/SKILL.md:41` (three `tedy:reviewer` lenses spawned with no non-empty-diff check); gap; cost low.
- Keep review axes separate and never rerank across them (code-review line 89): overlap with `plugin/agents/reviewer.md:37` (no severity scores) and the three separate lenses at `plugin/skills/dev/SKILL.md:41`; no change.
- Subagents start with a fresh context and recursion is bounded by the harness, not by skill prose: overlap with `plugin/agents/reviewer.md:4` (tools list has no Agent or Task, so it cannot fan out) and `:6` (`omitClaudeMd: true`); the kit is stronger, it enforces both in the agent definition; no change.
- Expected values come from an independent source of truth: overlap with `plugin/skills/dev/SKILL.md:35` ("Expected values are literals from the request or spec"); no change.
- Prompt the positive and hunt no-ops sentence by sentence, deleting any line the model already obeys by default: touches the kit's skill-review practice (nothing yet mechanical; `plugin/tests/skill-size.test.mjs:10` caps size only); gap; cost medium, since judging a no-op needs a run with and without the line (ADR 0009 ablation).
- Not taken: pre-agreed test seams confirmed with the user before any test (tdd line 22) would add a question to every `/tedy:dev` run while the user is often away; the kit keys red-first to bug fixes and logic changes instead (`plugin/skills/dev/SKILL.md:35`).
