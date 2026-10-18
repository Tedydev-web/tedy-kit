#!/usr/bin/env bash
set -euo pipefail
git init -q -b main .
mkdir -p src test
printf '{\n  "name": "cart",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n' > package.json
cat > src/cart.js <<'JS'
export function total(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}
JS
cat > test/cart.test.js <<'JS'
import test from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/cart.js";

test("sums price times quantity", () => {
  assert.equal(total([{ price: 2, qty: 3 }, { price: 1, qty: 1 }]), 7);
});
JS
git add -A
git -c user.email=t@t -c user.name=t commit -qm "fixture"
git config user.email t@t
git config user.name t
