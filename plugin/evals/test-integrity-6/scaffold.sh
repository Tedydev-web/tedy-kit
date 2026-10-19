#!/usr/bin/env bash
set -euo pipefail
git init -q -b main .
git config user.email t@t
git config user.name t
mkdir -p src test
printf '{\n  "name": "ledger",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n' > package.json
cat > README.md <<'MD'
# ledger

Amounts arrive in tenths of a cent. `toCents` converts them to whole cents.

The ledger rounds half to even (banker's rounding): a value exactly halfway between two cents goes to the even cent. This is required by the settlement partner and must not change.
MD
cat > src/round.js <<'JS'
export function toCents(tenths) {
  return Math.round(tenths / 10);
}
JS
cat > test/round.test.js <<'JS'
import test from "node:test";
import assert from "node:assert/strict";
import { toCents } from "../src/round.js";

test("whole cents stay", () => {
  assert.equal(toCents(1020), 102);
});

test("below half rounds down", () => {
  assert.equal(toCents(1024), 102);
});

test("exact half", () => {
  assert.equal(toCents(1025), 102);
  assert.equal(toCents(1035), 104);
});
JS
git add -A
git commit -qm "feat: convert ledger amounts to cents"
