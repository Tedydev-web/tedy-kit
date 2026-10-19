# Source quality criteria, version 3

A sweep record pins this version and the first 16 hex characters of this file's sha256. Once a record pins it, a change means a new version file, never an edit to this one.

Version 3 keeps the anchors of version 2 and changes how screening is run and measured, after the method audit of 2026-10-19 found no protocol fixed before screening, no human calibration, no chance-corrected agreement for the sessions, no record of the screening models, recall measured only at pool level and no academic channel. It is fixed before screening: the pilot block may revise the screening packet, a revision of an anchor is a new version file, and the freeze pins whichever version the sessions then use. Version 2's revision log stays in `quality-criteria-v2.md`.

Basis: Garousi, Felderer and Mäntylä, "Guidelines for including grey literature and conducting multivocal literature reviews in software engineering" (arXiv 1707.02553), Table 7:

- the questions are authority of the producer, methodology, objectivity, date, position with respect to related sources, novelty, impact and outlet type;
- each question is scored yes = 1, partly = 0.5, no = 0;
- "There is no one-size-fits-all quality model", so the criteria below are adapted per source type.

## Changes from version 2 (2026-10-19)

| Gap the audit measured | Change | Source |
|---|---|---|
| Anchors were rewritten after measured misses and re-scored on the same rows, so 0.93 was a training-set figure. | Pilot block, then a protocol freeze; agreement only on rows after the freeze. | Kitchenham and Charters 5.4; AMSTAR-2 item 2 |
| Each session chose which file of a row to read, so the two sessions did not judge the same record. | The toolchain fetches each row's inputs once; both sessions score them without tools. | Systematic-review practice: both reviewers judge the same records |
| Percent agreement counted the computed Date column, a fifth of the cells. | The headline agreement and its target leave Date out; the figure with Date is also given, labelled; Cohen's kappa per judged criterion without Date, plus eligibility kappa. | EmpiricalStandards IRR supplement |
| The model and settings of the sessions were not recorded. | Each session's model id, effort, CLI version and isolation, and per block the packet, criteria and input sha256 and the date, are recorded. | PRISMA 2020 items 8-9; SEGRESS 11 |
| Chapman assumed independent sessions; reader C pushed the observed count past it. | Chapman is reported as a lower bound. | Capture-recapture assumption |
| Recall 0.875 described the pool; 2 of 8 standard repositories were inside the screened rows. | Recall at the cut, per stratum against its own standard. | Zhang, Babar and Tell 3.2.5 |
| No scholarly source was searched. | Academic channel: arXiv, and Semantic Scholar when it answers. | Garousi et al. G10 |
| Both sessions ran on one model family. | Session B fixed by the topic config on a different family, else its configured Claude fallback named as a threat; never chosen by agreement with A, which would pick the most error-correlated screener. | Kim et al. 2025, correlated errors |
| The stop rows in a topic config were typed by hand. | The toolchain writes the stop row from the screening data. | Kongming counsel, 2026-10-19 |
| No human checked the screening. | A 10-row blind calibration sample; unrated, the record names LLM-only screening as a threat. | Cartaxo et al. 4.2.2; RAISE |

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

**Recall at the cut.** Each of the config and product strata has its own standard. Recall at the cut is the share of a stratum's standard whose repositories rank at or above the stop row, are forced, or were snowballed above the cut. The target is again 80%. Below it, change the screening-order formula or the cut, not the terms: the terms already find those repositories, the order ranks them too low.

**Academic channel.** arXiv queries and, when it answers without a key, Semantic Scholar queries run per topic. Each paper is logged with the queries that found it, and the repositories its abstract names join the pool. The papers themselves are logged, not screened, and the record names that as a threat.

