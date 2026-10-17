import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const SKILLS = new URL("../skills/", import.meta.url);

test("every SKILL.md stays at 9,000 characters or fewer", () => {
  const sizes = readdirSync(SKILLS).map((name) => [name, readFileSync(new URL(`${name}/SKILL.md`, SKILLS), "utf8").length]);
  assert.ok(sizes.length >= 6, String(sizes.length));
  for (const [name, size] of sizes) assert.ok(size <= 9000, `${name}/SKILL.md is ${size} characters`);
});
