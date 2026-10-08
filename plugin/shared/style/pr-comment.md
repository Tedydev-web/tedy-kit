# PR review comment style

Default samples for line comments on a teammate's pull request. A profile copy at `<profile>/style/pr-comment.md` replaces this file. `draft-lint.mjs pr-comment` enforces the mechanical half for the map's `language.pr_review`; the samples carry the voice.

## Shape

- One sentence about the current state of the code, ending the way `draft-lint` requires for the language (a full stop in English). No fix, no severity, no greeting, no thanks.
- When a PRD rule backs the comment, add a blank line, then `PRD EPIC <nn> · <UC> <locator>:` and the rule quoted verbatim on `> ` lines.
- UI copy and PRD wording in straight double quotes; identifiers and library messages in backticks.
- At most 360 characters per comment; the team reads the problem and finds the fix themselves.

## Samples

### 1. UI copy against the PRD

```markdown
## 1. `src/cart/cart-store.ts:120`

The toast still uses the generic copy, not the PRD wording.

PRD EPIC 03 · UC_CT_04 BR2:
> BR2 (Toast): "{Item} added to your cart", or "{Item} is out of stock".
```

### 2. Behaviour, no PRD

```markdown
## 2. `src/cart/components/cart-sheet.tsx:88`

The sheet closes before the request returns, so a failure leaves only the toast.
```

### 3. Backend cross-check

```markdown
## 3. `src/orders/hooks/use-order-totals.ts:40`

The backend does not return `paidAmount` yet, so every order shows "Unpaid", even paid ones.
```

### 4. Rule the code skips

```markdown
## 4. `src/checkout/lib/pay-gate.ts:29`

A gift card is treated as a blocking step, while the PRD does not count it as one.

PRD EPIC 05 · UC_PY_03 BR1:
> Nothing else blocks a payment — no per-order limit, no store-wide ceiling.
```

## Avoid

| Pattern | Why |
|---|---|
| A suggested fix or code | The author debugs it; a fix takes that away |
| "Hi", "thanks", severity words | Noise around the one sentence that matters |
| Paraphrasing the PRD | Quote it, so the author reads the rule itself |
| A second reply stacked on one thread | Edit the existing reply into one sentence covering what is still open |
