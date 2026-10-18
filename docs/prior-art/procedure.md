# Studying prior art for a kit change

Every ADR from 0009 on has a `## Prior art` section, and every `feat`/`fix` commit carries an `ADR:` or `Prior-art:` trailer. `plugin/tests/adr-prior-art.test.mjs` and `plugin/tests/commit-prior-art.test.mjs` check the shape; `plugin/scripts/prior-art-verify.mjs <file>` checks pinned lines and issue states against GitHub; depth is checked by review and by the user's spot-check.

## Steps

1. **Discover.** GitHub search and topics, awesome lists, plugin marketplaces; X (`twitter search`), Reddit (`rdt search`), YouTube (`yt-dlp` transcripts), Facebook (`opencli`). Try the channel itself; a doctor report that calls a channel unavailable is not evidence.
2. **Select** at most three sources to study deeply: overlap with the kit role, recent commits, closed issues with real discussion. List the runners-up and why they lost.
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
- <issue or PR link> "<excerpt>": what broke, how it was fixed.

## Lessons
- <lesson>: touches <kit file:line>; gap | overlap; cost.
```

Find the ADRs that cite a card with `git grep -n 'card: <slug>'`.

## Commit trailers

- `ADR: NNNN` naming an existing ADR; or
- `Prior-art: <card slug or https URL>`; or
- `Prior-art: none (<channel>: "<query>"; <channel>: "<query>")`, two channels searched; or
- for `fix` only, `Prior-art: n/a (<reason>)` when outside work cannot apply.

Run `npm test` before every push: a pushed commit without its trailer can only be fixed by a force-push.
