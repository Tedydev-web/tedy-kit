# PR review comment style

The single source for how an inline PR review comment reads. `draft-lint.mjs pr-comment` enforces the mechanical half; the samples carry the voice. Measured on 31 real comments from 6 review drafts posted 2026-10-02 to 2026-10-06 in `tonpass-wallet-fe/plans/reports/review-*-line-comments.md`, all written after the user's last style correction (2026-09-30, PR #669).

## Shape

1. One Vietnamese sentence that states the current state of the code: what it does now, or what is missing. It ends with `ạ.` It names the symptom or the rule broken and stops; the team finds the fix themselves.
2. When a PRD rule backs the finding: a blank line, then the header `PRD EPIC <nn> · <UC_XX_nn> <locator>:`, then one or more `> ` lines quoting the PRD sentence verbatim in its original language. The locator is the PRD's own label: `step 3`, `BR7`, `AF1`, `#1`, `Ordinary Sequence step 1`, `UI Components & Rules`, `Error States`, `Precondition`, `Exceptions`.
3. Nothing else: no heading, no severity, no code block, no sign-off.

The detailed diagnosis (why, how sure, how to fix) lives in the report to the user, never in the comment.

## Measurements

| Property | Value in the 31 comments | Lint limit |
|---|---|---|
| First line is one sentence ending `ạ.` | 31/31 | required |
| PRD quote block present | 21/31 | header must be followed by `> ` |
| Header matches `^PRD EPIC \d{2} · UC_[A-Z]{2}_[A-Z0-9]+ .+:$` (ids such as `UC_MB_S01`, `UC_FW_04A` exist) | 21/21 | required |
| Body length (characters) | median 165, max 335 | 360 |
| Code block | 0 | none allowed |

Identifiers, file names, endpoints, and library or runtime messages go in backticks: `` `PUT spending-vaults` ``, `` `Invalid address: 0` ``. Straight double quotes are only for UI copy and PRD wording, `"Ask the family"`, because the post step checks each quoted string against the diff, the repository at the pinned head, and the PRD, and refuses a miss. Copy that only Figma shows passes when the same sentence links the frame: `[Figma](https://www.figma.com/design/LcVgoxchcAU5J4TYLa3AQ8/Family-Wallet-UI?node-id=3846-8503&m=dev) có "10/30"`.

A Figma reference is always the frame link, written as a markdown link `[Figma](<url>)` with `node-id=<a>-<b>&m=dev`, never a bare node id such as `Figma 3846:8503`: Figma cannot search by node id, so the reader needs the click (user rule, 2026-10-07).

## Samples (verbatim)

Chosen for spread: short and long, with and without PRD, UI copy, backend cross-check, signing, i18n, Figma.

### 1. UI copy, PRD step (PR #703, `review-261006-1613-pr703-line-comments.md`)

`apps/family/app/features/shared-wallet/components/settings/settings-space-handover-ownership-sheet.tsx:90`

```text
Nút đang là "Ask the family" ạ.

PRD EPIC 09 · UC_SW_08 step 3:
> button Ask the group.
```

### 2. no PRD, behaviour (PR #681, `review-261005-1705-pr681-line-comments.md`)

`apps/family/app/root.tsx:569`

```text
PIN gate đang bị comment lại, mở app vào thẳng mà không hỏi PIN ạ.
```

### 3. Figma frame link plus PRD (PR #702, `review-261005-1639-pr702-line-comments.md`, link form applied 2026-10-07)

`apps/family/app/features/shared-wallet/components/settings/settings-space-edit-info.tsx:111`

```text
Ô tên chưa có counter {n}/30, [Figma](https://www.figma.com/design/LcVgoxchcAU5J4TYLa3AQ8/Family-Wallet-UI?node-id=3846-8503&m=dev) có "10/30" căn phải dưới field ạ.

PRD EPIC 09 · UC_SW_02 Ordinary Sequence step 1:
> Name field pre-filled, counter {n}/30; Save disabled.
```

### 4. backend cross-check, signing (PR #681, `review-261005-1705-pr681-line-comments.md`)

`apps/family/app/features/shared-wallet/hooks/use-shared-send-submit.ts:90`

```text
Đang ký bằng `currentWallet.index`, trong khi BE `keysByUser` lấy key của ví walletIndex thấp nhất, nên ai đã đổi ví sẽ bị lệch chữ ký khi execute ạ.
```

### 5. i18n, PRD BR (PR #701, `review-261005-1457-pr701-line-comments.md`)

`settings-space-card.tsx:43`

```text
Key `family.shared.settings.memberCount` chưa có trong cả 5 file locale, nên vi/ja/ko/zh sẽ hiện tiếng Anh ạ.

PRD EPIC 09 · UC_SW_01 BR6:
> Member, Child and Viewer read {n} members.
```

### 6. longest: backend contract plus PRD (PR #697, `review-261002-1355-pr697-line-comments.md`)

`components/members/member-spending-vaults-sheet.tsx:32`

```text
Mở sheet là bỏ trắng hết, mà `PUT spending-vaults` bên BE ghi đè cả list, nên bấm Save xong Child mất các vault đang có ạ.

PRD EPIC 08 · UC_MB_09 Ordinary Sequence step 1:
> System — Sheet titled {Name}'s vaults: every vault in the wallet as a togglable row showing its name and what it holds; the Child's current vaults pre-selected.
```

## Avoid

| Pattern | Why (evidence) |
|---|---|
| Prescribing the fix: "sửa thành X", code snippets, step lists | User rejected a draft that prescribed exact fixes on #669, 2026-09-30: the team checks and debugs it themselves |
| A second sentence of rationale, or a paragraph | Same correction; over-explaining reads as hand-holding |
| Openers and fillers: "Anh ơi", "cảm ơn", "nhờ anh xem giúp" | Tone rule set 2026-09-24; the `ạ` ending already carries the politeness |
| Severity labels, emoji, a summary body, an AI-written note | Reviews post inline comments only with `event: COMMENT`; no disclosure note (user decision 2026-10-07) |
| A paraphrased or translated PRD quote | The quote is checked verbatim against the full PRD tab at post time; a paraphrase fails the post |
| Comments on a `TODO` the author left, or on Figma-identical placeholder data in a UI-only PR | User rule on #701, 2026-10-05: flag only what is wrong or unknown to the author |
| A finding that already existed before the PR | Separate it with `git log` / `git blame`; it goes to the report, not the PR |
| A bare Figma node id ("Figma 3411:6219") instead of the frame link | User rule 2026-10-07: Figma cannot search by node id; link the frame so one click opens it |
| A second or third reply stacked on one thread | User rule 2026-10-07 (#681): edit the existing reply into one sentence covering what is still open; minimize extras |
