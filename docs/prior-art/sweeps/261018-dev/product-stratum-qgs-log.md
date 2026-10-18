# Product stratum: channels, quasi-gold standard, rounds (2026-10-18)

## Quasi-gold standard

### Source

- 129 curated lists: aggregators whose name or description says awesome or curated and names an agent harness.
- The candidate lines are the README lines that hold both a GitHub link and a problem term: 333 lines, 217 unique repositories (`qgs-candidates.jsonl`).
- The selection rule was fixed before any channel output was read.

### Judges

- Two blind subagents judged the candidates (`qgs-judge-A.jsonl`, `qgs-judge-B.jsonl`).
  - Judge A: 5 yes, 4 unsure, 208 no.
  - Judge B: 8 yes, 2 unsure, 207 no.
- Agreement was 0.982, with Cohen's κ = 0.782.

### Adjudication

Four rows disagreed. Each was settled by reading the shipped source (`qgs-adjudicated.json`):

- timini/agentic-verification: yes. `runner/src/tsa/cli.py` `_base_check` runs the tests on the current and the base source.
- BaseInfinity/agentic-ai-sdlc-wizard: yes. `hooks/tdd-pretool-check.sh` exits 2 on writes to `src/` until a test file has been touched.
- BaseInfinity/claude-sdlc-harness: yes, but a copy of the same hook by the same owner.
- maxritter/claude-codepro: no. Its PostToolUse reminder returns 0.
- Guipetris/axiom: excluded, because the repository returns 404.

### Final standard

The final standard holds 8 repositories, which carry 7 distinct mechanisms.

## Rounds

| Round | Change | Repositories found / 8 | Mechanisms found / 7 |
|---|---|---|---|
| 1 | npm (`claude-code` + P1 terms), code search for the hook fields + P1 terms in 8 extensions, reverse hook commands, social | 5 (0.625) | 5 |
| 2 | P2 vocabulary (`deleted`, `weakened`, `skipped`, `tampering`, `mutation`, `integrity`) added to npm; new repository-search channel | 6 (0.750) | 6 (0.857) |
| 3 | Repository search on harness topic × testing topic | 7 (0.875) | 7 (1.000) |

The target is ≥ 0.80. It is met in round 3.

### Misses explained

- sdlc-wizard is absent from GitHub's code-search index; a repository-scoped query returns 0. Its copy claude-sdlc-harness was found.
- agentic-verification has 0 stars, so best-match repository search buried it. Its topics `claude-code` + `mutation-testing` found it in round 3.

### Bias

The terms added in rounds 2 and 3 are word classes from `problems.md` (P2's terms were missing from round 1) and topic intersections, never repository names. The standard still guided them, so 0.875 is an upper estimate. The standard has only 8 repositories, so one miss moves the estimate by 0.125.

## PRISMA (product stratum)

| Stage | Count |
|---|---|
| Identified, npm | 323 |
| Identified, code search | 6,347 |
| Identified, reverse references | 5 |
| Identified, social | 150 |
| Identified, repository and topic search | 1,526 |
| Union | 8,181 |
| Not resolvable | 60 |
| Aggregators removed | 238 |
| Screenable | 7,883 |
| Archived (kept, flagged) | 22 |

Channel failures:

- code search: 3 of 342 calls failed (one timeout, two HTTP 503);
- reverse: 7 calls failed;
- npm: 1 call failed.
