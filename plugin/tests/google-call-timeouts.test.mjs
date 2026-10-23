import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accessToken, rclone } from "../lib/gdoc-comments.mjs";
import { fetchTab } from "../lib/prd-section.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

function withRclone(script, run) {
  const bin = tempDir("tedy-rclone-");
  writeFileSync(join(bin, "rclone"), `#!/usr/bin/env node\n${script}\n`);
  chmodSync(join(bin, "rclone"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      process.env.PATH = path;
    });
}

const stall = () => {
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason)));
};

test("an rclone call that hangs fails after its timeout with a clear message", () =>
  withRclone("setTimeout(() => {}, 30_000);", () => {
    assert.throws(() => rclone(["config", "dump"], { timeout: 300 }), /^Error: rclone config dump timed out after 0\.3 s; check the network and rclone listremotes$/);
  }));

test("a token refresh that hangs fails after its timeout with a clear message", () =>
  withRclone(`process.stdout.write(JSON.stringify({ gdrive: { token: JSON.stringify({ access_token: "a", refresh_token: "r", expiry: "2999-01-01T00:00:00Z" }), client_id: "cid", client_secret: "cs" } }));`, async () => {
    stall();
    await assert.rejects(accessToken("gdrive", false, { timeout: 50 }), /^Error: POST \/token timed out after 0\.05 s$/);
  }));

test("a PRD tab export that hangs fails after its timeout with a clear message", async () => {
  stall();
  await assert.rejects(fetchTab("D1", "t.1", { timeout: 50 }), /^Error: GET \/document\/d\/D1\/export timed out after 0\.05 s$/);
});
