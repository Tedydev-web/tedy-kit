---
name: unclebob/ub-mode
pinned: https://github.com/unclebob/ub-mode/tree/3da62bf3fcfd2034de41f30d920d2739e566171f
license: MIT
studied: 2026-11-05
channel: github
domains: agent-skills, testing, guardrails
use-when: someone proposes adopting a famous author's principle checklist skill, CRAP/duplication/mutation thresholds, or "push to main" autonomy in an agent coding workflow
---

# unclebob/ub-mode

## Evidence
- https://github.com/unclebob/ub-mode/blob/3da62bf3fcfd2034de41f30d920d2739e566171f/README.md#L3 "loosely based on portions of [@poteto](https://github.com/poteto)'s rules (`poteto-mode` / `pstack`), reduced and paired with deterministic quality-gate tools"
- https://github.com/unclebob/ub-mode/blob/3da62bf3fcfd2034de41f30d920d2739e566171f/README.md#L20 "Copy `SKILL.md` into your agent's skills directory as `ub-mode/SKILL.md`"
- https://github.com/unclebob/ub-mode/blob/3da62bf3fcfd2034de41f30d920d2739e566171f/SKILL.md#L11-L14 "Every time you are asked to make a change follow:"
- https://github.com/unclebob/ub-mode/blob/3da62bf3fcfd2034de41f30d920d2739e566171f/SKILL.md#L31-L34 "See it fail for the reason you expect."
- https://github.com/unclebob/ub-mode/blob/3da62bf3fcfd2034de41f30d920d2739e566171f/SKILL.md#L43-L44 "count which actors hold the imbalance."
- https://github.com/unclebob/ub-mode/blob/3da62bf3fcfd2034de41f30d920d2739e566171f/SKILL.md#L96 "A guard that only hides the crash is not a fix."
- https://github.com/unclebob/ub-mode/blob/3da62bf3fcfd2034de41f30d920d2739e566171f/SKILL.md#L106 "If the test would still pass when every function returned nothing, throw it out."
- https://github.com/unclebob/ub-mode/blob/3da62bf3fcfd2034de41f30d920d2739e566171f/SKILL.md#L111 "Reduce each function under  CRAP 10 by splitting it, by testing it, or both."
- https://github.com/unclebob/ub-mode/blob/3da62bf3fcfd2034de41f30d920d2739e566171f/SKILL.md#L116 "Use the dryer tool to eliminate duplication that rank 0.8 or above."
- https://github.com/unclebob/ub-mode/blob/3da62bf3fcfd2034de41f30d920d2739e566171f/SKILL.md#L123 "Delete dead code."
- https://github.com/unclebob/ub-mode/blob/3da62bf3fcfd2034de41f30d920d2739e566171f/SKILL.md#L152 "Push to the main line at the end."
- https://github.com/unclebob/crapper/blob/6fd92c4c9bcc56efb64a2f8743d5a2993bcfd42d/README.md#L8 "CRAP = CC² × (1 − coverage)³ + CC"
- https://github.com/unclebob/crapper/blob/6fd92c4c9bcc56efb64a2f8743d5a2993bcfd42d/README.md#L85 "A missing tool or a failed test run scores that language at 0% and still writes the snapshot."
- https://github.com/unclebob/mutator/blob/a5a0cb803b66e0cdb8bf471b3b08af701d424a41/README.md#L91 "A replacement that does not compile fails the test run and counts as killed."
- https://github.com/unclebob/dryer/blob/66ff6d21a42c04afcad89c78a80066176d1294b0/README.md#L13 "The default `--threshold 0.82` reports candidates close enough to be worth review."
- https://github.com/cursor/plugins/blob/bb68f2365eceafa0cb2d253112f675acf5f144cc/pstack/skills/principle-attack-the-premise/SKILL.md#L19 "Do not start the next fix before the premise is written down and tested."

## Issues and changelog
- https://github.com/unclebob/ub-mode/issues/2 "Two rules in SKILL.md give the agent authority I would not hand it"
  - Broke: the skill tells the agent to push to main and to decide what to delete on disk, with no human step; the reporter also found Attack the Premise "compressed beyond meaning". Fixed: open as of 2026-11-05; PR #8 (open) asks for approval before push and deletion.
- https://github.com/unclebob/ub-mode/issues/3 "Right now the agent will not know the crapper tool exists"
  - Broke: the skill names the three gate tools but no command, path or install step, so an agent must search for them. Fixed: open as of 2026-11-05.
- https://github.com/unclebob/ub-mode/issues/10 "agents frequently invoke `crapper` against freshly cloned or third-party repositories"
  - Broke: agents run crapper on third-party repositories, and it auto-installs the Vitest coverage provider and parses JaCoCo XML. Fixed: open as of 2026-11-05; crapper PR #27 (open) proposes SemVer validation, `--ignore-scripts` and DTD stripping.
- https://github.com/unclebob/ub-mode/pull/1 "Move `SKILL.md` to `skills/ub-mode/SKILL.md`."
  - Broke: install is a manual copy of one file. Fixed: open as of 2026-11-05; users install via `npx skills add unclebob/ub-mode@ub-mode` (comment on #6).

## Lessons
- Prose-only gate: the skill asks for CRAP, duplication and mutation runs but wires no exit code and names no command, and the author's answer to "won't the model ignore it" is "You are the engineer. You have to monitor the bots" (@unclebobmartin, 2026-10-25): touches `plugin/skills/dev/SKILL.md:37` (verify uses the repository's own scripts); overlap with the gates-over-prose notes; cost none, nothing to adopt.
- Stub-out and mutation checks: touches `plugin/skills/dev/SKILL.md:40` (break-once); overlap, as in `ionden-skills` and `batten`; a scoped mutation run (`--changed`, StrykerJS incremental for TS) is a candidate `assess` row on the test-proof position; cost high for client repos (tool install, `.metrics/` and `target/` writes, compile failures counted as kills).
- Fix Root Causes: touches `plugin/skills/dev/SKILL.md:35` (Build); gap, since the dev skill has no root-cause or sibling-sweep line; cost low; adopt only behind the user's own observed failure, not because ub-mode says it.
- Compression without trigger or reason loses the operative step (Attack the Premise against its poteto source): touches the instruction-writing position (one-clause reason per rule); overlap; cost none.
- Push to main, agent-chosen disk cleanup and "Delete dead code": touch `plugin/skills/dev/SKILL.md:16` (iron law 3) and the user's code-retention rule; conflict; not taken.
- Threshold drift between skill and tools (`< 10` and "eliminate ≥ 0.8" in the skill against "5–30 worth a look" and "candidates … worth review" in the tools); at 100% coverage CRAP equals CC, so `< 10` forces a split of any function with CC ≥ 10: touches nothing in the kit; lesson for any future metric gate: take the threshold from the tool's own calibration.
