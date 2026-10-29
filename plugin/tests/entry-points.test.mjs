import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const GUARD = "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)";
const entries = ["../gates/", "../lib/"].flatMap((dir) => {
  const url = new URL(dir, import.meta.url);
  return readdirSync(url).filter((file) => file.endsWith(".mjs")).map((file) => new URL(file, url)).filter((file) => readFileSync(file, "utf8").includes(GUARD));
});

test("every module with an argv guard exports run and its guard only calls run", async () => {
  assert.equal(entries.length, 29);
  for (const file of entries) {
    assert.equal(typeof (await import(file)).run, "function", file.pathname);
    assert.match(readFileSync(file, "utf8"), new RegExp(`^${GUARD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} run\\(\\);$`, "m"), file.pathname);
  }
});
