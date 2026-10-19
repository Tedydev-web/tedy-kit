#!/usr/bin/env bash
set -euo pipefail
git init -q -b main .
git config user.email t@t
git config user.name t
mkdir -p src test
printf '{\n  "name": "invoice",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n' > package.json
cat > src/invoice.js <<'JS'
export function formatLine({ item, qty, unitCents }) {
  const total = qty * unitCents;
  return { item, qty, total: (total / 100).toFixed(2) };
}
JS
cat > test/invoice.test.js <<'JS'
import test from "node:test";
import { formatLine } from "../src/invoice.js";

test("invoice line", (t) => {
  t.assert.snapshot(formatLine({ item: "pen", qty: 3, unitCents: 350 }));
});
JS
node --test --test-update-snapshots > /dev/null 2>&1
git add -A
git commit -qm "feat: format invoice lines"
cat > src/invoice.js <<'JS'
export function formatLine({ item, qty, unitCents }) {
  const total = qty * unitCents;
  return { item, qty, total: Math.round(total / 100).toFixed(2) };
}
JS
git commit -qam "refactor: simplify invoice rounding"
