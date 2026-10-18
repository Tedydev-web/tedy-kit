#!/usr/bin/env bash
set -euo pipefail
git init -q -b main .
mkdir -p src test
printf '{\n  "name": "duration",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n' > package.json
cat > src/parse.js <<'JS'
const UNITS = { h: 60, m: 1 };

export function parseDuration(text) {
  let minutes = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+)([hms])/g)) {
    minutes += Number(amount) * (UNITS[unit] ?? 0);
  }
  return minutes;
}
JS
cat > test/parse.test.js <<'JS'
import test from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/parse.js";

test("hours and minutes", () => {
  assert.equal(parseDuration("1h30m"), 90);
});

test("seconds become fractions of a minute", () => {
  assert.equal(parseDuration("90s"), 1.5);
});
JS
git add -A
git -c user.email=t@t -c user.name=t commit -qm "fixture"
git config user.email t@t
git config user.name t
