# Reconcile flow

How to cross-check one scope across the PRD, Figma, the backend and contract, the frontend and the PM demo, and raise every mismatch. Read `<plugin>/shared/source-access.md` for how to read each source and `<plugin>/shared/decision-points.md` for questions. Reconcile only reads; it changes no code, map aside.

## Truth ladder

- In form (fields, endpoints, states, errors), the frontend follows the backend and contract.
- In behaviour and copy, the backend and contract follow the PRD and Figma.
- The map's `truth_overrides` adjust this per project; cite the override a conclusion relies on.
- PRD against Figma is never settled by guessing which is newer. Put both sides in the table, quoted, with any override that applies, and raise it; the user picks.

## Evidence labels

Evidence and conclusion words are label keys; write them in the chat language as `node <plugin>/scripts/labels.mjs` prints them.

| Label | Meaning | Reviewer agent label |
|---|---|---|
| `evidence.seen` | Read this run; the cell cites a re-checkable `path:line@branch`, a PRD locator from `prd-section.mjs find`, or a Figma node and label | CONFIRMED |
| `evidence.derived` | Follows from lines read this run through a chain the cell states | PLAUSIBLE |
| `evidence.guess` | Not checked | none; goes only to the raise list, never into a conclusion |

A statement taken from prose (README, AGENTS.md, a PR description, a memory note) is a `[docs-claim]` until code confirms it. When code contradicts it, code wins on behaviour and the contradiction is a row of its own.

## Steps

1. **Map.** `node <plugin>/scripts/project-map.mjs resolve` and read the map. A field the scope needs and the map lacks (a tab for the epic, a Figma node) goes through "Filling a gap mid-task" in `setup-flow.md`. Links and ids the map already holds are never asked again.
2. **Items.** Turn the scope (an epic, a use case, a rule in words, or a PR) into items: one behaviour each, with its PRD locator. Find the locators with `prd-section.mjs index` and `find`. Write the item list into the report before reading code.
3. **Read, per item and per source.**
   - PRD: the `find` output for the locator, quoted as printed.
   - Figma: the epic's node from the map; the frame and the exact copy on it.
   - Backend and contract: `git -C <repo> fetch -q origin`, then `git grep` and `git show origin/<branch>:<path>`; the writer that saves the field, not only its schema.
   - Frontend: the integration branch, or the current checkout when the user names one; say which.
   - Demo: when the map lists one.
   - A source that does not exist or cannot be read is written down as skipped, with the reason.
4. **Compare** along the truth ladder, item by item.
5. **Table.** One row per item and side that disagrees, in this shape:

   | Item | PRD (locator: quote) | Figma (frame link: label or copy) | Backend / contract (`path:line@branch`) | Frontend (`path:line`) | Work package (`#id status`, or `wp.none`) | Conclusion | Label | Owner of the fix |
   |---|---|---|---|---|---|---|---|---|

   Conclusion is `match.ok`, `match.diff`, or `match.nosource`. Owner is the PM, the designer, the backend team, the blockchain team or the frontend. When the map has a tracker, the work package column names the package that carries the item, found with `node <plugin>/scripts/openproject.mjs get /api/v3/work_packages/<id>` for the ids the task or PR names, otherwise by subject or use-case id among the project's packages; a package whose text disagrees with the PRD or Figma is itself a `match.diff` row with the PM as owner.
6. **Raise list.** Every `match.diff` without a documented reason and every `evidence.guess` row, each with both sides quoted and the owner named; a row owned by the PM names the work package to fix or says a new one is needed. Name the side the truth ladder favours when it does; when it does not (PRD against Figma), say so.
7. **Independent lens.** When the scope has more than 8 items, spawn the `tedy:reviewer` agent with lens `spec` on the frontend repository, wait for its completion notice, and add its findings to the table and the raise list before writing the report. One rule or one use case needs no lens.
8. **Report.** `<paths[0]>/plans/reports/reconcile-<yymmdd-hhmm>-<slug>.md`: scope, item list, coverage (how many of the requirements in the scoped PRD sections, counting steps, BRs, AFs, EFs and UI rules, have a row or a stated reason to skip), sources read and skipped, the table, the raise list. Quote the coverage, the table and the raise list in the reply.

## Done

Every item has a conclusion from every source that exists, every `evidence.seen` cell can be re-checked from its citation, and every unexplained `match.diff` is in the raise list with an owner.

Drafting Doc or Figma comments and tracker tasks from the raise list belongs to `/tedy:pm`; building the frontend side of a fix belongs to `/tedy:dev`.
