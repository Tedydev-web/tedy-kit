import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const DIR = new URL("./", import.meta.url);
const GUARD = "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)";
const entries = readdirSync(DIR).filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs") && readFileSync(new URL(file, DIR), "utf8").includes(GUARD));

test("every module with an argv guard exports run and its guard only calls run", async () => {
  assert.equal(entries.length, 24);
  for (const file of entries) {
    assert.equal(typeof (await import(new URL(file, DIR))).run, "function", file);
    assert.match(readFileSync(new URL(file, DIR), "utf8"), new RegExp(`^${GUARD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} run\\(\\);$`, "m"), file);
  }
});
