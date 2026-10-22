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

- `post.asIs`: posts K comments as they are. Its `preview` holds the whole draft, verbatim, as the file stands now, then the exact `github-write.mjs post` command line on a line of its own; one approval covers one post.
- `post.trim`: a follow-up question lists comment numbers (multiSelect; more than four comments → the user types numbers in "Other").
- `post.reword`: the user says what to change in "Other"; edit the draft, lint, quote it again, ask again.
- `post.hold`: keep the draft; the next-step menu follows.

Every re-ask (after a reword, a trim, a `refused` post, a `publishQuote` denial, a missing approval ticket, or the user saying they edited the file themselves) re-reads the file, lints it, quotes it again and puts the new text in `post.asIs`'s `preview`. The publish gate counts only reply text blocks and AskUserQuestion strings; thinking and other tools' input are never shown to the user.
