# Screening packet, developer sweep, facet "test integrity" (P1 + P2, generic)

You are one of two screen-coding sessions. The other session codes the same rows blind; never read `screen-A*`, `screen-B*` or any file other than the ones named here.

## Problems

- P1: A failing test is written and run before the implementation of a logic change or bug fix.
- P2: A test is never weakened, skipped or deleted to get green, and a run with zero tests is not green.

## Inputs

- Criteria: `docs/prior-art/quality-criteria-v2.md`, the "GitHub assets" table and the "Screening rules". Score each criterion 1 / 0.5 / 0 by its anchors, one short evidence phrase per cell.
- Rows: `the sweep folder: screening-order.jsonl`. Each line has `order_rank`, `repo`, `units` (original agent-asset units holding a problem term), `forced`, `stars`, `pushed`, `created`, and pool `via` channels.
- Mechanisms the kit already knows, for the Novelty score only: instruction text in a skill telling the agent to write a failing test first; a PreToolUse hook that blocks implementation edits without a failing test; a Stop hook that runs the tests; a commit-time check; a separate test-writing agent; a visible red run quoted in the report.

## Per row, in `order_rank` order

1. Pin the default-branch commit: `gh api repos/<repo>/commits/HEAD --jq .sha`.
2. Read the one asset file most relevant to P1 or P2 among `units` (`gh api repos/<repo>/contents/<path>?ref=<sha> --jq .content | base64 -d`; for a unit directory, list it first). Read a second file only when the first one points to where the mechanism lives (a hook script a SKILL.md names). No clones.
3. Score Authority, Methodology, Objectivity, Date, Position, Novelty, Relevance. Methodology and Position may need `gh api repos/<repo>/contents/` or the README; Impact is not scored here.
4. Code every mechanism the file shows for P1 or P2. A mechanism is what makes the behaviour happen, not its wording. For example, "PreToolUse hook denies Write/Edit on a non-test file until a test run failed" is a mechanism; "skill says tests matter" is not, unless it gives an enforced or checkable step. Give each a short kebab-case name and a one-line definition. Reuse your own earlier name when it is the same mechanism.
5. Decide `eligible` (Relevance ≥ 0.5 and the six quality cells sum ≥ 4.5) or `exclude: <code>`. The codes are `irrelevant`, `below-threshold`, `copy` (the file is a copy of another source; name it), `dead` (404 or empty) and `aggregator`.
6. Mark `new: true` when the row adds a mechanism not yet in your own list.

## Stop (revised 2026-10-18 20:52, user decision)

- Unforced rows are screened in order.
- Stop only at the effort bound: N = 60 unforced rows. After that, extend in steps of 10 while the last 10 unforced rows hold at least one non-exclude.
- Saturation no longer stops screening. Record the longest run of unforced rows with `new: false` in the last line.
- After stopping, screen every `forced: true` row not yet screened. Forced rows add mechanisms but never count toward N.
- The last line is `stop: effort bound at row <n>; longest no-new run <k> (rows <a>-<b>)`.

## Output

- Write one JSON object per screened row to `<out>.jsonl`. Fields: `order_rank`, `repo`, `sha`, `file`, `scores` (an object of the seven cells, each `{"v": 1|0.5|0, "why": "..."}`), `mechanisms` (names), `new`, `decision`, `note`.
- Write `<out>-mechanisms.md`: one line per mechanism, `name: definition (first row repo, rows count)`.
- Last line of `<out>-mechanisms.md`: `stop: saturation at row <n>` or `stop: effort bound at row <n>`.
- End your reply with `Status: DONE | BLOCKED` and the counts (rows screened, eligible, mechanisms).

Do not edit any repository. Keep Bash commands simple: one `gh api` call per command, no heredocs, loops or `$(...)`.
