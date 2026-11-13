# 0014: Kit artifacts meet six quota techniques, each failed by a check

Status: accepted (2026-10-30); T2 amended by [ADR 0021](0021-the-cockpit-asks-each-jobs-open-cards-on-arrival.md) (standard version 4: one UserPromptSubmit hook, `session-hooks.mjs ask-cards`, is allowed); archived 2026-11-13: its checks, records and suites left main and live at tag `archive/governance-v0.3.4`

## Context
- S32 asks that every kit artifact meets the quota techniques the quota study establishes, and that a machine check fails one that does not. ADR 0013 left it partial until the quota study chose its techniques.
- On 2026-10-30 the quota study ran by deep reading, the user's choice over the full v4 sweep: three purposive searches over 76 candidates found two holds for every registry row except Q5 and the quality halves of Q12, Q18, Q19 and Q20. Ten rows (Q1, Q2, Q5, Q6, Q11, Q12, Q14, Q21, Q22, Q23) are session practice, not kit artifacts, and stay in the registry as guidance outside S32. Rows Q8, Q9, Q24 and Q25 were re-checked on Claude Code 2.1.314.
- The user chose techniques T1 to T6 (2026-10-30). Eleven sources are studied as supplement sources of sweep `261021-canon`.

## Decision
- T1, footprint (Q7, Q8, Q9): `docs/canon/footprint-budget.json` holds the characters of every skill's and agent's `description` and `when_to_use`, which Claude Code lists in every session (2,628 at tedy 0.2.16). `footprintErrors` fails a total over the budget, and a budget higher than at the latest release tag unless the standard version rose.
- T2, hook output (Q3, Q10): `hookEventErrors` fails a `hooks.json` that registers an event whose output enters the context on every prompt or every subagent spawn (UserPromptSubmit, UserPromptExpansion, InstructionsLoaded, SubagentStart). The kit's hooks speak at session start, after compaction and on a prose question only.
- T3, skill model (Q4): `skillModelErrors` fails a skill whose front matter sets `model:`, because a skill model switches the session model and starts a cold prompt cache. Agents may pin a model at their own boundary.
- T4, reviewer spawn context (Q16): `plugin/agents/reviewer.md` sets `omitClaudeMd: true` and restates the kit rules it needs, adopted only if an ADR 0009 arm shows the review findings hold without the user's CLAUDE.md.
- T5, quota gate (Q24, Q25): pressure results record tokens and cost; `baseline.json` keeps each cell's mean cost and its own `costBand`, and a `costTolerance` floor measured from ten runs of one cell; both are two standard errors of the difference between two three-run means, relative to the mean; `rebaseline.mjs` refuses a mean cost past the larger of the two unless `--accept-cost-rise`, and refuses a cell whose runs report no cost once the baseline has one.
- T6, reviewer model and effort (Q20): pinned only from measured parity with the default, never mid-session.
- The T4 and T6 evals are pressure scenarios s8 (lens bugs: four planted bugs, one where the diff meets unchanged code, and one correct decoy) and s9 (lens standards: four planted violations: an unsafe cast, a fraction of a cent, an `any`, and a source comment; the cents rule is stated only in the repository's CLAUDE.md). Every arm loads a copy of the worktree plugin that differs only in the reviewer's front matter: `green` as is, `omit` with `omitClaudeMd: true`, `sonnet` with `model: claude-sonnet-5-5`. The grader reads only the reviewer subagent's own result, matches its `path:line` headers against the planted lines, passes a run only when every planted problem is found, and counts a `sonnet` run as invalid unless that model served. Five runs an arm cannot tell 5/5 from 4/5, so parity means no measured loss at that size, not proven equality.
- Measured 2026-10-30 (30 runs, USD 22.43, plus a two-run gate at USD 1.33): every cell found all its planted problems in 5 of 5 runs, with 1 extra finding in 30, so neither scenario separates the arms, as s6 did not for blast-radius. The first grading accepted only line 7 of the two-line string-total bug, and reviewers anchored on line 6 in 12 of 15 runs; the regrade from the kept traces counts both lines, a correction made after the runs. s9 cannot isolate the user's CLAUDE.md: the reviewer's standards lens names type safety and comments itself, and the main session copied the repository rule and the no-comments rule into the delegation prompt, which is how /tedy:review-pr runs anyway. The omit arm tested the flag alone, not the flag with restated rules. The reviewer subagent used about 36k tokens in s9 green, 19.6k with `omitClaudeMd`, and 31k on Sonnet; a run cost USD 0.85 to 0.86 on green, 0.65 to 0.73 with omit, and 0.64 to 0.75 on Sonnet. Only `model` was tested, not `effort`.
- T6 adopted 2026-11-03 on the user's choice: `plugin/agents/reviewer.md` pins `model: claude-sonnet-5-5`, which met code-foundations' floor of at least 4 of 5 at n=5 in both scenarios, and a canon test holds the pin. T4 waits on scenario s10, which plants violations of two rules that only the user's CLAUDE.md states (kebab-case file names and edits to unrelated code), plus a source comment as the control. Arms: `green`, `omit` with the flag, and `omit-read`, where the standards lens also reads `~/.claude/CLAUDE.md` and its imports. The main session is told to pass only the agent's inputs, and a run whose delegation prompt names either rule is invalid.
- s10 measured 2026-11-03 (16 runs including the gate, USD 9.06; reviewer on claude-sonnet-5-5; no delegation prompt named a planted rule). Every arm found the unrelated edit and the comment in 5 of 5 runs and the kebab-case name in 0 of 5. The `omit` arm found the unrelated edit through reviewer.md's own "existing patterns a few files away", and `green` missed the file name although CLAUDE.md was loaded, so loading the user's CLAUDE.md changed no finding. The reviewer subagent used about 32.7k tokens on `green` and 16.3k on `omit`; a run cost USD 0.608 against 0.525. The first grading used words that both credited an unrelated finding and missed findings worded as churn, and the words were corrected after the runs, before the arms were compared. In `omit-read`, the `claude -p` default permission mode denied the reviewer's reads outside the repository in every run, so that arm measured `omit` with a refused read. It was not rerun with `--add-dir`, because `omit` already matched `green`.
- T4 adopted 2026-11-03 on the user's choice: `plugin/agents/reviewer.md` sets `omitClaudeMd: true`, and the canon test that holds the model pin also holds the flag. Nothing is restated: reviewer.md already names the rules the reviewer applied in s8 to s10, and s10 showed that loading the user's CLAUDE.md changed no finding. A user's own rule the reviewer would need is out of its view, and the skill that spawns it can pass that rule in the delegation prompt.
- The S32 rules enter `standard.json` in the next standard version, together with S27's, once the T4 to T6 measurements are in. Done in standard version 3 (2026-11-03): surface-fit and inventory-version hold S27; footprint-budget, per-turn-hooks, skill-model, reviewer-spawn and cost-gate hold S32. Both problems are covered, and the kit goes first where ADR 0013 says so.

## Prior art

- agent-sh/agnix (MIT OR Apache-2.0, studied 2026-10-30, via github)
  - card: agnix
  - https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-core/src/schemas/claude_md.rs#L26 "pub const MAX_INSTRUCTION_FILE_LINES: usize = 200;"
  - Lesson: always-on text has a budget a linter can fail, but its combined figure is only informational.
  - Taken: T1 makes the combined figure fail.
- agent-ecosystem/skill-validator (MIT, studied 2026-10-30, via github)
  - card: skill-validator
  - https://github.com/agent-ecosystem/skill-validator/blob/899dba96e0d0d7d964308ac4df9657c68f581347/structure/tokens.go#L89-L91 "if bodyCount > 5000 {"
  - Lesson: a skill body is counted against a budget and fails over it.
  - Taken: the kit keeps its stricter 9,000-character SKILL.md test and adds the listing total in T1.
- alexgreensh/token-optimizer (NOASSERTION, studied 2026-10-30, via github)
  - card: token-optimizer
  - https://github.com/alexgreensh/token-optimizer/blob/734da4eb1e96e10f93c0a93cd1dfecfeae93713d/tests/test_fresh_nudge_once.py#L49 "def test_shows_once_even_when_the_cache_loses_its_flag(m):"
  - Lesson: injected text is tested to appear once, not on every turn.
  - Taken: T2 keeps the kit off per-turn events.
- mksglu/context-mode (Elastic-2.0, studied 2026-10-30, via github)
  - card: context-mode
  - https://github.com/mksglu/context-mode/blob/849c8690bdf86eef60156e13d98efd10fcfd46fb/hooks/core/routing.mjs#L121-L123 "function guidanceOnce(type, content, sessionId) {"
  - Lesson: guidance is injected once per session behind a marker.
  - Not taken: a marker per session; the kit has no per-turn injection to throttle.
- yonatangross/orchestkit (MIT, studied 2026-10-30, via github)
  - card: orchestkit
  - https://github.com/yonatangross/orchestkit/blob/22dfd9883087a6574174cec33ffb1e6b11aa6f60/src/hooks/src/lifecycle/model-switch-consent.ts#L76 "if (!sw.promptCacheWarm || sw.contextTokens <= WARM_CONTEXT_WARN_TOKENS) {"
  - Lesson: a model switch on a warm cache is costly enough to warn about at run time.
  - Taken: T3 prevents the switch statically for kit skills.
- dbrownjave/claude-token-saver (MIT, studied 2026-10-30, via github)
  - card: claude-token-saver
  - https://github.com/dbrownjave/claude-token-saver/blob/437ba691a47b3f206a5783fe4bfe13a2f64c18ef/plugins/token-saver/hooks/register.js#L3062-L3063 "The cache is cold, so the next message re-reads ${fmt(used)} tokens either way."
  - Lesson: the cost of a switch depends on whether the cache is warm.
  - Taken: T3's reason in its error message.
- renchris/claude-infrastructure (NOASSERTION, studied 2026-10-30, via github)
  - card: claude-infrastructure
  - https://github.com/renchris/claude-infrastructure/blob/9a9c67ce8186d6206d48eca26abf8528d03e05ac/tests/agents-omit-claudemd.bats#L33-L34 "frontmatter "$f" | grep -qx 'omitClaudeMd: true'"
  - Lesson: a test pins `omitClaudeMd` and the rules each agent must restate; the saving was measured, the quality was not.
  - Taken: T4, gated on an eval of review findings.
- fagenorn/nix-config (NOASSERTION, studied 2026-10-30, via github)
  - card: nix-config
  - https://github.com/fagenorn/nix-config/blob/8212d8fb8e933120db864339e9a8d0d174462268/home/common/agent-skills/tests/test_agent_model_matrix.py#L397-L398 "self.assertEqual(metadata["effort"], data["roles"][role]["effort"], path)"
  - Lesson: a test holds each agent's model and effort to a committed matrix, and its full reviewer keeps CLAUDE.md.
  - Taken: T6's pin is tested once set. Not taken: a declared matrix; the kit's pin must come from measured parity.
- TrogonStack/rusty-monorepo (MIT, studied 2026-10-30, via github)
  - card: rusty-monorepo
  - https://github.com/TrogonStack/rusty-monorepo/blob/c3904a6f333de0b35935327cfb1adc1479d5d352/crates/trg/docs/how-to/gate-a-change-on-cost-and-latency.md#L4-L7 "The keep-or-revert recommendation reads pass rates only, so a change that holds its pass rate and triples its cost is still a `keep`."
  - Lesson: compare baseline and candidate arms on cost and tokens as well as pass rate, and fail only past noise.
  - Taken: T5. Not taken: four runs a side and a per-run interval; the kit measures the band once and keeps three runs a cell.
- Anteneh-T-Tessema/meshflow (Apache-2.0, studied 2026-10-30, via github)
  - card: meshflow
  - https://github.com/Anteneh-T-Tessema/meshflow/blob/081a368f238731d829a9f59201e57e02ad048a46/meshflow/eval/ci_gate.py#L1-L5 "CI budget gate — blocks a build when token/cost regression exceeds threshold."
  - Lesson: a stored baseline gates tokens and cost, but a missing field reads as a pass.
  - Taken: T5 refuses a run with no cost once the baseline has one.
- ryanthedev/code-foundations (NOASSERTION, studied 2026-10-30, via github)
  - card: code-foundations
  - https://github.com/ryanthedev/code-foundations/blob/ca30ba90ebd3b44017365ad4d91938dd675808f9/benchmarks/model-tiers/REPORT.md#L92 "Floor rule: per task, floor(task) = cheapest ladder model with pass rate ≥4/5 at n=5."
  - Lesson: a measured floor rule picks the cheapest model per task, and a pin that ignores it drifts.
  - Taken: T6 pins only from the measurement.

no social prior art: 2026-10-30 x: "skill token budget CI fail"; youtube: "claude code skill token budget CI eval"

## Consequences
- T1 to T3 and the T5 gate are checks today at no spend; T4 and T6 change what the reviewer sees or runs on and wait for their evals, priced at about USD 9 to 12 each, and T5 needs a priced baseline and its noise run, about USD 21 to 27.
- Measured 2026-10-30 (47 runs on claude-opus-5-5, USD 16.83): ten runs of s1 green gave a 6% floor, while the cells' own three-run bands ran from 1% to 66%, so one band for every cell would refuse honest reruns; each cell now carries its own band. The kit-off control s1 red fell from 1/3 to 0/6, which is the model, not the kit; a pass-rate fall now refuses only the kit-on arm and the with arm of a ledger ablation, and a control arm's fall is recorded. Bare cells cost USD 0.06 to 0.08 a run and full-setup cells 0.40 to 0.51 with green about equal to red, so the user's own setup, not the kit, is most of a run's cost and no cell yet isolates the kit's share.
- Weakest link: every source's exit behaviour was read, not run; four have no licence file or a custom one; each cell's band comes from three runs, below trg's four-run floor; T2 bounds when hooks speak, not how long a notice grows.
