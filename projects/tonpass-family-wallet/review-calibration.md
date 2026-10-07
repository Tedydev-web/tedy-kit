# Review calibration: tonpass Family Wallet

How this project's stack really works, so a review neither flags a deliberate pattern nor misses a risk that recurs here. It outranks `plugin/skills/review-pr/references/stack-checks.md`.

Source: the team's `pg-review-pr/references/project-rules-tonpass.md`, a read-only pass on 2026-07-19. Lines marked `[2026-10-07]` were re-read on `tonpass-wallet-fe` `origin/dev` that day; every other `path:line` is a `[docs-claim]` until re-read.

## Stack

- `tonpass-wallet-fe` is an Nx monorepo: apps `tonpass`, `1dollar` and `family` (Family Wallet) on `packages/core`; React 19, Vite, React Router 7. `[2026-10-07]`
- State is zustand with `persist` to `localStorage`. React Query and SWR are not installed, so a hand-written effect that guards stale results is the house pattern, not a defect. `[2026-10-07]`
- `bignumber.js`, `ethers`, `@ton/core` are installed; `@tonconnect/ui-react` is in `tonpass` and `1dollar`, not `family`. `[2026-10-07]`
- Telegram through raw `window.Telegram.WebApp`, not `@telegram-apps/sdk`. `[2026-10-07]`
- Backends (`tonpass-wallet-be`, `tonpass-wallet-admin-be`): NestJS 11 with Mongoose on MongoDB, RabbitMQ workers, Redis. User wallets are Web3Auth/tKey MPC and non-custodial; only pool and relayer wallets are signed on the server.

## Auth model

Users sign in with Telegram `initData`, sent from each app's `app/root.tsx` to the backend login (`[2026-10-07]`). There is no `ton_proof`, SIWE or EIP-712 for user auth, so their absence is not a finding. The `initData` path is the boundary: a change near it is checked for server-side HMAC verification, `auth_date` freshness, and throttling on the login route.

## Recurring risks

Pre-existing ones stay out of a PR's findings unless the PR touches them.

- A secret in the client bundle: `packages/core/src/lib/adapters/tron.adapter.ts:278` reads `VITE_APP_OKX_SECRET_KEY`. `[2026-10-07]`
- Recovery data in `localStorage`: `apps/1dollar/app/features/security/lib/recovery-vault.ts:13`. A new `persist` store is checked for keys, mnemonics or tokens in what it saves. `[2026-10-07]`
- Decimals per chain: each chain has its own adapter in `packages/core/src/lib/adapters/`, and a hardcoded `18` in one is wrong for another.
- Only one file uses `AbortController` (`packages/core/src/hooks/useWeb3Auth.ts`), so a slow balance or price response can overwrite newer state after fast navigation. `[2026-10-07]`
- Backend: money math with `Number()` or `parseFloat` on token amounts; a Mongoose unique index pointing at a field the schema does not declare; webhook and `*-test` or `*debug*` routes without a guard; `RolesGuard` failing open when `@Roles` is missing.

## Deliberate patterns

- The backend verifies `initData` on login and ignores `initDataUnsafe.user.id`.
- Metabase is reached through a backend proxy that holds the credential.
- Service-to-service handoff with a shared secret (`SharedServiceAuthGuard`, `timingSafeEqual`) is intended; check the compare and the rate limit, not the pattern.
- Transaction idempotency through a unique sparse index plus upsert is correct when the index points at a real field.
