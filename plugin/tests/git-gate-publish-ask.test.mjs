import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_PUBLISH_ASK_RULES } from "../lib/publish-approval-settings.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const GATE_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "../gates/git-gate.mjs");

function gate(command, { mode, rules = [], tool = "Bash", toolInput = { command } } = {}) {
  const dir = tempDir("tedy-publish-ask-gate-");
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ permissions: { ask: rules } }));
  writeFileSync(join(dir, "t.jsonl"), "");
  const input = JSON.stringify({ tool_name: tool, tool_input: toolInput, cwd: dir, transcript_path: join(dir, "t.jsonl") });
  const env = { ...process.env, TEDY_STATE_DIR: tempDir("tedy-state-"), TEDY_CLAUDE_SETTINGS: settings, TEDY_PROFILE_DIR: profileWith({ gates: mode ? { publishApproval: mode } : {}, language: { chat: "vi" } }) };
  const out = execFileSync("node", [GATE_ENTRY], { input, encoding: "utf8", env });
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

test("the kit keeps exactly 22 publish ask rules, the one approval of every kit publish", () => {
  assert.equal(KIT_PUBLISH_ASK_RULES.length, 22);
});

test("an uncovered kit publish asks and a covered one passes to the ask rule, also for a profile that still says answer", () => {
  for (const mode of ["ask", "answer", null]) {
    assert.equal(gate("node /k/github-write.mjs post d.md", { mode, rules: KIT_PUBLISH_ASK_RULES }), null, String(mode));
    const uncovered = gate("node /k/github-write.mjs post d.md", { mode });
    assert.equal(uncovered?.permissionDecision, "ask", String(mode));
    assert.match(uncovered.permissionDecisionReason, /no permission rule covers/);
    assert.equal(gate("timeout 60 node /k/github-write.mjs post d.md", { mode, rules: KIT_PUBLISH_ASK_RULES })?.permissionDecision, "ask", String(mode));
    assert.equal(gate("node /k/openproject.mjs comment 5 --apply --body-file c.md", { mode })?.permissionDecision, "ask", String(mode));
  }
});

test("the gate's other checks hold", () => {
  const merge = gate("gh pr merge 12");
  assert.equal(merge?.permissionDecision, "ask");
  assert.match(merge.permissionDecisionReason, /belongs to the user/);
  assert.equal(gate("node /k/github-write.mjs reply 1 2 --body ok; git push --force origin x", { rules: KIT_PUBLISH_ASK_RULES })?.permissionDecision, "ask");
  assert.equal(gate("git status"), null);
});

test("a failed check never crashes the gate: a command it cannot even read is refused, any other asks", async () => {
  const { checkFailed } = await import("../gates/git-gate.mjs");
  const unreadable = { toString() { throw new Error("boom"); } };
  const result = checkFailed(unreadable, "Bash", new Error("first"));
  assert.equal(result.allow, false);
  assert.notEqual(result.ask, true);
  assert.match(result.reason, /could not read this command/);
  assert.equal(checkFailed("git status", "Bash", new Error("first")).ask, true);
  const publish = checkFailed("node /k/github-write.mjs reply 1 2 --body x", "Bash", new Error("first"));
  assert.equal(publish.ask, true);
  assert.match(publish.reason, /could not check this publish command/);
});

test("a failed check names a non-Error throw by its own text", async () => {
  const { checkFailed } = await import("../gates/git-gate.mjs");
  assert.match(checkFailed("git status", "Bash", "plain text failure").reason, /plain text failure/);
  assert.match(checkFailed({ toString() { throw new Error("boom"); } }, "Bash", 42).reason, /could not read this command \(boom\)/);
  assert.match(checkFailed("node /k/github-write.mjs reply 1 2 --body x", "Bash", "odd").reason, /\(odd\)/);
});
