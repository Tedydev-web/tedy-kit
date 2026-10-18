# Source quality criteria, version 2

A sweep record pins this version and the first 16 hex characters of this file's sha256. Once a record pins it, a change means a new version file, never an edit to this one.

Unlike version 1, this version was not fixed before screening. It was revised while the first developer sweep (261018, facet test integrity) was screened, each time because a measured number missed its target. Every final score in that sweep is under the anchors below: each cell a revision changed was re-scored by both blind sessions, or derived afterwards from the mechanism table.

Basis: Garousi, Felderer and Mäntylä, "Guidelines for including grey literature and conducting multivocal literature reviews in software engineering" (arXiv 1707.02553), Table 7:

- the questions are authority of the producer, methodology, objectivity, date, position with respect to related sources, novelty, impact and outlet type;
- each question is scored yes = 1, partly = 0.5, no = 0;
- "There is no one-size-fits-all quality model", so the criteria below are adapted per source type.

## Revision log (2026-10-18)

| Time | Trigger, measured | Change | Cells redone |
|---|---|---|---|
| 19:10 | The version 1 screening order counted files. Its top 60 over 4,763 repositories were mirrors, awesome lists, skill dumps and fixtures; the top row was a mirror with 2,633 matching files. | Screening order by focus; vendored paths and blob-SHA copies dropped; aggregators snowballed. | None: order only. |
| 20:52 | The config stratum agreed on 217/252 cells (86.1%). Objectivity held 13 differing cells and Authority 7. | Authority and Objectivity anchors rewritten as checks. | Both sessions re-scored Authority and Objectivity on every row. |
| 20:52 | The 8-row saturation stop fired at row 26. Screening on found 17 more mechanisms in rows 27-71. | The effort bound decides the stop; saturation is only recorded (user decision). | Screening resumed to the effort bound. |
| 21:25 | The product stratum needs its own channels. | Product stratum, quasi-gold-standard recall check. | None. |
| 21:40 | The extension rule "any non-exclude in the last 10 rows" never stopped in the product stratum: 56 of its first 110 rows were eligible while new mechanisms fell to 0-2 per block. | Extend only while a new mechanism appears; hard cap of 200 (user decision). | Stop lines rewritten. |
| 22:00 | The product stratum agreed on 78.6% of cells: Position 34, Relevance 29, Novelty 26 differing. | Position, Novelty and product Relevance anchors rewritten as checks. | Both sessions in both strata re-scored Position and Novelty; the product sessions also re-scored Relevance. |
| 22:10 | Novelty still differed because each session classified mechanisms on its own. Rows with no coded mechanism reached eligibility on provenance alone. | Novelty and Relevance derived from one mechanism table; eligibility needs a coded mechanism and Novelty ≥ 0.5 (user decisions). | Novelty and Relevance derived for every row of both sessions. |
| 22:30 | Adjudicating disputed decisions needed two rules not yet written. | Methodology: tests must exercise the asset. Objectivity: a paid tier of the same product caps it at 0.5. | Applied to every adjudicated row. Elsewhere the sessions' cells stand; their recorded reasons show the same reading, with exceptions listed in the sweep record. |

## GitHub assets (repositories, skills, agents, hooks, commands)

| Criterion | 1 | 0.5 | 0 |
|---|---|---|---|
| Authority | The vendor (Anthropic), or the repository ships a released product, which means a GitHub release, a tag or a published package, and the asset governs work on that product or is the product itself | The owner has at least one other public repository, package or post on AI coding tooling, checked on the owner's page | Anonymous, an aggregator or awesome list, or a copy of another source |
| Methodology | Tests or evals that exercise the asset's own behaviour, and a changelog that covers the asset | Stated aim, examples and limits; or tests that only cover other parts of the repository or only check file structure | Prose only |
| Objectivity | Nothing sold, and at least one public artefact about this asset backs its claims: a linked issue or PR, a CI run, or a committed run log or benchmark | Nothing sold but no such artefact. Also capped here when the author sells a course or tool, or when an Enterprise edition, a hosted cloud or a paid tier of the same product exists, even if the asset is open and its issues are public | Marketing for a paid product |
| Date | Pushed within 90 days | Within 365 days | Older |
| Position | The README or a linked doc names at least one alternative tool or approach and states how this one differs | Names an alternative, predecessor, successor or inspiration without stating a difference | Names none |
| Novelty for the kit | Derived: at least one coded mechanism is new in the sweep's mechanism table | Derived: every coded mechanism is a known kit mechanism or a stricter or looser form of one | A copy of another source (harness copies count once, by content hash), or no coded mechanism |
| Impact (recorded, never sorted on) | Top third of the pool by log stars + log(closed issues + merged PRs) + channel count | Middle third | Bottom third |
| Relevance | Derived: at least one mechanism for the problem is coded from the source's own files | Only the README claims one | Neither |

**Mechanism table.** Each sweep has one mechanism table. It lists every mechanism name the screening sessions coded, reconciled by definition, and maps each to one of:

- a known kit mechanism (the screening packet lists them);
- a stricter or looser form of a known one, meaning it acts at the same point and checks the same property;
- new;
- evidence, which is not a mechanism and never counts.

Novelty and Relevance are computed from the table and the row's coded mechanisms, not judged per row.

**Eligible for deep study:** a source is eligible when all of these hold:

