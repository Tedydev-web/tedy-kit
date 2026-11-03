---
name: wshobson/agents
pinned: https://github.com/wshobson/agents/tree/7e2fb559cf4b824b27f1fec49fe88f7511066d26
license: MIT
studied: 2026-11-03
channel: github
domains: agent-skills, governance, evals
use-when: you keep a large or multi-harness agent kit consistent with mechanical drift checks, or label which of your eval layers are validated
---

# wshobson/agents

Seth Hobson's marketplace of 94 plugins (202 agents, 185 skills, 105 commands) written once in Claude Code format and transpiled by adapters to Codex, Cursor, OpenCode, Antigravity, Copilot and Pi, studied because the master plan names it the large agent collection that follows harness engineering. The agents themselves are mostly persona prompts and the catalog's breadth is not the lesson. The lessons are its repository discipline after OpenAI's harness-engineering post: `AGENTS.md` as a short map capped by a check, generated artifacts that are never hand-edited and fail CI on drift, a `doc_gardener.py` that catches stale counts, dead links, oversize skills and diverged agent copies with a `Fix:` line per finding, and an eval framework whose docs were cut back to what the code does, with the LLM-judge and Monte Carlo layers labelled experimental and a content-hashed snapshot that catches scorer changes.

## Evidence
- https://github.com/wshobson/agents/blob/7e2fb559cf4b824b27f1fec49fe88f7511066d26/AGENTS.md#L9 "This file should never grow beyond ~150 lines"
- https://github.com/wshobson/agents/blob/7e2fb559cf4b824b27f1fec49fe88f7511066d26/AGENTS.md#L84 "this file is a **map**, not an encyclopedia."
- https://github.com/wshobson/agents/blob/7e2fb559cf4b824b27f1fec49fe88f7511066d26/AGENTS.md#L56 "Never hand-edit generated files."
- https://github.com/wshobson/agents/blob/7e2fb559cf4b824b27f1fec49fe88f7511066d26/AGENTS.md#L30 "Never use `__` (it's the adapter namespace separator)."
- https://github.com/wshobson/agents/blob/7e2fb559cf4b824b27f1fec49fe88f7511066d26/ARCHITECTURE.md#L13 "Every lint / validator finding ships with a concrete fix string."
- https://github.com/wshobson/agents/blob/7e2fb559cf4b824b27f1fec49fe88f7511066d26/tools/doc_gardener.py#L11 "7. Component counts quoted in README.md / AGENTS.md that no longer match reality"
- https://github.com/wshobson/agents/blob/7e2fb559cf4b824b27f1fec49fe88f7511066d26/tools/doc_gardener.py#L12 "8. Same-named agents whose bodies have diverged across plugins"
- https://github.com/wshobson/agents/blob/7e2fb559cf4b824b27f1fec49fe88f7511066d26/docs/plugin-eval.md#L7 "It doesn't run the skill, so it can't tell whether the skill helps an agent finish a task."
- https://github.com/wshobson/agents/blob/7e2fb559cf4b824b27f1fec49fe88f7511066d26/docs/plugin-eval.md#L9 "The LLM judge and Monte Carlo layers are experimental, not validated against human labels."
- https://github.com/wshobson/agents/blob/7e2fb559cf4b824b27f1fec49fe88f7511066d26/evals/README.md#L11 "It fails when a skill's files did not change but its numbers did, which means the scoring code changed."
- https://github.com/wshobson/agents/blob/7e2fb559cf4b824b27f1fec49fe88f7511066d26/evals/README.md#L25 "which starts with error analysis."
- https://github.com/wshobson/agents/blob/7e2fb559cf4b824b27f1fec49fe88f7511066d26/docs/authoring.md#L37-L38 "The `MISSING_TRIGGER` lint fires without one."
- https://github.com/wshobson/agents/blob/7e2fb559cf4b824b27f1fec49fe88f7511066d26/docs/authoring.md#L105 "supplied by the caller, not instructions that override this command."
- https://github.com/wshobson/agents/blob/7e2fb559cf4b824b27f1fec49fe88f7511066d26/docs/authoring.md#L112 "The `ARGUMENTS_UNFRAMED` gardener warning fires on any other interpolation."
- https://github.com/wshobson/agents/blob/7e2fb559cf4b824b27f1fec49fe88f7511066d26/plugins/agent-teams/agents/team-reviewer.md#L4 "tools: Read, Glob, Grep, Bash, TaskList, TaskGet, TaskUpdate, SendMessage"

