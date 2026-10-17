import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PLUGIN = fileURLToPath(new URL("../", import.meta.url));
const SCANNED = ["skills", "shared", "lib", "gates", "agents", "hooks"];

test("the engine never cites a rule by number, because each profile numbers its rules its own way", () => {
  const hits = SCANNED.flatMap((dir) =>
    readdirSync(join(PLUGIN, dir), { recursive: true })
      .filter((file) => /\.(md|mjs|json)$/.test(file) && !file.endsWith("rules-template.md"))
      .flatMap((file) => readFileSync(join(PLUGIN, dir, file), "utf8").split("\n").flatMap((line, index) => (/\brules? \d+\b/i.test(line) ? [`${dir}/${file}:${index + 1}`] : []))),
  );
  assert.deepEqual(hits, []);
});
