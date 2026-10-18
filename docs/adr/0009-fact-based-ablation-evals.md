# 0009: Kit changes are measured with fact-based ablation evals

Status: accepted (2026-10-18)

Clarifies: the row "Blind LLM-judge acceptance" in 0007.

## Context
- 0007 rejected an LLM judge that grades style: the judge reads the same style docs it grades, 6 pairs gave no power, and models prefer their own text. That reasoning stands.
- It never covered graders that check facts, or a run of the same task without the plugin. The kit's eval already uses deterministic graders (`tool_used` in `plugin/evals/review-approval-menu/graders/`).
- Claude Code 2.1.302 ships `claude plugin eval --ablation with-without`, which runs each case with and without the plugin and reports both scores.
- Kit changes so far were judged by reading the diff. Nothing showed whether a skill line changed what the agent does.

## Decision
- A kit change that claims to change agent behaviour is measured before it ships: a pre-change arm (`--ablation none` on the current plugin), a post-change arm and the no-plugin arm (`--ablation with-without`), always with `--no-publish` and a `--max-cost-usd` cap the user approved.
- Graders check facts only: `regex`, `tool_order`, `tool_used`, `file_exists` (which sees only files the run created). `llm` and `baseline` graders stay out of the kit; `skill-contracts.test.mjs` fails if one appears.
- At least three cases per measured change, as Anthropic's skill guidance asks; the report states runs, variance and cost, and a small sample is reported as a signal, not proof.
- Success means the change's grader fails before and passes after, and the post-change plugin beats the no-plugin arm. Otherwise the change is reverted or reworked and its ADR says so.

## Prior art

- tedy-kit evals (own code, studied 2026-10-18, via local)
  - plugin/evals/review-approval-menu/graders/no-post.md:2 "type: tool_used"
  - Lesson: the kit already grades with facts the transcript proves.
  - Taken: fact graders become the only allowed kind.
- claude plugin eval (Anthropic, studied 2026-10-18, via local)
  - `claude plugin eval --help` (Claude Code 2.1.302) "Run a no-plugin baseline arm and report the score"
  - Lesson: the no-plugin arm is built in; no harness to write.
  - Taken: every measured change runs it.
- Anthropic skill authoring best practices (Anthropic docs, studied 2026-10-18, via web)
  - https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices "Establish baseline: Measure Claude's performance without the Skill"
  - https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices "Build three scenarios that test these gaps"
  - Lesson: measure without the skill first, with three scenarios.
  - Taken: the pre-change arm and the three-case minimum.
- ClaudeDevs launch post for plugin eval (public post, studied 2026-10-18, via x)
  - https://x.com/ClaudeDevs/status/2098500999656923145 "run each case again without the plugin to see the differences."
  - Lesson: the maintainers frame the eval as a with/without comparison, not a score on its own.
  - Taken: success needs the post-change plugin to beat the no-plugin arm.

Reddit searches on 2026-10-18 found nothing: reddit: "skill eval baseline without the skill" (r/ClaudeCode); reddit: "claude skills evals ablation".

## What it avoids
Shipping skill lines on the belief that they change behaviour, and reopening the LLM-judge question each time an eval comes up.
