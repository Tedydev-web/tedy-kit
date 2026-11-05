# Checkout, run question and verify (step 3)

The PR's code is untrusted. Any project script run in its checkout (tests, typecheck, lint, format) runs code from the PR with the user's credentials (gh, the tracker token, SSH keys) in reach, so nothing runs before the user says so for this head.

## Checkout

1. From the reviewed repo, before any read: `node <plugin>/scripts/draft-lint.mjs pin-sources <draft> --pr <n> --repo <owner/repo> --branch <repo path>:<baseRefName>` (`draft-format.md`, Pinned sources), with the reviewed repo's path in the map as `<repo path>`. It sets `refs/pr/<n>`; check it equals `headRefOid`. Its `pinned: <repo> origin/<baseRefName>@<sha>` line is the base sha: read the rule files at it (`source-access.md`, GitHub) and pass it to the reviewer lenses. The verify run below still uses the head's lint and TS config; the execution surface names them when they changed.
2. `git worktree add --detach <folder>/pr-<n> refs/pr/<n>` in the folder `git worktree list` already uses (`.claude/worktrees/` or `.worktrees/`). Never switch the main checkout's branch, and never `npm install` (or any other install) in the worktree: packages resolve from the main checkout's `node_modules`, so a new dependency fails instead of installing.

## Ask before running anything

Before any project script (typecheck, lint, test, format) runs in the worktree:

1. `node <plugin>/scripts/pr-execution-surface.mjs origin/<baseRefName> refs/pr/<n>` from the reviewed repo. It lists changed script lines, dependencies and lockfiles, executed config (with `tsconfig*.json` and tool config in `package.json`), changed files a script line names or an unchanged config or named script imports one level deep, changes under `node_modules/`, symlinks, script lines that download and run, and the count of changed test files. It is information, not a safety check: it shows only what the kit can see, and says what it does not check.
2. Quote its output, then one `AskUserQuestion`, header `run.header`, whose question names the PR, the full head sha (`headRefOid`, 40 characters) and says plainly:
   - running any project script (tests, typecheck, lint) executes code from this PR, with your credentials in reach;
   - the listed changes are only what the kit can see, not a complete list;
   - nothing is installed.

   Options, the recommended one first with ` (Recommended)` after its label:
   - `run.none`: nothing runs; read `gh pr checks <n>`. Recommended unless the review needs a local run.
   - `run.lint`: typecheck and lint only; tests are left to `gh pr checks <n>`.
   - `run.all`: typecheck, lint and tests; the description says how many changed test files run.

   A surface that lists nothing never makes a run the recommendation. Recommend `run.lint` or `run.all` only when a finding needs a local run to settle it, and say which finding.
3. Run only what the answer allows, in the worktree, applying the map's `verify_gotchas`. For `run.none`, a typed answer or a note, run nothing and write "verify not run: <reason>" in the findings with the `gh pr checks <n>` result; ask again only if the user asks for a run. Running PR code is never a local, reversible choice, so a timeout runs nothing.
4. The answer covers that head sha only. On a new head, recreate the worktree, print the surface again and ask again.

The hook after AskUserQuestion records an approving answer (`run.lint` or `run.all`, no note) for its head sha under `<state>/review-runs/`. The review-run gate refuses npm, pnpm, yarn, bun and npx in a review checkout whose head has no recorded approval. It does not know which option was picked: nothing but this step keeps a `run.lint` answer to typecheck and lint.

In a background session (`--bg`) the question would wait for the user. Write it as a draft under `plans/drafts/` (`shared/decision-points.md`), put "verify not run: awaiting the run question" in the findings, and go on with steps 4 to 9.

## Clean-up

Remove the worktree and `refs/pr/<n>` when the review is posted, held or dropped.