- Relevance = 1;
- Novelty ≥ 0.5;
- Authority + Methodology + Objectivity + Date + Position + Novelty ≥ 4.5 of 6.

Which eligible source is studied stays a judgment written as a reason. The threshold decides eligibility, not the pick.

## Screening order

**Graded relevance** feeds only the screening order and the forced-row notes. It is the sum of:

- the number of distinct code-search queries the repository hit;
- the agent-asset files (`.claude/`, `.claude-plugin/`, `.agents/`, `SKILL.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `skills/*/SKILL.md`, `agents/*.md`, `commands/*.md`, `hooks/hooks.json`) whose path or name holds a problem term as a whole word;
- 1 when the repository name or description holds a problem term;
- 0.5 for a social citation with a problem term.

Problem terms are the `terms` column of `problems.md`. Path matching uses the single words of those terms and their inflections, and the sweep record lists them. A word is left out when it alone names a different thing, for example `red`, `skip` and `weaken` for test integrity.

**Config stratum order.** Computed per repository as the sum of:

- the number of distinct code-search queries the repository hit;
- 1 when it has any original unit with a problem term;
- focus, the share of its non-vendored agent-asset units that are original units with a problem term;
- 1 for a name or description hit;
- 0.5 for a social citation hit.

The order is size-neutral on purpose. A log₂(1 + original units) try left 48 of the top 60 rows with at least 50 `SKILL.md` files, a size that only 5% of the pool reaches. Ties break on the more recent push, then the name.

**Vendored files.** An agent-asset file with a problem term is dropped when a path segment before its asset marker:

- holds a problem term;
- names a fixture, mirror, dataset, profile, example, vendor or imported-copy directory;
- ends in `-main`;
- or encodes another repository (`Owner@repo`, `Owner§repo`).

**Units.** A unit is either:

- a `skills/`, `agents/`, `commands/`, `hooks/`, `rules/` or `workflows/` entry; or
- otherwise, the first directory under `.claude/`, `.claude-plugin/` or `.agents/`.

A unit is original unless every counted file in it has a git blob SHA that also appears in a repository of the pool created earlier.

**Aggregators.** An aggregator is a repository whose name or description says awesome, mirror, curated, marketplace, "list of" or "directory of". A repository that holds at least three other repositories as `Owner@repo` or `Owner§repo` directories under a vendored directory is also an aggregator.

Aggregators are not screened. They are snowballed: the repositories they hold or link with a problem term join the pool and are screened like any other. Their count goes to the PRISMA "other methods" box.

**Product stratum.** Some repositories ship the mechanism as source code, so no agent-asset file of theirs holds a problem term. Such a repository joins this stratum when at least one channel finds it:

- a package registry search for the harness name and a problem term;
- a code search for the harness's hook input and output fields, outside agent-asset paths, together with a problem term;
- a hook command in a pool repository that runs its package;
- a social citation;
- a repository search for a problem term, or the intersection of a harness topic and a testing topic.

Its order is the distinct channels hit, plus log₂(1 + source files holding both the hook fields and a problem term), plus 1 for a name or description hit.

**Channel recall.** Recall is checked against a quasi-gold standard (Zhang, Babar and Tell, "Identifying relevant studies in software engineering", IST 2011):

- the standard is built from hand-curated lists, not from the channels;
- two judges build it, blind to each other and to the channels;
- disagreements are settled by reading the shipped source;
- the target is a quasi-sensitivity of at least 80%;
- below the target, add channel terms and rerun, and log every round.

Terms added to reach the target are word classes from the `terms` column, never names of the standard's repositories. The standard also guided those terms, so the final quasi-sensitivity is an upper estimate.

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

## Screening rules

- **Facet and order.** A facet is one (problem, context) pair. Rows are taken in screening order, per stratum.
- **Stop.** The effort bound is N = 60 unforced rows per facet and stratum.
  - After that, extend in blocks of 10 while either session coded at least one new mechanism in the last block.
  - The hard cap is 200 rows per stratum.
- **Saturation.** The longest run of rows that added no new mechanism is recorded. It does not stop screening.
- **Second session.** A second session screen-codes the same rows blind.
- **Chapman estimate.**
  - Mechanism names are first reconciled by definition, in a recorded map.
  - Over the two reconciled lists, restricted to rows both sessions screened, the estimate is N̂ = (n₁+1)(n₂+1)/(m+1) − 1. It estimates mechanisms missed within those rows, not beyond them.
  - When N̂ exceeds the union by more than 2, a third reader, blind to the sessions' scores, re-reads the files both sessions read, then lists the mechanisms neither list holds and the misattributions it finds.
- **Agreement.** Agreement is identical cells / all cells over Authority, Methodology, Objectivity, Date and Position, on every row both sessions screened. The target is at least 90%.
  - Every differing cell is listed.
  - Rows whose eligibility differs go to the user before deep study, or to adjudication by the user's decision. Adjudication records each row's cells and reasons.
- **Forced rows.** These are screened whatever their rank: the source of every existing card, the three tied repositories (obra/superpowers, mattpocock/skills, affaan-m/ECC) and the production-team stratum (metabase/metabase, microsoft/playwright, langgenius/dify, Significant-Gravitas/AutoGPT, OpenHands/OpenHands, CherryHQ/cherry-studio).
