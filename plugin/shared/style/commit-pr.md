# Commit and pull request style

Default samples. A profile copy at `<profile>/style/commit-pr.md` replaces this file.

## Commit

- Conventional commit subject in the imperative, under 72 characters: `fix(cart): keep the limit pop-up after an upgrade`.
- The body says why: the behaviour before, the cause, the behaviour now, and any backend or PRD fact the change relies on, with its source.
- No code comments carry this reasoning; the commit message does.

## Pull request

- Title is the commit subject of the main change. Opened as a draft; the user marks it ready.
- The body states the problem, the cause and what changed, with PRD codes, and carries `OP#<id>` for the tracker item it does, so the tracker shows the PR and `merged-sweep.mjs` can move the item after merge.
- In a project with a tracker there is no PR without a work package: hand the task to the PM session first. git-gate denies `gh pr create` without `OP#<id>` in the body.
- One tracker task, one branch, one PR; the reviewer merges.
- Open a PR or push a new branch only when the user asks for it in that request. A request for a report means report only.

## Samples

### 1. Fix that relies on a backend state

```text
fix(cart): show the limit pop-up when the backend refuses a cart

The app showed a generic error when the backend refused a fourth cart on
the Free plan, for example after a plan change on another device. The
backend answers 409 with code CART_LIMIT in that case (orders service,
cart controller). The app now maps that code to the same pop-up the
New cart button opens (PRD EPIC 05 UC_CT_02 EF3).
```

### 2. Short feature

```text
feat(settings): translate the avatar error toast

A failed avatar pick showed the raw upload error. It now shows the
registry message for invalid images in every supported language
(PRD UC_ST_16 BR6).
```

## Avoid

| Pattern | Why |
|---|---|
| "Update file", "fix bug" subjects | Say what behaviour changed |
| Explaining the change in code comments | The why belongs in the commit message |
| Opening a ready PR | The user decides when it is ready |
