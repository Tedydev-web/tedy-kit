# Checkout, run question and verify (step 3)

The PR's code is untrusted. Its tests, and any script line or config it changes, run with the user's credentials (gh, the tracker token, SSH keys) in reach, so nothing of it runs before the user says so for this head.

## Checkout

1. From the reviewed repo, before any read: `node <plugin>/scripts/draft-lint.mjs pin-sources <draft> --pr <n> --repo <owner/repo>` (`draft-format.md`, Pinned sources). It sets `refs/pr/<n>`; check it equals `headRefOid`.
2. `git worktree add --detach <folder>/pr-<n> refs/pr/<n>` in the folder `git worktree list` already uses (`.claude/worktrees/` or `.worktrees/`). Never switch the main checkout's branch, and never `npm install` (or any other install) in the worktree: packages resolve from the main checkout's `node_modules`, so a new dependency fails instead of installing.

## Ask before running anything

Before any project script (typecheck, lint, test, format) runs in the worktree:

1. `node <plugin>/scripts/pr-execution-surface.mjs origin/<baseRefName> refs/pr/<n>` from the reviewed repo. It lists changed script lines, dependencies and lockfiles, executed config, files a script line names, script lines that download and run, the count of changed test files, and whether the typecheck/lint surface changed.
2. Quote its output, then one `AskUserQuestion`, header `run.header`, whose question names the PR, the full head sha (`headRefOid`, 40 characters) and says plainly:
   - tests run all of this PR's code, whatever it changed, with your credentials in reach;
   - typecheck and lint through an unchanged script line and unchanged config run no file of this PR; when the surface changed, they run what changed;
   - nothing is installed.

   Options, the recommended one first with ` (Recommended)` after its label:
   - `run.lint`: typecheck and lint only; tests are left to `gh pr checks <n>`. Recommended while the typecheck/lint surface is unchanged.
   - `run.all`: typecheck, lint and tests; the description says how many changed test files run.
   - `run.none`: nothing runs; read `gh pr checks <n>`. Recommended when the typecheck/lint surface changed.
3. Run only what the answer allows, in the worktree, applying the map's `verify_gotchas`. For `run.none`, a typed answer or a note, run nothing and write "verify not run: <reason>" in the findings with the `gh pr checks <n>` result; ask again only if the user asks for a run. Running PR code is never a local, reversible choice, so a timeout runs nothing.
4. The answer covers that head sha only. On a new head, recreate the worktree, print the surface again and ask again.

The hook after AskUserQuestion records an approving answer (`run.lint` or `run.all`, no note) for its head sha under `<state>/review-runs/`. Nothing but this step keeps a `run.lint` answer to typecheck and lint.

In a background session (`--bg`) the question would wait for the user. Write it as a draft under `plans/drafts/` (`shared/decision-points.md`), put "verify not run: awaiting the run question" in the findings, and go on with steps 4 to 9.

## Clean-up

Remove the worktree and `refs/pr/<n>` when the review is posted, held or dropped.
