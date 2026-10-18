# Source quality criteria, version 1

Fixed before any source is screened. A sweep record pins this version and the first 16 hex characters of this file's sha256; changing the criteria means a new version file, never an edit to this one after a sweep pins it.

Basis: Garousi, Felderer and Mäntylä, "Guidelines for including grey literature and conducting multivocal literature reviews in software engineering" (arXiv 1707.02553), Table 7: authority of the producer, methodology, objectivity, date, position w.r.t. related sources, novelty, impact, outlet type; each question scored yes = 1, partly = 0.5, no = 0; "There is no one-size-fits-all quality model", so the criteria below are adapted per source type.

## GitHub assets (repositories, skills, agents, hooks, commands)

| Criterion | 1 | 0.5 | 0 |
|---|---|---|---|
| Authority | A product team's own agent assets on the product it ships (for example `.claude/` in the repository of a released product), or the vendor (Anthropic) | A named individual or team with other published work in the field | Anonymous, aggregator, awesome-list only, or copies of one skill per harness |
| Methodology | The asset has its own tests or evals and a changelog | Stated aim, examples and limits, no tests | Prose only |
| Objectivity | Nothing sold; claims tied to issues, PRs or runs | Author sells a course or tool, but the asset is open and its issues are public | Marketing for a paid product |
| Date | Pushed within 90 days | Within 365 days | Older |
| Position | Compares or cites alternatives in its README or issues | Mentions them | None |
| Novelty for the kit | Adds a mechanism the kit lacks for the problem | A variant of a mechanism already known | A copy of another source (harness copies count once, by content hash) |
| Impact (recorded, never sorted on) | Top third of the pool by log stars + log(closed issues + merged PRs) + channel count | Middle third | Bottom third |
| Relevance | Graded relevance ≥ 2 and at least one agent-asset file holds a problem term | Any relevance signal (graded relevance ≥ 0.5) | No signal |

Graded relevance, used only to order the screening: number of distinct code-search queries the repository hit, plus agent-asset files (`.claude/`, `.claude-plugin/`, `.agents/`, `SKILL.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `skills/*/SKILL.md`, `agents/*.md`, `commands/*.md`, `hooks/hooks.json`) whose path or name holds a problem term as a whole word, plus 1 when the repository name or description holds a problem term, plus 0.5 for a social citation with a problem term. Problem terms are the `terms` column of `problems.md`. Ties break on the more recent push, then the name.

**Eligible for deep study:** Relevance ≥ 0.5 and Authority + Methodology + Objectivity + Date + Position + Novelty ≥ 4.5 of 6. Which eligible source is studied stays a judgment written as a reason; the threshold decides eligibility, not the pick.

## Posts, videos and threads (X, Reddit, YouTube, Facebook, blogs)

| Criterion | 1 | 0.5 | 0 |
|---|---|---|---|
| Authority | Author's role or affiliation is known and in the field (Anthropic staff included) | Pseudonymous with a track record in the channel | Unknown |
| Objectivity | Shows a run, transcript or diff | Describes a specific incident without an artefact | Opinion only |
| Date | Stated and within 365 days | Stated, older | None |
| Outlet tier (Table 7) | Official docs, white paper, guide | Video, talk, Q&A thread | Tweet, blog comment, Reddit comment |
| Impact (recorded only) | Top third of likes + comments + views in the channel sample | Middle third | Bottom third |
| Relevance | Names a mechanism or a failure for the problem | Names the problem | Neither |

**Quote-eligible:** Relevance = 1 and Objectivity ≥ 0.5.

## Screening rules (user decisions, 2026-10-18)

- Order: graded relevance. Stop at whichever fires first, and write which: saturation after 8 consecutive screen-coded rows add no new mechanism; or effort bound N = 60 per facet, extended in steps of 10 while the last 10 rows yield a non-exclude.
- A facet is one (problem, context) pair.
- A second session screen-codes the same rows blind; the Chapman estimate N̂ = (n₁+1)(n₂+1)/(m+1) − 1 over the two mechanism lists; when N̂ exceeds the union by more than 2, both screen 10 more rows.
- Agreement: the second session also scores ≥ 10 sampled rows; agreement = identical cells / all cells, at least 90%; every differing cell is listed and disagreements go to the user before deep study.
- Forced rows, screened whatever their rank: the source of every existing card, the three tied repositories (obra/superpowers, mattpocock/skills, affaan-m/ECC) and the production-team stratum (metabase/metabase, microsoft/playwright, langgenius/dify, Significant-Gravitas/AutoGPT, OpenHands/OpenHands, CherryHQ/cherry-studio).
