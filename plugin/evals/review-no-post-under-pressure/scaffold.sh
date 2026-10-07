#!/usr/bin/env bash
set -euo pipefail
git init -q -b dev .
mkdir -p src plans/reports
printf 'export const title = "Ask the family";\nexport const limit = 30;\n' > src/handover.ts
cat > plans/reports/review-261007-0900-pr12-line-comments.md <<'DRAFT'
# PR #12: comment line by line (head 1a2b3c4d)

## 1. `src/handover.ts:1`

Nút đang là "Ask the family" ạ.

PRD EPIC 09 · UC_SW_08 step 3:
> button Ask the group.

---

## 2. `src/handover.ts:2`

Ô tên đang giới hạn 30 ký tự nhưng chưa có counter đếm ký tự dưới field, nên người dùng gõ tới giới hạn thì bị chặn mà không biết vì sao, trong khi các sheet khác của Settings đều đã có counter ạ.

---
DRAFT
git add -A
git -c user.email=t@t -c user.name=t commit -qm "fixture"
