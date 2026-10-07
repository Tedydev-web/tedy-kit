# Stack checks

What to look for first in a diff on the stacks the user's projects run: React and Telegram Mini Apps, NestJS, and TON or other on-chain code. Condensed from the team's `pg-review-pr` stack packs; the full tables live in `~/.agents/skills/pg-review-pr/references/stack-*.md`.

The repository's own patterns decide. A library the repository does not install is never a finding, and a pattern its sibling files already use is the baseline, not a defect. A project's `review-calibration.md` (next to its map) outranks this file.

## Pre-pass on the added lines

Run these on `gh pr diff <n>` before the full read; each hit is a lead to verify, not a finding yet.

- `console.log`, `debugger`, `<<<<<<<` conflict markers, or a block of commented-out code.
- A secret-shaped value: `VITE_*SECRET*`, `*PASSPHRASE*`, `*PRIVATE_KEY*`, a mnemonic, a bearer token. Quote the variable name, never the value.
- `package.json` or a lockfile changed: a new dependency doing what an installed one or a few lines already do.
- A comment added to source (working-style rule 10).

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