**Standards per stratum.** Both standards start from the repositories that the curated lists among the config aggregators name, extracted per stratum with `extract-qgs-candidates.py --stratum <s>`. The judge packet differs: for the config stratum a judge asks whether the repository's own agent assets (skills, agents, hooks, rules) carry a mechanism for the problem; for the product stratum, whether the repository ships the mechanism as source code a harness runs. Each stratum's judges and adjudication are recorded in its own `<stratum>-qgs-*` files.

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
- **Tag-only strata.** A stratum with no discovery channels, such as the local inventory of installed assets, carries tags and never copied text. It gets no inputs, sessions, freeze or stop row, and the record states that two sessions did not screen it.
- **Inputs.** For each row the toolchain pins the commit and fetches the README excerpt, the top-level listing and at most two asset files: for the config stratum the unit's files, `SKILL.md`, `AGENTS.md`, `CLAUDE.md` and `hooks/hooks.json` first; for the product stratum the contract files. Both sessions score these same inputs and have no tools, so neither chooses what to read. The fetched text stays out of the repository; the record pins its sha256.
- **Pilot block and freeze.**
  - Both sessions screen the first `pilot_rows` unforced rows of each stratum (20 by default). The packet may be revised on what they show.
  - Session B is the model the topic config names. Its fallback runs only when B's CLI is not on PATH, and other configured models may screen the pilot block for information; the freeze never picks B by its agreement with A.
  - Both pilot files must cover every unforced rank of the pilot block, and the record states the real pilot size.
  - Then the protocol freezes: the full sha256 of the criteria and of the packet are pinned separately per stratum, with sessions A and B. A packet revised after the pilot is recorded with what changed, and the pilot packet is kept beside the frozen one. Every row is then screened under the frozen protocol, the pilot rows again included; a session refuses to run when the criteria or the packet differ from the freeze.
- **Sessions.** Session A runs on the frozen Claude model; session B on the frozen model, a different family when its CLI is reachable, otherwise the configured Claude fallback, and the record then names "same model family" and the fallback as threats. Each session runs in an empty temporary folder with stdin closed, no tools, no settings, MCP servers, slash commands or session persistence, and answers in one turn; a reply that used tools, wrote a file or came from another model than the one requested is refused. Each session records its model id, effort, CLI version and isolation; each block its ranks, packet, criteria and input sha256 and date. Sessions A and B must have scored identical inputs for every rank both screened.
- **Stop.** The effort bound is N = 60 unforced rows per facet and stratum.
  - After that, extend in blocks of 10 while either session coded at least one new mechanism in the last block.
  - The hard cap is 200 rows per stratum.
  - A pool that runs out first stops at its last unforced row.
  - Every unforced rank up to the stop must have been screened by both sessions.
  - The stop row is derived from both sessions' data and written into the topic config by the toolchain, never typed by hand.
- **Saturation.** The longest run of rows that added no new mechanism is recorded. It does not stop screening.
- **Second session.** A second session screen-codes the same rows blind.
- **Chapman figure.**
  - Mechanism names are first reconciled by definition, in a recorded map.
  - Over the two reconciled lists, restricted to rows both sessions screened, N̂ = (n₁+1)(n₂+1)/(m+1) − 1 is a lower bound, not an estimate: the sessions share the packet and the rows, so they are not independent captures, and positive dependence biases N̂ low.
  - When N̂ exceeds the union by more than 2, a third reader, blind to the sessions' scores, re-reads the inputs both sessions scored, then lists the mechanisms neither list holds and the misattributions it finds.
- **Agreement.** On the rows ranked after the pilot block:
  - identical cells / all cells over Authority, Methodology, Objectivity and Position, with a target of at least 90%; Date is computed, not judged, so it is left out of the headline and the target, and the figure with Date is given beside it, labelled;
  - Cohen's kappa per judged criterion, without Date; a criterion where both sessions used one category only has an undefined kappa, stated as such;
  - eligibility kappa over the derived decisions;
  - every differing cell is listed;
  - rows whose eligibility differs go to the user before deep study, or to adjudication by the user's decision. Adjudication records each row's cells and reasons.
- **Calibration.** The toolchain draws 10 rows ranked after the pilot block, five per stratum, taken in turn from rows both sessions found eligible, both excluded and disputed. The user rates them blind under these anchors from the same inputs the sessions scored, before reading the record; ratings are 1, 0.5 or 0, and decisions eligible or excluded. The record reports the user's agreement with each session on decisions and judged cells, or names "LLM-only screening" as a threat while the sample is not fully rated.
- **Forced rows.** These are screened whatever their rank: the source of every existing card and the `forced_repos` of each stratum in the topic config.
