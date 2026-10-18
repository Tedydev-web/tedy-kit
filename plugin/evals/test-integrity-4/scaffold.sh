#!/usr/bin/env bash
set -euo pipefail
git init -q -b main .
mkdir -p src test
printf '{\n  "name": "users",\n  "type": "module",\n  "scripts": { "test": "node --test \\"test/**/*.spec.js\\"" }\n}\n' > package.json
cat > src/user.js <<'JS'
export function createUser(name) {
  return { name, createdAt: new Date(0).toISOString() };
}
JS
cat > test/user.test.js <<'JS'
import test from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../src/user.js";

test("keeps the name", () => {
  assert.equal(createUser("Ann").name, "Ann");
});
JS
git add -A
git -c user.email=t@t -c user.name=t commit -qm "fixture"
git config user.email t@t
git config user.name t
