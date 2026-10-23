import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rclone } from "../lib/gdoc-comments.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

test("an rclone call that hangs fails after its timeout with a clear message", () => {
  const bin = tempDir("tedy-rclone-");
  writeFileSync(join(bin, "rclone"), "#!/usr/bin/env node\nsetTimeout(() => {}, 30_000);\n");
  chmodSync(join(bin, "rclone"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    assert.throws(() => rclone(["config", "dump"], { timeout: 300 }), /^Error: rclone config dump timed out after 0\.3 s; check the network and rclone listremotes$/);
  } finally {
    process.env.PATH = path;
  }
});
