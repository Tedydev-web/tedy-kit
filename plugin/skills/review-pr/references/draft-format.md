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

- `post.asIs`: posts K comments as they are. Its `preview` holds the whole draft, verbatim, as the file stands now, then the `pinned:` lines the last lint printed, then the exact `github-write.mjs post` command line on a line of its own; one approval covers one post.
- `post.trim`: a follow-up question lists comment numbers (multiSelect; more than four comments → the user types numbers in "Other").
- `post.reword`: the user says what to change in "Other"; edit the draft, lint, quote it again, ask again.
- `post.hold`: keep the draft; the next-step menu follows.

## Pinned sources

A clean `draft-lint.mjs pr-comment` pins every repo in the project map, FE and BE, at the tip origin has now (`git ls-remote`): the map's branch, `origin/HEAD` and `dev` when it names none, and any branch an `@branch` token in the draft names. It prints one `pinned: <repo> origin/<branch>@<sha>` line per pin; a map repo it cannot reach fails the lint. Lint right after reading, because a push between the read and the lint is pinned unseen. `github-write.mjs post` refuses a draft with no sources record, an unreadable one, one written for another file or one edited since its last lint, then asks origin for each pinned tip:

- unchanged: it posts;
- moved, and no changed file (path or file name, also inside backticks, fences or a blob URL) is named in any comment: it prints `notice: … no changed file is named in the text being posted, so it posts as drafted` and posts; the notice goes to the terminal only, so the PR gets the draft exactly as approved. Read it: a claim that names no file may rest on code that changed;
- moved, and a comment names a changed file: it prints `refused: … changed a file the text being posted names`, the files and the commits. Read the new commits (`git -C <repo> show <sha>`), fix the findings and the draft, lint, and ask again; a lint without that read re-pins the new sha unchecked.
- a deleted branch, a lost pinned commit or a git error or timeout: `refused: …`; fetch, lint, ask again.

The pins are rechecked before the approval ticket is spent, so a refused post leaves the approval unused. That approval covers only the draft text it showed, so once the draft is fixed the re-ask needs a new one.

Every re-ask (after a reword, a trim, a `refused` post, a `publishQuote` or `publishApproval: answer` denial, a missing approval ticket, or the user saying they edited the file themselves) re-reads the file, lints it, quotes it again and puts the new text in `post.asIs`'s `preview`. The publish gate counts only reply text blocks and AskUserQuestion strings; thinking and other tools' input are never shown to the user.
