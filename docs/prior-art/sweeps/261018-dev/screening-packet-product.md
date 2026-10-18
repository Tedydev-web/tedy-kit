# Screening packet, developer sweep, product stratum, facet "test integrity" (P1 + P2, generic)

You are one of two screen-coding sessions for the product stratum. These are repositories that ship the mechanism as source code: hook programs, CLIs, plugins with code, libraries, MCP servers and CI actions. The other session codes the same rows blind.

Do not read these files:

- `product-screen-A*` or `product-screen-B*`, whichever is not your own;
- `screen-config-*`;
- `qgs-*`.

## Problems

- P1: A failing test is written and run before the implementation of a logic change or bug fix.
- P2: A test is never weakened, skipped or deleted to get green, and a run with zero tests is not green.

## Inputs

- Criteria: `docs/prior-art/quality-criteria-v2.md`, the "GitHub assets" table, the product-stratum paragraphs and the "Screening rules".
  - Score each criterion 1 / 0.5 / 0 by its anchors, with one short evidence phrase per cell.
  - For the Relevance row, a source file that holds both the hook fields and a problem term counts as an agent-asset file.
- Rows: `the sweep folder: product-stratum-order.jsonl`. Each line has:
  - `order_rank`, `repo` and `channels`;
  - `contract_files`: source files that hold hook fields and a problem term;
  - `evidence`, `description`, `stars`, `created`, `pushed`, `archived`.
- Mechanisms the kit already knows, for the Novelty score only:
  - instruction text in a skill telling the agent to write a failing test first;
  - a PreToolUse hook that blocks implementation edits without a failing test;
  - a Stop hook that runs the tests;
  - a commit-time check;
  - a separate test-writing agent;
  - a visible red run quoted in the report.

## Per row, in `order_rank` order

1. Pin the default-branch commit: `gh api repos/<repo>/commits/HEAD --jq .sha`.
2. Read the README's "how it works" part: `gh api -H "Accept: application/vnd.github.raw" repos/<repo>/readme`.
3. Read the one source file that makes the decision for P1 or P2. Prefer a `contract_files` entry; otherwise use the `bin` entry of `package.json`, or the hook command that `hooks.json` names. Read one more file only when the first one hands the decision to it.
4. Search the closed issues for failure modes:
   - query: `gh api -X GET search/issues -f q='repo:<repo> is:closed test' --jq '.total_count, (.items[:10][] | "\(.number) \(.title)")'`;
   - note any issue that shows the mechanism failing, being bypassed or being misfired, as `#n: one line`.
5. Score Authority, Methodology, Objectivity, Date, Position, Novelty and Relevance. Impact is not scored here.
6. Code every mechanism the code shows for P1 or P2.
   - A mechanism is what the code does, not what the README claims. When the README claims something the code does not do, write that in `note`.
   - Give each mechanism a short kebab-case name and a one-line definition. Reuse your own earlier name when it is the same mechanism.
7. Decide one of:
   - `eligible`: Relevance ≥ 0.5 and the six quality cells sum ≥ 4.5;
   - `exclude: <code>`, where the code is `irrelevant`, `below-threshold`, `copy` (name the source), `dead` or `aggregator`.
8. Mark `new: true` when the row adds a mechanism not yet in your own list.

## Stop

- Screen unforced rows in order. This stratum has no forced rows.
- Stop at the effort bound: N = 60 rows.
- After that, screen one block of 10 at a time. After each block, report to the team lead how many new mechanisms the block added, then wait. The team lead says continue while either session found a new mechanism in that block, and the hard cap is 200 rows (revised 2026-10-18 21:40, user decision).
- Saturation does not stop screening. Record the longest run of `new: false` rows.

## Output

- `<out>.jsonl`, one JSON object per screened row. Fields:
  - `order_rank`, `repo`, `sha`, `file`;
  - `scores`: an object of the seven cells, each `{"v": 1|0.5|0, "why": "..."}`;
  - `mechanisms` (names), `new`, `decision`;
  - `issues`: a list of `#n: one line` strings;
  - `note`.
  
  Rewrite the whole file with the Write tool every 10 rows.
- `<out>-mechanisms.md`: one line per mechanism, `name: definition (first row repo, rows count)`. The last line is `stop: effort bound at row <n>; longest no-new run <k> (rows <a>-<b>)`.
- End your reply with `Status: DONE | BLOCKED` and these counts: rows screened, eligible, mechanisms.

Do not edit any repository. Keep Bash simple: one `gh api` call per command, with no heredocs, loops, `;` chains or `$(...)`.
