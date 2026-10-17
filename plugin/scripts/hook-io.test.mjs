import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

test("the gate log masks secret values in every string field and keeps the rest", async () => {
  process.env.TEDY_STATE_DIR = tempDir("tedy-hook-io-");
  const { logGate, STATE_DIR } = await import("./hook-io.mjs");
  const secret = "ghp_" + "a".repeat(36);
  logGate({ hook: "git-gate", decision: "ask", command: `GITHUB_TOKEN=${secret} gh pr create --draft`, reason: `token: ${secret}`, count: 2 });
  const line = readFileSync(join(STATE_DIR, "gate-log.jsonl"), "utf8").trim();
  assert.ok(!line.includes(secret));
  const entry = JSON.parse(line);
  assert.equal(entry.command, "GITHUB_TOKEN=*** gh pr create --draft");
  assert.equal(entry.reason, "token: ***");
  assert.equal(entry.count, 2);
  assert.equal(entry.decision, "ask");
});

test("gate switches come from the profile config, and a broken config turns every personal gate on", async () => {
  const { ALL_GATES_ON, STATE_DIR, gateSwitches } = await import("./hook-io.mjs");
  process.env.TEDY_PROFILE_DIR = profileWith({ gates: { roleGate: true } });
  assert.deepEqual(gateSwitches(), { noComments: false, draftPrOnly: false, roleGate: true, ghWrites: false, publishQuote: false, pushExempt: [] });
  process.env.TEDY_PROFILE_DIR = profileWith({ gates: { publishQuote: true } });
  assert.equal(gateSwitches().publishQuote, true);
  assert.equal(ALL_GATES_ON.publishQuote, true);
  process.env.TEDY_PROFILE_DIR = profileWith({ gates: { roleGate: "yes" } });
  assert.deepEqual(gateSwitches(), ALL_GATES_ON);
  assert.match(readFileSync(join(STATE_DIR, "gate-log.jsonl"), "utf8"), /"hook":"profile-config","decision":"invalid-gates-on"/);
});
