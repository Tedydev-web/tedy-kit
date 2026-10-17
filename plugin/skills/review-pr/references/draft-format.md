# Line-comment draft format

File: `plans/drafts/review-<yymmdd-hhmm>-pr<n>-line-comments.md` in the reviewed repo.

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

One `AskUserQuestion`, header `post.header`:

- `post.asIs`: posts K comments as they are.
- `post.trim`: a follow-up question lists comment numbers (multiSelect; more than four comments → the user types numbers in "Other").
- `post.reword`: the user says what to change in "Other"; edit the draft, lint, quote it again, ask again.
- `post.hold`: keep the draft; the next-step menu follows.
