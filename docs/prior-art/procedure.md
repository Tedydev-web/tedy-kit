# Studying prior art for a kit change

Every ADR from 0009 on has a `## Prior art` section, and every `feat`/`fix` commit carries an `ADR:` or `Prior-art:` trailer. `plugin/tests/adr-prior-art.test.mjs` and `plugin/tests/commit-prior-art.test.mjs` check the shape; `plugin/scripts/prior-art-verify.mjs <file>` checks pinned lines and issue states against GitHub; depth is checked by review and by the user's spot-check.

## Steps

1. **Discover.** GitHub search and topics, awesome lists, plugin marketplaces; X (`twitter search`), Reddit (`rdt search`), YouTube (`yt-dlp` transcripts), Facebook (`opencli`); arXiv and Semantic Scholar (the academic channel). Try the channel itself; a doctor report that calls a channel unavailable is not evidence. Each topic (a role, a skill, a mechanism) has one config, `docs/prior-art/topics/<topic>.json`: registry, id prefix, frame label and steps, problems, terms, sweep name, `pilot_rows` (default 20), the `sessions` (A: a Claude model; B: one model on another family, run through `agy`, with a Claude `fallback` used when `agy` is not on PATH and optional `pilot_also` models that screen the pilot for information), and per stratum (config, product, local) the channels, the stop row and the forced repositories. The stop row stays `null` until the toolchain writes it. A topic too wide for one 60-row bound is split into `facets`, each with:
     - its own sweep name, distinct from every other topic and facet sweep;
     - non-empty problems and terms, a subset of the topic's;
     - per-stratum stop row and forced repositories, which are never inherited from the topic (unset means `null` and none).

     Every topic problem sits in exactly one facet. Discovery runs once for the whole topic, whose terms cover every facet. Each discovery state stores the digest of the terms it ran with and refuses to resume under other terms; a change of terms means discovering again in a new working folder. From the ranking on, every step runs per facet with `--topic <topic>:<facet>` in the facet's own working folder:
     - `link-discovery.py --topic <topic>:<facet> --work <facet dir> --discovery <topic dir>` first. It refuses a discovery state that lacks the terms digest or whose digest differs from the topic's, and a facet folder that holds its own `config-state.json` or `product-state.json`. It stores the topic config's path and terms digest in `discovery.json`;
     - the facet steps then read `config-state.json`, `product-state.json`, `config-pool.json`, `product-pool.json` and `cache/` (trees, asset SHAs, READMEs, `meta.json`, `canonical.json`) from the topic folder whenever the facet folder lacks them, and nothing else. Every such read checks the topic config's terms against the digest in `discovery.json` and refuses on a mismatch, so a change of the topic's terms means discovering and linking again;
     - the topic folder is read only: everything a facet step writes, its own pools, snowball state and cache entries included, lands in the facet folder and takes precedence there.

     The stop row is written into the facet. A facet's sweep is named `<yymmdd>-<topic>-<facet>` (for example `261020-canon-permissions`), and its record is `docs/prior-art/sweeps/<facet sweep>.md` with its data in the folder of the same name. The facet's `meta.json` names `<topic>:<facet>` as its role, so its record is the latest of that role, carries the inventory digest and surface checks, and is refused when the role differs from the facet that names its sweep. The steps are the scripts in `plugin/evals/probes/study/`, each run with `--topic <topic>` and a working folder `--work <dir>` outside the repository:
   - discovery and order: `discover-config-pool.py`, `discover-product-pool.py`, `discover-local-inventory.py` (tags only, never copied text), `resolve-pool.py`, `fetch-repo-trees.py`, `rank-config-pool.py`, `snowball-aggregators.py`, `snowball-above-cut.py` (records the cut it used in `snowball-cut.json`), `merge-snowball-order.py` (adds those rows to the config screening order as rows 1001 and on, keeping the ranks of rows merged before), `rank-product-pool.py`, `export-screening-order.py`;
   - standards: `extract-qgs-candidates.py --stratum <s>` and `qgs-recall.py --stratum <s>`, one standard per stratum. Once the adjudicated list in `<s>-qgs-adjudicated.json` is final, run `qgs-recall.py --stratum <s> --write`. It resolves renamed repositories, counts members that resolve to one repository once, and stores that resolved standard in the file. The sweep record counts recall at the cut only from it, and refuses a file whose final list changed after the write;
   - screening: `fetch-screening-inputs.py` (pinned commit, README, listing, up to two asset files and the evidence the anchors read; both sessions score these without tools; run it again to retry transient errors; `--mark-permanent <rank>` only when a check by hand found the repository or commit gone), `run-screening-session.py --pilot` for A and B, one model per run (`--model` for a `pilot_also` model), `freeze-protocol.py` (pins the criteria and packet digests and both sessions; `--amendment` states what changed when the packet or the criteria differ from the pilot's), `run-screening-session.py` for A and B block by block, each run isolated as the screening rules state (claude: no tools, settings, MCP servers, slash commands or persistence, one turn, `--bare` only when ANTHROPIC_API_KEY is set; agy: stream-json, slash commands off, any tool step refused, its MCP, hooks and settings threat recorded) and refused when the protocol differs from the freeze, `drop-screening-block.py` to redo one scored block (drop it from both sessions to fetch its ranks again), `compare-screening-sessions.py --folder <work> --write-stop`, then `snowball-above-cut.py` and `merge-snowball-order.py` again with the written stop row, and `fetch-screening-inputs.py` and both sessions for the new rows from 1001, `qgs-recall.py --stratum <s>` for recall at the cut, and `draw-calibration-sample.py` after the freeze for the user's 10 blind rows. The rater reads only `calibration-sample.json` and `calibration-inputs.md`: the rater does not run `compare-screening-sessions.py`, read its output, the session files or the sweep record before every row is rated. Canon packets never mention tools, commands or files a session could open; a session scores only the inputs in its prompt;
   - record: `export-sweep-data.py`, `pick-deep-study.py` and `sweep-record.py`.

   Under `quality-criteria-v4.md` (sweeps from 2026-10-20 on) a topic is screened by facets, clusters of registry problems, as one topic-level sweep with one record, `docs/prior-art/sweeps/<topic sweep>.md`. A topic that is not split declares one facet holding every problem. The topic config also names the judge roster: `qgs_judges` A and B, the `reader`, and `cross_family`, the model of the partial QGS judgments and the audit; `strata.product.channels.config_pool: true` adds the product channel drawn from the config pool. The steps, in order, all with `--topic <topic>` and the topic's working folder `--work <dir>` unless a facet is named:
   1. discovery for the whole topic as above, `discover-product-pool.py` including its `config-pool` channel after the config pool is resolved;
   2. per facet, in `<dir>/facets/<facet>/`: `link-discovery.py`, `rank-config-pool.py`, `snowball-aggregators.py`, `snowball-above-cut.py`, `merge-snowball-order.py`, `rank-product-pool.py` and `export-screening-order.py`, each with `--topic <topic>:<facet>`. A facet's order counts only its own terms and the code-search queries holding one of them, and the ranked file lists them;
   3. `merge-facet-orders.py`: one topic order per stratum, one row per repository with its rank in every facet; numbers already given are kept;
   4. `extract-qgs-candidates.py --stratum <s>` with the topic, never a facet;
   5. `fetch-screening-inputs.py --stratum <s>` (`--through` is the depth in any facet), then `draw-calibration-set.py --criteria docs/prior-art/quality-criteria-v4.md`: 60 rows per stratum and the page `calibration.html`. The user opens the page in a browser, labels every row, saves the labels with the page's download button and gives the file to `import-calibration-labels.py --labels <file>`. The page shows only the inputs and the anchors; `calibration-draw.json`, which says how each row was drawn, stays closed until the labels are imported. This step may run before the pilot;
   6. the pilot block and `freeze-protocol.py` as above, pinning `quality-criteria-v4.md`;
   7. `run-judge.py --stratum <s> --judge <judge> --set calibration --run 1`, then `--run 2`, for `screening-A`, `screening-B`, `qgs-A`, `qgs-B` and `reader`, with `screening-packet-<s>.md` and `qgs-packet-<s>.md` in the folder; a run whose prompt is too long for one block is split with `--rows <first>-<last>` (positions from 1 in the set, the candidates, the reader's queue or the audit sample), and so are steps 8 and 10; `validate-judges.py` reports each run. A judge that does not reach sensitivity 0.90 and kappa 0.60 in both runs is replaced in the topic config and runs again;
   8. `fetch-screening-inputs.py --stratum <s> --set qgs`, `run-judge.py --judge qgs-A --set qgs` and `--judge qgs-B --set qgs` (refused before the judge qualified, or under another packet), the cross-family judgments kept as `<s>-qgs-cross-<model>.jsonl`, `run-judge.py --judge reader --set qgs` for the queue, `qgs-standard.py --stratum <s> --write`, then `qgs-recall.py --stratum <s> --write`;
   9. `facet-depth.py --stratum <s>` lists the rows within each facet's depth; fetch and screen them with `run-screening-session.py`, which refuses until both screening judges qualified; `facet-depth.py --stratum <s> --write-stop` writes every facet's stop row once both sessions screened them. For the config stratum, rerun each facet's snowball with its stop row, `merge-facet-orders.py` again, and fetch and screen the new rows;
   10. `draw-audit-sample.py`, then `run-judge.py --judge audit --set audit --stratum <s>` when the cross-family model is reachable; until then the record names the pending audit as a threat;
   11. `export-sweep-data.py` (it never exports fetched text) and `sweep-record.py`.
2. **Select** sources from a sweep record, never from memory. A sweep lives in `docs/prior-art/sweeps/<sweep>.md`, named `<yymmdd>-<topic>` for a topic and `<yymmdd>-<topic>-<facet>` for a facet, with its data in the folder of the same name. It is screened by two blind sessions under the pinned version of `quality-criteria-v<n>.md`; sweeps from 2026-10-19 pin version 3, whose screening rules add the pilot block, the freeze, shared inputs, kappa, recall at the cut and calibration, and sweeps from 2026-10-20 on pin version 4, which adds facets as problem clusters, the topic-level standard with problem labels, one screen per repository, pooled recall with its interval driving the depth, the config-pool product channel, the calibration set and judge validation. It is regenerated with `python3 plugin/evals/probes/prior-art-sweep-record.py . <sweep>`, which finds the topic config naming that sweep, or with `python3 plugin/evals/probes/study/sweep-record.py --topic <topic>`. Its rows marked `study` are the deep-study picks: at most three per problem, chosen from the eligible rows with written reasons, and each source that already has a card counts against the budget. `plugin/tests/sweep-record.test.mjs` checks that:
   - the record pins the criteria hash;
   - every stratum has a stop line;
   - every row has a decision and a reason;
   - the latest record per role lists every Claude Code surface of the inventory it pins;
   - every card is the source of a `study` row;
   - every topic config's registry fills each knowledge area × step cell with its own problem ids or `none for <topic>:` and a reason;
   - every record except the grandfathered `261018-dev` (screened before these rules; `plugin/lib/sweep-method-evidence.mjs` states why) carries the protocol freeze, whose criteria and packet digests still match; each session's model, effort and CLI version and each block's packet, criteria and input sha256 and date, with A and B scoring identical inputs; both session files of every screened stratum; agreement on rows after the pilot block, led by the figure without the computed Date, with kappa per judged criterion and eligibility kappa; Chapman only as a lower bound on the capture-recapture line; recall at the cut for the config and product strata; a stop line equal to the topic config's toolchain-written stop row; the user's calibration agreement or an "LLM-only screening" threat; a "same model family" threat when sessions A and B share one; and an "academic papers logged, not screened" threat when the academic channel ran. A record pinning version 4 or later instead of recall at the cut, the topic stop row and the calibration sample needs: each facet's stop row equal to the topic config's; pooled recall per stratum with its 95% interval, and a threat when it misses 0.80; a recall line per facet; the facet overlap line; each facet's counted code queries; the config-pool channel count when the topic draws it; a 60-row calibration set per stratum with the user's complete labels; for every judge of the roster a qualifying validation line and two runs on the set's inputs; the cross-family agreement, and the audit result or a pending-audit threat; the reader's family threat when it shares the QGS judges' family; and the upper-estimate threat. A record pinning version 3 or earlier fails when its topic holds a facet of more than one problem. The 261018-dev exemption holds only while that record's sha256 is unchanged, and every committed record must regenerate byte-identically. A stratum without channels (the local inventory) is tag-only: the record states it was not screened by two sessions, and the freeze, input fetching and stop derivation leave it out.
3. **Dissect within the budget.** Shallow clone at a tag or commit into `/tmp`; read at most 8 files (3 per skill in a multi-skill repo); at most 10 closed issues or merged PRs, sorted by reactions or comments; the changelog. Delete the clone after.
4. **Write lessons.** For each pattern worth learning: the pinned link with a short verbatim excerpt, what broke for its users and how it was fixed, the kit file it would touch (`plugin/skills/dev/SKILL.md:<n>`), gap or overlap, cost to adopt.
5. **Compare and propose.** Name the kit file and line each lesson changes; propose the strongest form (gate or test, then skill line, then rule).
6. **Record.** The ADR's `## Prior art` section cites the sources; each GitHub source gets a card in this folder.

## Section format

```
## Prior art

- <name> (<license>, studied <YYYY-MM-DD>, via <github|x|reddit|youtube|facebook|web|local>)
  - card: <slug>                      (GitHub sources only, first sub-bullet)
  - <evidence> "<short verbatim excerpt>"
  - Lesson: <one line>
  - Taken: <where> | Not taken: <why>
```

Evidence is one of: `https://github.com/<o>/<r>/blob/<40-hex sha>/<path>#L<n>` (or `#L<n>-L<m>`, optionally `?plain=1` before it); `https://github.com/<o>/<r>/issues/<n>` or `/pull/<n>`; a web or social URL (YouTube with `t=`); a local `path:line`; a command with its version in backticks and parentheses. Paid installed sources use the license `proprietary (installed)`, point to `path:line` and carry no quoted text.

Without a social source, add `no social prior art: <date> <channel>: "<query>"; <channel>: "<query>"` naming two social channels actually searched. When nothing at all applies, the section holds only `no prior art: <date> <channel>: "<query>"; <channel>: "<query>"`, two channels, one of them social.

Social quotes stay to one or two sentences with author and date. MIT and Apache sources may be quoted at line level with attribution; GPL, AGPL and source-available code is studied, never copied.

## Card template

`docs/prior-art/<slug>.md`, one per studied GitHub source:

```
---
name: <owner/repo>
pinned: https://github.com/<owner>/<repo>/tree/<40-hex sha>
license: <SPDX id>
studied: <YYYY-MM-DD>
channel: github
---

# <owner/repo>

## Evidence
- <pinned blob link> "<excerpt>"

## Issues and changelog
- <issue or PR link> "<excerpt>"
  - Broke: <what>. Fixed: <how>.

## Lessons
- <lesson>: touches <kit file:line>; gap | overlap; cost.
```

Every evidence line holds only the link and its quoted excerpt; notes go on the next sub-bullet. `prior-art-verify.mjs` reports any other line holding a GitHub blob, issue or PR link as `unparsed`. Find the ADRs that cite a card with `git grep -n 'card: <slug>'`.

## Commit trailers

- `ADR: NNNN` naming an existing ADR; or
- `Prior-art: <card slug or https URL>`; or
- `Prior-art: none (<channel>: "<query>"; <channel>: "<query>")`, two channels searched; or
- for `fix` only, `Prior-art: n/a (<reason>)` when outside work cannot apply.

Run `npm test` before every push: a pushed commit without its trailer can only be fixed by a force-push.
