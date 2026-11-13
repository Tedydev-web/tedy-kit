import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir-for-tests.mjs";

const lib = new URL("../lib/", import.meta.url);

test("a script's last exit waits for stdout, so a large output read through a pipe arrives whole", () => {
  const dir = tempDir("tedy-cli-exit-");
  const child = join(dir, "child.mjs");
  writeFileSync(child, `import { exitAfterOutput } from ${JSON.stringify(new URL("cli-exit.mjs", lib).href)};\nconsole.log("x".repeat(1 << 20));\nexitAfterOutput(3);\n`);
  const result = spawnSync(process.execPath, [child], { encoding: "utf8", maxBuffer: 1 << 26 });
  assert.equal(result.status, 3);
  assert.equal(result.stdout.length, (1 << 20) + 1);
});

test("no script ends its run with a bare process.exit of main's result", () => {
  const bare = /\(code\) => process\.exit\(code\)|^\s*process\.exit\(main\(|^\s*process\.exit\(runBatch\(/m;
  const offenders = readdirSync(lib).filter((name) => name.endsWith(".mjs") && bare.test(readFileSync(new URL(name, lib), "utf8")));
  assert.deepEqual(offenders, []);
});
