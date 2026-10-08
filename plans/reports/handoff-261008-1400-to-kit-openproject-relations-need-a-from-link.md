---
to: the session that builds tedy-kit
from: PM - Family Wallet
status: done
updated: 2026-10-08T06:45:00Z
created: 2026-10-08T07:00:00Z
title: openproject relations need a from link
---

## What

`openproject.mjs apply` fails to create every relation on task.toncorp.io with HTTP 500: "An internal error has occurred. undefined method `project' for nil:NilClass".

The cause is the relation POST at `plugin/scripts/openproject.mjs:118`. It sends `{ type, _links: { to } }` with no `_links.from`.

Evidence from 2026-10-08 13:50, project 183, creating #21313/#21314/#21315:
- All 5 relations from `apply` returned 500.
- The same body sent directly also returned 500.
- After adding `_links: { from: { href: "/api/v3/work_packages/<saved.id>" }, to: … }`, the POST returned 201. Those are relations 903–907.

## Ask

- Add the `from` link to the relation POST.
- Make `apply` count a failed relation as a failure instead of logging it and still printing `verified N/N`.
- Add a test.

The PM session already added the 5 relations by hand. Nothing on the tracker needs fixing.

## Decided by anh Tedy

2026-10-08: hand the fix to the session that builds tedy-kit. The PM session does not edit kit code.

## Sources

- PM ledger: `/home/tedydev/Documents/workspace/tonpass/plans/reports/pm-261008-0945-prd-figma-check.md` (entry 13:50).
