# Commit and pull request style

How the user's commits and PRs read. Measured on their 39 non-merge commits in `tonpass-wallet-fe` from 2026-10-01 to 2026-10-06 and their 12 latest PRs.

## Commit

- Conventional subject in English: `<type>(<scope>): <what the change does, as behaviour>`, lower case after the colon, no trailing period. Types seen: `fix` 29, `feat` 6, `refactor` 1 (plus `fix(core)` 3). Scope is the app or package: `family`, `core`.
- Subject median 67 characters, longest 92. It names the behaviour a user or teammate notices ("keep a member busy until their change is applied"), not the code edited.
- Body: prose paragraphs wrapped near 72 columns, no bullet lists. It says what was wrong, why, and what happens now; cites PRD codes (`UC_SW_09`, `UC_MB_01 BR3`), backend facts it relies on, and assumptions still open ("Open Q10 is still open; this is the assumed answer").
- One concern per commit. The tree is clean after the commit (`git status` empty).
- No AI attribution and no co-author trailer.

## Pull request

- PR into the integration branch (`dev`), opened as a draft (the 6 still-open PRs are drafts; merged ones were marked ready before merge), title equal to the commit subject. The body is the single line `OP#<id>` when the PR does a tracker item, so OpenProject shows it on the work package and `merged-sweep.mjs` can move the item after merge (user decision 2026-10-09); otherwise empty.
- One tracker task, one branch, one PR; the reviewer merges.
- Open a PR or push a new branch only when the user says so in that request. "Noted lại cho tôi biết" means report only: on 2026-10-06 PRs #708–#710 were opened without that and had to be withdrawn.

## Samples (verbatim)

### 1. fix with a backend state it relies on (`b5d3db12`)

```text
fix(family): keep a member busy until their change is applied, and refresh after a refusal

The backend keeps a role change or removal open until it is DONE, so a
change that left the vote but is still being applied (EXECUTING) is still
refused as already waiting. The queue is now read with PENDING and
EXECUTING, and both count as busy.

The queue is read again after every proposal, including one refused as
already waiting, so the busy line appears in that case too.
```

### 2. larger change citing UC codes and an open question (`b84573dc`)

```text
fix(family): leave a shared wallet, pick its language, and hold the handover

UC_SW_09: Leave this wallet now opens its sheet. A member confirms with
Leave {space}, the app calls POST :spaceId/leave, shows "You left {space}"
(UC_SW_10 #13), drops the wallet and opens the next active shared wallet,
or the personal wallet when none is left (Open Q10 is still open; this is
the assumed answer). A failure keeps the membership and shows a retry line
in the sheet. The Owner gets the AF1 sheet instead and never reaches the
leave call, which the backend refuses for an Owner.

Hand over ownership stays visible but is held with Coming soon: the
backend ships a one-to-one offer, while UC_SW_08 is a group vote, so
nothing is sent until the backend matches the vote. The Owner's AF1 button
is held the same way.

Language reads the account locale and opens the same sheet as My Wallet
(UC_SW_07 BR5). The tab layout now passes the app's outlet context to its
screens, which was undefined below it.
```

### 3. short fix citing backend and PRD (`fa8e765e`)

```text
fix(family): let an Admin change the shared wallet asset list

The asset list (add a token, hide one, add a custom token) was Owner-only,
while the backend accepts the Owner or an Admin (space-asset.service) and
the EPIC 08 role matrix and UC_FW_01 BR14 grant both. The other BR14
paragraph that says Owner only is stale; the PM is asked to drop it.
```

### 4. short feature (`271e4d2a`)

```text
feat(family): put the round's opening time on the signing prompt

The activity row anatomy opens with the time. The prompt takes it from the
earliest validAfter signed into the round's requests, the start of the
window every member signs.
```

## Avoid

| Pattern | Why (evidence) |
|---|---|
| Subjects about code ("update hook", "refactor store") | Every October subject states behaviour |
| Bullet-list bodies or a body that repeats the diff | The bodies explain the why the diff cannot show |
| `gh pr create` or a pushed branch the user did not ask for | #708–#710, 2026-10-06 |
| Committing with unstaged leftovers | Unstaged sed edits broke `dev` through #673 |
