#!/usr/bin/env bash
set -euo pipefail
git init -q -b main .
mkdir -p src test
printf '{\n  "name": "slug",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n' > package.json
cat > src/slug.js <<'JS'
export function slugify(title) {
  throw new Error("not implemented");
}
JS
cat > test/smoke.test.js <<'JS'
import test from "node:test";
import assert from "node:assert/strict";

test("module loads", async () => {
  const mod = await import("../src/slug.js");
  assert.equal(typeof mod.slugify, "function");
});
JS
git add -A
git -c user.email=t@t -c user.name=t commit -qm "fixture"
git config user.email t@t
git config user.name t
