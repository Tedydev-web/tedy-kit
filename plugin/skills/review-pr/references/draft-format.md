# Line-comment draft format

File: `plans/drafts/review-<yymmdd-hhmm>-pr<n>-line-comments.md` in the reviewed repo, or in the map's `paths[0]` when the map marks that repo `readonly`, so `/tedy:pending` lists every draft and nothing is written to a readonly repo.

```text
# PR #<n>: comment line by line (head <sha8>)

## 1. `<full/path/from/repo/root.tsx>:<line>`

<one sentence about the current state, in the pr_review language>

PRD EPIC <nn> · <UC_XX_nn> <locator>:
> <PRD text copied from prd-section output>

---
```

A project without a PRD cites a rule from the map's `prd.files` (an ADR or an architecture doc) in a `SPEC <path>:<line>:` block instead, `<path>` relative to `paths[0]` and the `> ` lines copied from that file; `github-write.mjs post` refuses a path the map does not list or a quote not in the file. Only an accepted ADR backs a comment.

Follow `pr-comment.md`: the samples carry the voice, the avoid list carries the corrections. UI copy and PRD wording in straight double quotes; identifiers and library messages in backticks.

## Approval

No `AskUserQuestion` (ADR 0022). The reply shows the draft as the file stands now, the way `shared/decision-points.md` says: a line `PR #<n> · <K> comments (head <sha8>)`, then each comment as `` **1.** `path:line` `` on its own line followed by its sentence and its PRD block verbatim, then the `warning:` lines the last lint printed. It leaves out the command, the `pinned:` and `notice:` lines and any job or card path, and runs the `github-write.mjs post` command in the same turn. Its permission prompt, which shows the command, is the one approval for that one post.

- "No" at the prompt with a note, or a request in chat, to trim or reword: edit the draft, lint, quote it again and run again.
- "No" with no note, or "not yet": keep the draft; the next-step menu follows.

## Pinned sources

Before reading any code, PRD or Figma for the review (SKILL step 3), run `node <plugin>/scripts/draft-lint.mjs pin-sources <draft> --pr <n> --repo <owner/repo>` from the reviewed repo, with the draft path above, even though the file does not exist yet; a `--repo` that is not the checkout's `origin` fails it. Add `--branch <repo>:<branch>` for each branch outside the map's that a finding will cite as `path:line@branch`. It records, for that path, the tip origin has now (one `git ls-remote --heads origin` per repo, all repos at once) of every other repo in the project map at the map's branch, or `origin/HEAD` when the map names none (the reviewed repo's own integration branch only with `--branch <its map path>:<branch>`, so add that when a finding cites a line of that branch; a cite alone does not pin it, while a cite of any other branch of that repo does), those `--branch` tips, and the PR head (`refs/pull/<n>/head`); it moves `origin/<branch>` and `refs/pr/<n>` to those shas, so read with `git show <sha>:<path>` (`source-access.md`). Write the draft after the read: a read pin newer than the draft refuses the lint. A clean `draft-lint.mjs pr-comment <draft> --repo <owner/repo>` then keeps those read pins and checks them with the rules below as of the lint: a changed file a comment names, or any move of the PR head, fails the lint (`run draft-lint.mjs pin-sources <draft> again, re-read what changed, …`), any other move prints a `notice:`. A branch only a `path:line@branch` cite in the draft names, and a Figma file or Doc a comment links, is pinned at lint with a `warning:`, and a cite whose branch no repo pins prints `warning: the cite @<branch> pins nothing`; with no read pins at all everything is pinned at lint and the `warning:` names it. Every `warning:` line goes into the reply before the post; the sources record keeps them. The lint prints one `pinned:` line per pin, with the full sha and `(read <time>)` or `(at lint)`; a map repo or a PR head it cannot reach fails it. The first clean run freezes the original, which `github-write.mjs post` and `draft-lint.mjs carry` check the PR and head against, so fix everything before the user sees the draft. `github-write.mjs post` refuses a draft with no sources record, an unreadable one, one written for another file or one edited since its last lint, then asks origin for each pinned tip:

- unchanged: it posts;
- moved, and no changed file (path or file name, also inside backticks, fences or a blob URL) is named in any comment: it prints `notice: … no changed file is named in the text being posted, so it posts as drafted` and posts; the notice goes to the terminal only, so the PR gets the draft exactly as approved. Read it: a claim that names no file may rest on code that changed;
- moved, and a comment names a changed file: it prints `refused: … changed a file the text being posted names`, the files and the commits. Read the new commits (`git -C <repo> show <sha>`), fix the findings and the draft, lint, and quote and post again; a lint without that read re-pins the new sha unchecked.
- the PR head moved: `refused: PR head moved …`. When the new commits change no file the draft comments on or names, `node <plugin>/scripts/draft-lint.mjs carry <draft> --repo <owner/repo>` moves the draft, its frozen original and its PR pin to the new head and keeps the text as shown, so post again; when it refuses, it lists those changed files: review the new commits, pin again, redraft. Never edit the head line by hand;
- a deleted branch, a lost pinned commit or a git error or timeout: `refused: …`; fetch, lint, post again.

Each refused run ends with `refused by github-write` or `refused by pins: nothing was written`, and the gate log keeps the reason.

Every new post (after a reword, a trim, a `refused` post, a `publishQuote` denial, or the user saying they edited the file themselves) re-reads the file, lints it and quotes it again before the command runs. The publish-quote gate counts only reply text blocks; thinking, AskUserQuestion and other tools' input are never shown to the user.
