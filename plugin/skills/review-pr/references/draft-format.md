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

Follow `pr-comment.md`: the samples carry the voice, the avoid list carries the corrections. UI copy and PRD wording in straight double quotes; identifiers and library messages in backticks.

## Approval menu

One `AskUserQuestion`, header `post.header`, after the whole draft is quoted in the reply:

- `post.asIs`: posts K comments as they are. Its `preview` holds the whole draft, verbatim, as the file stands now, then the `pinned:`, `warning:` and `notice:` lines the last lint printed, then the exact `github-write.mjs post` command line on a line of its own; one approval covers one post.
- `post.trim`: a follow-up question lists comment numbers (multiSelect; more than four comments → the user types numbers in "Other").
- `post.reword`: the user says what to change in "Other"; edit the draft, lint, quote it again, ask again.
- `post.hold`: keep the draft; the next-step menu follows.

## Pinned sources

Before reading any code, PRD or Figma for the review (SKILL step 3), run `node <plugin>/scripts/draft-lint.mjs pin-sources <draft> --pr <n> --repo <owner/repo>` from the reviewed repo, with the draft path above, even though the file does not exist yet; a `--repo` that is not the checkout's `origin` fails it. Add `--branch <repo>:<branch>` for each branch outside the map's that a finding will cite as `path:line@branch`. It records, for that path, the tip origin has now (one `git ls-remote --heads origin` per repo, all repos at once) of every repo in the project map, FE and BE, at the map's branch, or `origin/HEAD` when the map names none, those `--branch` tips, and the PR head (`refs/pull/<n>/head`); it moves `origin/<branch>` and `refs/pr/<n>` to those shas, so read with `git show <sha>:<path>` (`source-access.md`). Write the draft after the read: a read pin newer than the draft refuses the lint. A clean `draft-lint.mjs pr-comment <draft> --repo <owner/repo>` then keeps those read pins and checks them with the rules below as of the lint: a changed file a comment names, or any move of the PR head, fails the lint (`run draft-lint.mjs pin-sources <draft> again, re-read what changed, …`), any other move prints a `notice:`. A branch only a `path:line@branch` cite in the draft names, and a Figma file or Doc a comment links, is pinned at lint with a `warning:`; with no read pins at all everything is pinned at lint and the `warning:` names it. Every `pinned:`, `warning:` and `notice:` line goes into the approval preview; the sources record keeps the `warning:` lines, and in answer mode `post` matches no approval whose preview lacks them. The lint prints one `pinned:` line per pin, with the full sha and `(read <time>)` or `(at lint)`; a map repo or a PR head it cannot reach fails it. The first clean run freezes the original for the edit log, so fix everything before the user sees the draft. `github-write.mjs post` refuses a draft with no sources record, an unreadable one, one written for another file or one edited since its last lint, then asks origin for each pinned tip:

- unchanged: it posts;
- moved, and no changed file (path or file name, also inside backticks, fences or a blob URL) is named in any comment: it prints `notice: … no changed file is named in the text being posted, so it posts as drafted` and posts; the notice goes to the terminal only, so the PR gets the draft exactly as approved. Read it: a claim that names no file may rest on code that changed;
- moved, and a comment names a changed file: it prints `refused: … changed a file the text being posted names`, the files and the commits. Read the new commits (`git -C <repo> show <sha>`), fix the findings and the draft, lint, and ask again; a lint without that read re-pins the new sha unchecked.
- the PR head moved: `refused: … so the PR under review changed`, with its commits; review the new commits, pin again, redraft;
- a deleted branch, a lost pinned commit or a git error or timeout: `refused: …`; fetch, lint, ask again.

The pins are rechecked before the approval ticket is spent, so a refused post leaves the approval unused. That approval covers only the draft text it showed, so once the draft is fixed the re-ask needs a new one.

Every re-ask (after a reword, a trim, a `refused` post, a `publishQuote` or `publishApproval: answer` denial, a missing approval ticket, or the user saying they edited the file themselves) re-reads the file, lints it, quotes it again and puts the new text in `post.asIs`'s `preview`. The publish gate counts only reply text blocks and AskUserQuestion strings; thinking and other tools' input are never shown to the user.
