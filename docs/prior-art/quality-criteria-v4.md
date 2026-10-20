# Source quality criteria, version 4

A sweep record pins this version and the first 16 hex characters of this file's sha256. Once a record pins it, a change means a new version file, never an edit to this one.

Version 4 keeps the anchors of version 3 and changes how a broad topic is split, how its recall is measured, how it is screened and how its judges are checked. The changes follow the methods review of 2026-10-20 and the user's decisions of 2026-10-20 06:45, 09:30 and about 11:00 (two-stage screening and the calibration batches). Version 3 stays in `quality-criteria-v3.md`, unchanged, because records pin its hash.

Basis: Garousi, Felderer and Mäntylä, "Guidelines for including grey literature and conducting multivocal literature reviews in software engineering" (arXiv 1707.02553), Table 7:

- the questions are authority of the producer, methodology, objectivity, date, position with respect to related sources, novelty, impact and outlet type;
- each question is scored yes = 1, partly = 0.5, no = 0;
- "There is no one-size-fits-all quality model", so the criteria below are adapted per source type.

## Amendment from version 3 (2026-10-20)

| Change | Why | Source |
|---|---|---|
| A facet is a cluster of registry problems declared in the topic config, not one (problem, context) pair. Facets are a labelling and reporting layer: screening runs once per topic, and a row counts toward every facet its stage-1 problem labels name and once in pooled figures. | One ranking for the 31 problems of the canon topic could not reach recall: at the 60-row cut config recall was 0.125 and product 0.036, and no order formula reached 0.15 at 200 rows. Splitting a broad review into narrower ones is the reason Cochrane gives for splitting; the facets follow the registry's lifecycle frame, set before the facet sweeps ran. | Cochrane Handbook ch. 2.3.1; Campbell evidence-and-gap maps (White et al. 2020); `canon-recall-diagnosis.md` |
| The quasi-gold standard is extracted and judged once per topic with the topic's terms, never a facet's. Both judges label the problem ids each member addresses, and a member belongs to every facet that holds one of its problems. A candidate judged by one judge or by neither is a gap that fails the record and the gate until it is judged or dropped with a recorded reason; a judge's reply is checked (ids, repository names, verdicts, problem ids) before anything is written. | A facet standard drawn with the facet's terms is filtered by the same terms that rank the facet, so its recall is circular; a standard that silently drops a candidate shrinks without a trace. | Methods review Q1; Tran et al. 2022; review round 1 |
| The toolchain computes the standard: a member is a candidate both Claude judges answer yes, or the reader's yes on a queued candidate. The reader's queue holds the candidates the judges disagree on or call unsure, and those both Claude judges reject but the cross-family judge accepts. The cross-family judgments join the candidates by repository name; a row whose id and name disagree fails. | The judges are one model family; the cross-family judge's yes is the one signal of an error the pair shares, so it is read, not dropped. | Kim et al. 2025 (correlated errors) |
| Every judge is validated on the input shape it reads in production: the QGS judges and the reader on the thin shape (README, listing and evidence, without asset files and discovery facts), screening sessions A and B on the full shape, each stage-1 rung on its own shape. Only judgments from a validated judge in the validated workflow count. | A judge validated on one workflow says little about another: performance "depended on the implemented workflow, not model identity alone". | Figalová et al. 2026 |
| Two-stage screening replaces depth-to-cap. Stage 1 screens the whole deduplicated pool of each stratum on name and description, in batches of at most 100 rows, with 2 or 3 worked examples per verdict; only a no excludes, and a row with no text passes unread. Stage 2 is the full screening by sessions A and B, with the reader, of every stage-1 pass. When the passes exceed what can be screened, stage 2 ranks them by facet and stops on the pooled recall target; the stop is recorded. | A cut on one ranking left most of the standard unscreened. Automated first-stage screening is accepted when its sensitivity is measured against human labels and only clear exclusions are dropped; batches above about 200 rows lose sensitivity. | `research-two-stage-screening.md`; Cochrane Handbook ch. 4.6.6.2; Tran et al. 2024; CESM 2026 (batch size) |
| The stage-1 ladder is frozen before any calibration label is read: rung 1 claude-sonnet-5-5 alone; rung 2 claude-opus-5-5 with claude-sonnet-5-5, a row excluded only when both say no; rung 3 adds the agent-asset paths of config rows; rung 4 adds the first README lines. The first rung whose two calibration runs reach a pooled one-sided 95% Clopper-Pearson lower bound of 0.95 on the user's eligible rows (no miss on at least 59 positives) is used; the record states the rung and every rung tried. No kappa is asked of stage 1. A rung above the first needs a held-out batch the user labels after the choice, on which it misses no positive. | A rung chosen after reading the labels would fit the labels; 59 of 59 is the smallest count whose lower bound reaches 0.95. | Clopper and Pearson 1934; user decision 2026-10-20 ~11:00 |
| The 10-row calibration sample is replaced by a calibration set of 60 rows per stratum, drawn after the stage-1 inputs exist, about half likely positives, about 10 per facet. The user labels eligibility, the problem ids and five criteria: Authority, Methodology, Objectivity, Position and Relevance; Date is computed, so it is shown, not asked. A top-up batch of 30 to 40 enriched rows is drawn only when the set holds fewer than 59 positives pooled (its rows join the pooled bound) or a rung above the first was chosen (it is held out). | 20 rows cannot tell kappa 0.6 from 0.8; 60 enriched rows mostly can. Relevance replaces Date among the labelled criteria because the QGS judges and the reader are checked against a human relevance label. | Methods review Q3 (simulation); user decision 2026-10-20 ~11:00 |
| Every judge, screening sessions A and B, both QGS judges and the reader, runs twice on the calibration set and qualifies only with sensitivity of at least 0.90 and kappa of at least 0.60 against the user's labels; each user criterion is compared with the judges with its interval. A judge that fails is replaced before use. | No judge had been compared with a human; validation does not transfer between reviews. | JUDGE-BENCH (Bavaresco et al. 2024); medRxiv 2026 meta-analysis; McHugh 2012 |
| Recall is pooled over the topic's deduplicated standard, with its Clopper-Pearson 95% interval, and the 0.80 target binds the pooled figure. Each facet's recall is reported with its interval and no pass or fail. Recall is split into the in-pool rate (discovery) and the stage-1 pass rate of in-pool members (screening). QGS recall is an upper estimate: the QGS judges are the stage-1 models, and the candidates are term-filtered. | About 8 members per facet cannot estimate 0.80: 8 of 10 has the interval 0.44-0.97. A pooled figure can. The split shows whether a miss is a discovery or a screening failure. | Zhang, Babar and Tell 2011 §3.2.5; methods review Q2 |
| A product channel draws the config pool before stage 1: every config pool repository whose name or description passes the product filter joins the product pool. The record states how many joined, how many standard members that pass the product filter they recover, and how many such members remain outside every pool, a discovery threat. | 33 of the 55 product standard members were missing from the product pool but present in the config pool. | `canon-recall-diagnosis.md` |
| A facet's ranking, which orders stage 2 only when stage 2 must stop, counts only the facet's own terms and the code-search queries built from them, and in the product stratum only evidence of product channels that names one of those terms; the config-pool channel never counts. | Code-search queries of other facets lifted 43 of the permissions facet's top 60 config rows; channels found by other facets' terms lifted product rows the same way. | Permissions facet measurement, 2026-10-20; review round 1 |
| The roster for the canon topic is Claude: session A and the reader claude-opus-5-5, session B claude-sonnet-5-5, the QGS judges the same pair. The partial cross-family QGS judgments are kept, and a random audit sample of screened rows, drawn after stage 2 ends, is screened again by a non-Claude model when one is reachable. The record names the same-family threat and the audit result. | The cross-family CLI hit its quota on 2026-10-20 08:45; the user chose Claude for every judge rather than wait. | User decision 2026-10-20 09:30 |
| Snowballed repositories join the pool with no cut and pass through stage 1 like any row, numbered from 1001, and their count goes to PRISMA "other methods" as in version 3. The version 3 cut, and the rerun of the snowball once the stop row is written, are dropped because two-stage screening has no stop row. The record refuses a snowballed repository that is not in the stage-1 pool. | The cut existed only because screening stopped at a row; stage 1 reads the whole pool. | Wohlin 2014 (snowballing); version 3 Aggregators rule |
| PRISMA and recall are computed from the sweep files: records identified per channel, duplicates, stage-1 screened, excluded by automation per model and under the union rule, stage-2 assessed, excluded with reasons, included, and included per facet with their overlap. The record prints no typed recall or PRISMA, and the gate recomputes the counts from the files. | PRISMA 2020 asks how many records automation excluded and how; typed counts drifted from the data. | PRISMA 2020 item 8 and flow diagram (Page et al. 2021) |
| A judge run, a stage-1 run or a screening block is dropped and redone with `drop-run.py` or `drop-screening-block.py`, which keep a copy of the block and its rows and record the drop with its reason in `meta.json`; `meta.json` is never edited by hand. | A redo by hand edit leaves no trace of what was dropped and why. | Review round 1 |
| The v4 sweep is named `<yymmdd>-<topic>` for the date its calibration set is drawn; the draw refuses another name. | v1 and v2 work folders of the canon topic exist; a name chosen at the draw cannot be confused with them. | Phase 02c constraints |

