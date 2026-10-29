# Stack checks

What to look for first in a diff on the stacks the user's projects run: React and Telegram Mini Apps, NestJS, and TON or other on-chain code. Condensed from the team's `pg-review-pr` stack packs; the full tables live in `~/.agents/skills/pg-review-pr/references/stack-*.md`.

The repository's own patterns decide. A library the repository does not install is never a finding, and a pattern its sibling files already use is the baseline, not a defect. A project's `review-calibration.md` (next to its map) outranks this file.

## Hand-written lines

The 400-line threshold for independent lenses (SKILL step 6) counts hand-written lines only: lockfiles, generated code, snapshots, locale JSON and assets do not count.

## Pre-pass on the added lines

Run these on `gh pr diff <n>` before the full read; each hit is a lead to verify, not a finding yet.

- `console.log`, `debugger`, `<<<<<<<` conflict markers, or a block of commented-out code.
- A secret-shaped value: `VITE_*SECRET*`, `*PASSPHRASE*`, `*PRIVATE_KEY*`, a mnemonic, a bearer token. Quote the variable name, never the value.
- `package.json` or a lockfile changed: a new dependency doing what an installed one or a few lines already do.
- A comment added to source, when the profile config turns on `gates.noComments`.

## Prior work and need

Run both once per change, before the full read. A hit goes into the findings report with its evidence.

- **Prior work.** Search for the same outcome outside this change: `gh pr list --state all --search "<two or three terms from the title, branch and added symbols>" --json number,title,state,mergedAt,headRefName --limit 20`, `git log origin/<integration branch> --oneline -20 --grep "<term>"`, and `git grep` on the integration branch for the routes, keys, hooks and components the change adds. Existing code or a merged PR that already does what this change adds is a finding: two implementations of one rule drift apart. An open PR on the same outcome is a finding unless this change says it replaces it. Leave out the change under review.
- **Need.** Every behaviour the change adds traces to a PRD rule, a tracker task or a reported bug. A behaviour none of them asks for (a setting nobody requested, an abstraction with one caller, a feature outside the task) is a finding that names what was added and that no source asks for it. Whether such a behaviour is wanted is the PM's call: it goes to the user as an open question in the findings report, never as a comment telling the author to remove it.

## React and Telegram Mini Apps

- `initDataUnsafe` used for an authorization decision instead of the server-verified `initData`.
- A bot token, API secret or passphrase read through a `VITE_` variable, so it ships in the public bundle.
- A payment or Stars success trusted on the client without a server check.
- `dangerouslySetInnerHTML` or `href={value}` fed from user or API data.
- An effect whose fetch can resolve after its inputs changed and overwrite newer state (missing cleanup flag or abort), or an effect with missing dependencies.
- A failed request that shows the same screen as an empty result or a loading state.

## NestJS

- A new route without the guard its siblings use, or an authenticated route that never checks the caller owns the record (IDOR).
- `ValidationPipe` without `whitelist` and `forbidNonWhitelisted`, so extra body fields reach the model.
- An error response that leaks a stack trace, query or internal path.
- Several writes that must succeed together without a transaction.
- A promise neither awaited nor caught.
- A request-scoped provider injected into a singleton.

## On-chain and money

- A token amount or balance computed with `Number` or `parseFloat`; TON amounts use `toNano` or `BigInt`, display rounding aside.
- Decimals hardcoded for one chain inside code shared by several; check every adapter the change touches, not one.
- A signature recovered but never compared with the expected signer, or a signed message without nonce and expiry.
- A deposit credited before enough confirmations, or credited without an idempotency key on the transaction hash.
- A private key or mnemonic written to code, logs, `localStorage` or a persisted store.

## Merged logic is the baseline

Verify intent before flagging behaviour that is already merged: `git log -L` or `git blame`, the PRD, and the commit that introduced it. A PR that silently changes merged business logic is a finding. Merged logic the PR did not touch is out of scope, except a serious security, money or data-loss risk, which is raised as a question for its owner.

## Duplicated structure in touched files

- Two services, hooks or stores with overlapping jobs where only one is on the live path; the other drifts.
- A provider registered in a module that nothing injects.
- Two schemas or types for one concept with most fields in common.

## Not findings

Leave these out of the findings file: what predates the PR, what a linter already catches, a `TODO` the author left, and Figma-identical placeholder data in a UI-only PR.