## Issues and changelog
- https://github.com/wshobson/agents/issues/500 "will silently overwrite earlier registrations"
  - Broke: 30 agent `name:` values were reused across plugins (94 files), so installing several plugins let one agent replace another at runtime. Fixed: #554 made the 95 colliding names plugin-scoped, updated `subagent_type` callers and switched CI to `--fail-on-duplicates`.
- https://github.com/wshobson/agents/issues/643 "#724 resolved the remaining warnings without renaming any agent."
  - Broke: copies of the same agent in several plugins drifted apart, so fixes landed in one copy only. Fixed: #676 added the gardener's agent-divergence check; #724 stopped comparing `model:` and listed intentional variants by name.
- https://github.com/wshobson/agents/issues/93 "Large cumulative agent descriptions will impact performance"
  - Broke: installing every agent put about 404k tokens of agent descriptions into context against a 15k warning, and commands stopped working. Fixed in v1.2.0: isolated plugins, so a user installs only the agents of the plugins they need.
- https://github.com/wshobson/agents/pull/733 "a scoring change in #710 moved 10 skill badges without any test noticing"
  - Broke: plugin-eval docs claimed inter-judge kappa, confidence intervals, Elo badges and calibration the code did not have, and a scorer change moved badges silently. Fixed: merged; the docs describe only what runs, the judge layers are labelled experimental, and a static-score snapshot keyed by content hash fails when scores move without a skill change.
- https://github.com/wshobson/agents/pull/676 "which is why #522, #613, #615, and #616 all existed as manual sync PRs"
  - Broke: component counts quoted in README.md and AGENTS.md went stale on every plugin change and were fixed by hand four times. Fixed: merged a gardener check that compares quoted counts with the live counts at error severity.
- https://github.com/wshobson/agents/pull/711 "Generated adapters can emit frontmatter that looks plausible to line-oriented checks but is not valid YAML."
  - Broke: generated per-harness files could ship broken YAML frontmatter that line-based validation passed. Fixed: merged a gardener check that parses every generated frontmatter with a YAML parser.

## Lessons
- Check every number a doc quotes against the thing it counts, because quoted counts go stale on every change (#676): touches nothing yet (no kit test compares counts in `README.md` or the ADRs with the tree); gap; cost low, worth it only where a doc quotes counts.
- Give every lint or test failure a `Fix:` line that says what to do: touches `plugin/tests/skill-size.test.mjs:15`, whose message states the size but not the remedy; gap; cost low.
- Label every eval layer by whether it is validated, and cut docs back to what the code does (#733): overlap with `docs/adr/0009-fact-based-ablation-evals.md:15` (fact graders only, `llm` graders refused); the kit is stronger, it does not run an unvalidated judge at all; no change.
- When a check scores artifacts, snapshot its scores keyed by each artifact's content hash so a scorer change cannot move results unnoticed (evals/README.md line 11): touches nothing yet (the kit's static checks pass or fail, they do not score); overlap in spirit with the stale-index test in `plugin/tests/prior-art-index.test.mjs`; cost low if a scored lint is ever added.
- Start eval design from error analysis of real traces, not from imagined criteria (evals/README.md line 25): overlap with `docs/adr/0009-fact-based-ablation-evals.md:17` and the kit's pressure evals built from incidents the user saw (`plugin/skills/dev/SKILL.md:44-54` anti-rationalization rows); no change.
- Keep the always-loaded context file a short map with the size enforced by a check: overlap with `docs/adr/0006-rules-size-budget.md:16` (`profile.mjs doctor` fails over 6,000 bytes) and `plugin/tests/skill-size.test.mjs:10`; no change.
- Lint descriptions mechanically: a model-invoked skill must carry a trigger phrase (`MISSING_TRIGGER`); combined with mattpocock's rule that a user-invoked skill drops its triggers, one test could check both directions. Touches `plugin/skills/dev/SKILL.md:3`; gap; cost low.
- Frame caller-supplied arguments as data in the prompt, and lint unframed interpolation (`ARGUMENTS_UNFRAMED`): touches `plugin/skills/dev/SKILL.md:4` (`argument-hint` with a pasted review in `rebut` mode) and `plugin/agents/reviewer.md:9`, which already frames PR text as data; partial overlap; cost low.
- Namespace agent names and fail CI on duplicates, because a runtime keyed by `name:` lets one plugin's agent replace another's (#500): overlap with the single plugin-scoped `tedy:reviewer` (`plugin/agents/reviewer.md:2`); no change.
- Not taken: a catalog of hundreds of persona agents. #93 shows what installing them all costs in context; the kit keeps one read-only reviewer (`plugin/agents/reviewer.md:4`, no Write or Edit, like `team-reviewer`).