## Amendment, revision 3 (2026-10-20)

| Date | Change | Why | Source |
|---|---|---|---|
| 2026-10-20 | The stage-2 stop is pooled: the stage-1 passes of every stratum are ranked together by their best facet rank, and stage 2 stops at the first depth where pooled recall over every deduplicated standard member, including members lost at discovery or stage 1, reaches 0.80; the record states that recall with its interval. When those losses make 0.80 unreachable, stage 2 screens every pass and the record names the threat. This replaces the stop on 0.80 of the stratum's standard members that passed stage 1 in the Stage 2 rule below, which contradicted the pooled target of the two-stage row above. | A per-stratum stop over the members that passed stage 1 can stop while pooled topic recall is certainly below 0.80. | Phase 02c revision 3 decisions; review round 2 (fidelity M1, correctness M) |

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

## Facets

- A facet is a cluster of registry problems declared under `facets` in the topic config: its problems and its terms (a subset of the topic's). Every topic problem sits in exactly one facet. A topic that is not split declares one facet holding every problem.
- Discovery, the standard, stage 1 and stage 2 run once for the topic. Each facet ranks its pool in its own folder, `<work>/facets/<facet>/`, linked to the topic's discovery; the ranking orders stage 2 only when stage 2 must stop.
- A row counts toward every facet its stage-1 problem labels name, and once in pooled figures; the record publishes the included rows per facet and their overlap.

## Screening order

**Graded relevance** feeds only the screening order and the forced-row notes. It is the sum of:

- the number of distinct code-search queries the repository hit;
- the agent-asset files (`.claude/`, `.claude-plugin/`, `.agents/`, `SKILL.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `skills/*/SKILL.md`, `agents/*.md`, `commands/*.md`, `hooks/hooks.json`) whose path or name holds a problem term as a whole word;
- 1 when the repository name or description holds a problem term;
- 0.5 for a social citation with a problem term.

Problem terms are the `terms` column of the registry. Path matching uses the single words of those terms and their inflections, and the sweep record lists them. A word is left out when it alone names a different thing, for example `red`, `skip` and `weaken` for test integrity.

**Facet terms.** A facet's order counts only the facet's own terms, and only the code-search queries that hold one of them; the ranked file lists the counted queries. The topic's other queries still feed discovery.

**Config stratum order.** Computed per repository as the sum of:

- the number of distinct counted code-search queries the repository hit;
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

Aggregators are not screened. They are snowballed once for the topic: the repositories they hold or link with a topic term join the config pool as rows 1001 and on (`snowball-above-cut.py --all`, then `merge-snowball-order.py`), and stage 1 reads every one. Their count goes to the PRISMA "other methods" box. The record refuses a snowballed repository that is not in the stage-1 pool.

**Product stratum.** Some repositories ship the mechanism as source code, so no agent-asset file of theirs holds a problem term. Such a repository joins this stratum when at least one channel finds it:

- a package registry search for the harness name and a problem term;
- a code search for the harness's hook input and output fields, outside agent-asset paths, together with a problem term;
- a hook command in a pool repository that runs its package;
- a social citation;
- a repository search for a problem term, or the intersection of a harness topic and a testing topic;
- the config pool: a config pool repository whose name or description holds a harness word and a problem term, when the topic config sets `strata.product.channels.config_pool`. It joins before stage 1 runs on the product stratum. The record states how many joined, how many standard members that pass the same filter (on their name and list line) they recover, and how many such members remain outside every pool.

Its order is the distinct channels hit, plus log₂(1 + source files holding both the hook fields and a counted code-search query's problem term), plus 1 for a name or description hit.

**Academic channel.** arXiv queries and, when it answers without a key, Semantic Scholar queries run per topic. Each paper is logged with the queries that found it, and the repositories its abstract names join the pool. The papers themselves are logged, not screened, and the record names that as a threat.

## Quasi-gold standard

- **Candidates.** The topic's candidates are the repositories that the curated lists among the config aggregators name on a line holding a topic term, extracted once per topic with `extract-qgs-candidates.py` from a ranking made with the topic's terms. A facet never extracts its own.
- **QGS judges.** Two blind judges answer yes, no or unsure per candidate and, for a yes, the problem ids of the topic the repository carries a mechanism for. They score the toolchain's pre-fetched thin inputs of each candidate (`qgs-inputs.jsonl` without asset files and discovery facts), through the same runner and in the same shape as on the calibration set. A reply is checked before it is written: every row names its candidate, the verdict is yes, no or unsure, a yes names a problem id, and every id is a topic problem.
- **Gaps.** Every candidate is judged by both judges, or dropped with `drop-qgs-candidates.py` and a reason the standard lists; a candidate judged by one judge or by neither fails the standard, the record and the gate.
- **Reader.** The reader judges every queued candidate, in the same format: those the judges disagree on or call unsure, and those both Claude judges reject but the cross-family judge accepts.
- **Standard.** The toolchain builds it: the candidates both judges answered yes, labelled with the union of their problem ids, and the reader's yes on a queued candidate, labelled with the reader's ids. A member belongs to every facet holding one of its problems.
- **Cross-family judge.** Its judgments, partial or whole, are kept and joined to the candidates by repository name; a row naming a repository that is not a candidate, or an id that names another candidate, fails. The record states its agreement with each Claude judge on the overlap and what the reader decided on the candidates only it accepted.

**Channel recall.** The share of the standard the discovery channels found, per stratum. Below 80%, add channel terms and rerun, and log every round. Terms added to reach the target are word classes from the registry's `terms` column, never names of the standard's repositories. The standard also guided those terms, so the final figure is an upper estimate.

**Recall.** Pooled over the topic's deduplicated standard: the share of its members that both stage-2 sessions screened, stated with its Clopper-Pearson 95% interval, split into the in-pool rate (members in some stratum's pool) and the stage-1 pass rate of in-pool members. The target is 0.80 on the pooled figure. Each facet's recall counts the members labelled for that facet the same way, with its interval and no pass or fail. Every recall figure is an upper estimate, since the QGS judges are the stage-1 models and the candidates are term-filtered.

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

- **Order.** The pool of each stratum is exported whole with `export-screening-order.py --all`; its rank is the row number every stage reads. The pilot block is its first `pilot_rows` unforced rows.
- **Tag-only strata.** A stratum with no discovery channels, such as the local inventory of installed assets, carries tags and never copied text. It gets no inputs, sessions, freeze or stop row, and the record states that two sessions did not screen it.
- **Inputs.** For each row the toolchain pins the commit and fetches the first 8000 characters of the root README (any `README` or `README.<ext>` at the top of the tree, in any case), the top-level listing and at most two asset files of at most 8000 characters each: for the config stratum the unit's files, `SKILL.md`, `AGENTS.md`, `CLAUDE.md` and `hooks/hooks.json` first; for the product stratum the contract files that the pinned tree holds. A binary asset is marked binary and not shown.
  - The anchors read from these fields: stars, last push, creation date, license, closed issues and merged pull requests, carried from discovery through the screening order; release count, latest release and its date, and tag count and latest tag, a count of a full page shown as "100+"; the owner's public repository count and the owner's ten most-starred repositories that are not forks, among the first 100 the API lists, with their descriptions; the `.github/workflows` file names; the test paths, under a `test`, `tests`, `__tests__`, `spec`, `e2e`, `eval`, `evals`, `benchmark` or `benchmarks` folder at any depth or named like a test file, counted and listed up to 30; the first 1500 characters of the CHANGELOG; and the npm or PyPI package named by `package.json` or `pyproject.toml`, whether it is published and its latest version.
  - Date is not judged: the toolchain computes it from the row's last push and the sweep date, the `yymmdd` that starts the sweep name, under the anchor above. The prompt states the sweep date, the computed value replaces every judge's Date, and each row keeps the judge's value as `session_date`.
  - Every judge scores these same inputs and has no tools, so none chooses what to read. A long block is split into smaller blocks; the evidence is never cut to fit. The fetched text stays out of the repository; the record pins its sha256.
  - A row error is permanent only when the commit or the tree request answers 404 or 410, or GitHub cannot resolve the repository; a permanent error row is coded dead. Every other failure, a network or DNS failure included, is transient. A file that the pinned commit lacks or that answers 404 (README, contract file, CHANGELOG, package manifest) goes to the row's `missing` list instead: the row is scored from what is present. A package that the registry answers 404 for is recorded as not published; any other registry failure is a transient error.
  - A tree too large for one listing is partial, never dead: its listing joins the truncated recursive tree, the root listing and the listing of each unit folder, and the row is marked `tree: partial`. A unit folder whose listing fails makes the row a transient error, and the partial tree is not cached until every unit folder was listed.
  - A block holding a transient error row does not run until a later fetch succeeds. `--mark-permanent` is only for a row whose commit or tree request failed and whose repository or commit the operator found gone by hand; any other transient row is fetched again; it refuses a scored rank and a row already permanent. A rank that a session block has scored is never fetched again, and the pinned commit is kept across fetches.
  - `drop-screening-block.py` and `drop-run.py` remove one recorded block of a screening session, a judge run or a stage-1 run, with its rows and the mechanism lines it added, keeping numbered copies in `dropped/` and recording the drop with its reason in `meta.json`. A dropped rank that no other session block holds loses its inputs, so the next fetch reads them again at the pinned commit; to screen a rank again in both sessions, drop it from both. Delete the rank's tree cache entry to pin a newer commit.
- **Pilot block and freeze.**
  - Both sessions screen the first `pilot_rows` unforced rows of each stratum (20 by default). The packet may be revised on what they show.
  - Session B is the model the topic config names. Its fallback runs only when B's CLI is not on PATH, and other configured models may screen the pilot block for information; the freeze never picks B by its agreement with A.
  - Both pilot files must cover every unforced rank of the pilot block, and the record states the real pilot size.
  - Then the protocol freezes: the full sha256 of the criteria, of the packet and of the prompt template (the row note and the reply format) are pinned separately per stratum, with sessions A and B. A packet revised after the pilot is recorded with what changed, and the pilot packet is kept beside the frozen one. Every row is then screened under the frozen protocol, the pilot rows again included; a session refuses to run when the criteria, the packet or the prompt template differ from the freeze.
- **Calibration set.** Drawn per stratum after the stage-1 inputs exist and after the stage-1 ladder is frozen, before any judge is run on it, on the date the sweep is named for:
  - 60 rows, split evenly over the facets (about 10 per facet when there are six), drawn from the whole pool by each facet's ranking with a seed taken from the sweep name;
  - about half are likely positives, the facet's rows that are QGS candidates or among its ten best ranks, the rest drawn at random from the facet's other rows; a row is drawn once, whatever facets hold it;
  - a row whose inputs could not be read because its repository or commit is gone is replaced from the same pool;
  - the rows are shown in a shuffled order on a self-contained Vietnamese page in the working folder, with the inputs every judge scores and the computed Date, and with the anchor text beside each choice; the page shows no judge's or session's answer and nothing of how a row was drawn;
  - the user labels eligibility (eligible, or excluded with its code), the problem ids the repository carries a mechanism for, and five criteria: Authority, Methodology, Objectivity, Position and Relevance, each 1, 0.5 or 0. Eligible needs Relevance 1, and Relevance 1 needs a problem id. Date is computed, so it is shown, not asked. The user decides eligibility with Novelty = 1 for any row with a mechanism, the rule the judges' decisions are derived with;
  - the page saves the labels as JSON, which `import-calibration-labels.py` checks against the batch and the stage-1 freeze before it keeps them;
  - a top-up batch of 30 to 40 enriched rows (`draw-calibration-set.py --top-up N`) is drawn only when a trigger fires: fewer than 59 positives pooled, and its rows join the pooled bound; or a stage-1 rung above the first was chosen, and the batch is held out: the chosen rung must miss none of its positives, its own bound is reported apart, and the record states that the pooled bound was measured on the set the rung was chosen on.
- **Judges.** The roster is in the topic config: sessions A and B screen, `qgs_judges` A and B build the standard, `reader` reads the queue, and `cross_family` names the model of the partial QGS judgments and the audit. Stage 1 runs the frozen ladder.
  - Every judge runs twice on the calibration rows (the set and a top-up batch whose rows join the pooled bound), each run in its own empty session, on the input shape it reads in production: the full shape under the frozen packet, criteria and template for A and B, the thin shape under the QGS packet for the others. A run too long for one prompt is split into blocks of rows, never cut; the run is validated whole.
  - A screening judge's decision is derived as the record derives a session's, with every coded mechanism counted as new, because the mechanism table is built only after screening; it is compared with the user's eligibility. A QGS judge's or the reader's yes is compared with the user's Relevance of 1. Unsure counts as not yes.
  - A judge qualifies in a stratum when both runs reach sensitivity of at least 0.90 on the user's positive rows and Cohen's kappa of at least 0.60, compared unrounded. The record states each run's sensitivity with its Clopper-Pearson interval, specificity, kappa, each criterion's agreement with the user (for the QGS judges and the reader, problem-id agreement) with its interval, and the run-to-run disagreement.
  - A screening session, a QGS run and the record refuse a judge that did not qualify; a QGS run also refuses a packet other than the one the judge was validated under. A judge that fails is replaced in the topic config and validated again.
  - The reader comes from a different model family than at least one QGS judge, or the record names the shared family as a threat.
- **Sessions.** Session A runs on the frozen model; session B on the frozen model. When A and B share a model family the record names "same model family" as a threat. Every session runs in an empty temporary folder with stdin closed; a session that writes a file there is refused.
  - Claude runs with `--tools '' --setting-sources '' --strict-mcp-config --no-session-persistence --disable-slash-commands --max-turns 1`, plus `--bare` when an API-key auth source is set. Without `--bare` the installed plugins still load, so the record names "plugin hooks not excluded (no --bare)" as a threat. A reply is refused unless it took one turn with no permission denials and was served by the requested model.
  - agy runs with `--output-format stream-json --disable-slash-commands`. It has no flag that excludes its configured MCP servers, hooks or user settings, and its tools stay offered; `--mode plan --sandbox` did not stop a shell command in a probe, so it is not used. The record names "agy MCP servers, hooks and user settings not excluded" as a threat. A reply is refused when it holds any tool step, a denied action, a status other than SUCCESS or a second turn. The effort of an agy model is the one its id names: `--effort` conflicts with an id that names one, so an agy session option sets no effort.
  - Each session and each judge run records its model id, effort and isolation; each block its ranks, a row sha256 for every rank, the packet, criteria, prompt and input sha256, the CLI version and the date. A CLI version change within a session is reported as a threat, not refused. The recorded models must be the frozen ones. Sessions A and B must have scored identical inputs for every rank both screened.
- **Audit.** When `cross_family` names a model, 20 rows per stratum are drawn at random, seeded by the sweep name, from the rows both sessions screened after the pilot block, once stage 2 ended, and that model screens them under the frozen protocol. The record states its eligibility agreement and kappa with each session, or, while it has not run, names the pending audit as a threat.
- **Stage 1.** `freeze-stage1.py` freezes the ladder, the worked examples, the stage-1 packets and the prompt template before any label is read. `build-stage1-inputs.py` writes one inputs file per stratum and shape, and the calibration runs, the held-out runs and the pool runs read the same file. `choose-stage1-rung.py` writes the first rung that meets the pass rule with every rung tried; `run-stage1.py --set pool` then screens the whole pool in batches of at most 100 rows, refusing a rung above the first until it missed no held-out positive.
- **Stage-1 audit.** `draw-stage1-audit.py` lists the model disagreements (they pass under the union) and draws 200 near-boundary excludes (both models said no, but the name or description holds a topic term) and 100 random far excludes. The stage-2 screener reads them with README; the user checks only the rows it flags (`import-audit-checks.py`); the record states each part's upper elusion bound.
- **Stage 2.** `plan-stage2.py` lists every stage-1 pass of every stratum; sessions A and B screen exactly those rows. With `--limit` (rows across all strata), the passes of every stratum are ranked together by their best facet rank and stage 2 stops at the first depth where pooled recall over every deduplicated standard member reaches 0.80, or at the limit; the record states the stop with its interval and names it as a threat. When fewer members passed stage 1 than 0.80 needs, stage 2 screens every pass and the record names the unreachable target as a threat. Every listed row must be screened by both sessions.
- **Saturation.** The longest run of rows that added no new mechanism is recorded. It does not stop or extend screening.
- **Second session.** A second session screen-codes the same rows blind.
- **Chapman figure.**
  - Mechanism names are first reconciled by definition, in a recorded map.
  - Over the two reconciled lists, restricted to rows both sessions screened, N̂ = (n₁+1)(n₂+1)/(m+1) − 1 is a lower bound, not an estimate: the sessions share the packet and the rows, so they are not independent captures, and positive dependence biases N̂ low.
  - When N̂ exceeds the union by more than 2, a third reader, blind to the sessions' scores, re-reads the inputs both sessions scored, then lists the mechanisms neither list holds and the misattributions it finds.
- **Agreement.** On every row both sessions screened that is ranked after the pilot block; the comparison and the record use this one row set:
  - identical cells / all cells over Authority, Methodology, Objectivity and Position, with a target of at least 90%; Date is computed, not judged, so it is left out of the headline and the target, and the figure with Date is given beside it, labelled;
  - Cohen's kappa per judged criterion, without Date; a criterion where both sessions used one category only has an undefined kappa, stated as such;
  - eligibility kappa over the derived decisions;
  - every differing cell is listed;
  - rows whose eligibility differs go to the user before deep study, or to adjudication by the user's decision. Adjudication records each row's cells and reasons.
- **Forced rows.** The source of every existing card and the topic's `forced_repos` per stratum are kept in the pool whatever their rank; they pass through stage 1 like any row and count once.
