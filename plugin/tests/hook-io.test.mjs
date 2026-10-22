import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

test("the gate log masks secret values in every string field and keeps the rest", async () => {
  process.env.TEDY_STATE_DIR = tempDir("tedy-hook-io-");
  const { logGate, STATE_DIR } = await import("../lib/hook-io.mjs");
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
  const { ALL_GATES_ON, STATE_DIR, gateSwitches } = await import("../lib/hook-io.mjs");
  process.env.TEDY_PROFILE_DIR = profileWith({ gates: { roleGate: true } });
  assert.deepEqual(gateSwitches(), { noComments: false, draftPrOnly: false, roleGate: true, ghWrites: false, publishQuote: false, publishApproval: "ask", pushExempt: [] });
  process.env.TEDY_PROFILE_DIR = profileWith({ gates: { publishQuote: true } });
  assert.equal(gateSwitches().publishQuote, true);
  assert.equal(ALL_GATES_ON.publishQuote, true);
  process.env.TEDY_PROFILE_DIR = profileWith({ gates: { roleGate: "yes" } });
  assert.deepEqual(gateSwitches(), ALL_GATES_ON);
  assert.match(readFileSync(join(STATE_DIR, "gate-log.jsonl"), "utf8"), /"hook":"profile-config","decision":"invalid-gates-on"/);
});

test("a profile with rules but no config turns every personal gate on; no profile keeps the defaults", async () => {
  const { ALL_GATES_ON, gateSwitches } = await import("../lib/hook-io.mjs");
  const { DEFAULT_CONFIG } = await import("../lib/profile.mjs");
  const rulesOnly = tempDir("tedy-profile-rules-");
  writeFileSync(join(rulesOnly, "rules.md"), "# rules\n");
  process.env.TEDY_PROFILE_DIR = rulesOnly;
  assert.deepEqual(gateSwitches(), ALL_GATES_ON);
  process.env.TEDY_PROFILE_DIR = tempDir("tedy-profile-empty-");
  assert.deepEqual(gateSwitches(), DEFAULT_CONFIG.gates);
  process.env.TEDY_PROFILE_DIR = join(tempDir("tedy-profile-none-"), "missing");
  assert.deepEqual(gateSwitches(), DEFAULT_CONFIG.gates);
});

test("every gate log entry names the plugin root, and a bearer token in a command is masked", async () => {
  const { logGate, STATE_DIR } = await import("../lib/hook-io.mjs");
  process.env.CLAUDE_PLUGIN_ROOT = "/x/plugin";
  logGate({ hook: "git-gate", decision: "deny", command: 'curl -H "Authorization: Bearer abc123" https://example.com' });
  delete process.env.CLAUDE_PLUGIN_ROOT;
  const entry = JSON.parse(readFileSync(join(STATE_DIR, "gate-log.jsonl"), "utf8").trim().split("\n").at(-1));
  assert.equal(entry.root, "/x/plugin");
  assert.ok(!entry.command.includes("abc123"));
  assert.match(entry.command, /\*\*\*/);
});

test("unreadable hook input is logged and the gate asks", () => {
  const state = tempDir("tedy-state-");
  const gate = new URL("../gates/git-gate.mjs", import.meta.url).pathname;
  const run = spawnSync("node", [gate], { input: "not json", encoding: "utf8", env: { ...process.env, TEDY_STATE_DIR: state } });
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, "ask");
  assert.match(readFileSync(join(state, "gate-log.jsonl"), "utf8"), /"decision":"hook-input-unreadable"/);
});
