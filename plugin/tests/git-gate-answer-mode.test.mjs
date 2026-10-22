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

function gate(command, { mode = "answer", rules = [], tool = "Bash", toolInput = { command } } = {}) {
  const dir = tempDir("tedy-answer-gate-");
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ permissions: { ask: rules } }));
  writeFileSync(join(dir, "t.jsonl"), "");
  const input = JSON.stringify({ tool_name: tool, tool_input: toolInput, cwd: dir, transcript_path: join(dir, "t.jsonl") });
  const env = { ...process.env, TEDY_STATE_DIR: tempDir("tedy-state-"), TEDY_CLAUDE_SETTINGS: settings, TEDY_PROFILE_DIR: profileWith({ gates: mode ? { publishApproval: mode } : {}, language: { chat: "vi" } }) };
  const out = execFileSync("node", [GATE_ENTRY], { input, encoding: "utf8", env });
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

test("answer mode leaves every kit publish to the script's ticket check: no allow, no ask, no transcript read", () => {
  for (const command of [
    "node /k/github-write.mjs post d.md",
    "node /k/github-write.mjs reply 1 2 --body-file missing.md",
    "node /k/openproject.mjs comment 5 --apply --body-file c.md",
    "timeout 60 node /k/github-write.mjs reply 1 2 --body ok",
    "node /k/github-write.mjs post d.md # --dry-run",
    "node /k/github-write.mjs reply 1 2 --body ok && node /k/github-write.mjs reply 1 3 --body ok",
    "echo x; node /k/github-write.mjs reply 1 2 --body-file missing.md",
  ]) assert.equal(gate(command), null, command);
});

test("answer mode keeps the gate's other checks", () => {
  const merge = gate("gh pr merge 12");
  assert.equal(merge?.permissionDecision, "ask");
  assert.match(merge.permissionDecisionReason, /belongs to the user/);
  assert.equal(gate("node /k/github-write.mjs reply 1 2 --body ok; git push --force origin x")?.permissionDecision, "ask");
  assert.equal(gate("git status"), null);
});

test("ask mode is unchanged: an uncovered publish asks, a covered one passes to the ask rule", () => {
  for (const mode of ["ask", null]) {
    assert.equal(gate("node /k/github-write.mjs post d.md", { mode, rules: KIT_PUBLISH_ASK_RULES }), null, String(mode));
    const uncovered = gate("node /k/github-write.mjs post d.md", { mode });
    assert.equal(uncovered?.permissionDecision, "ask", String(mode));
    assert.match(uncovered.permissionDecisionReason, /no permission rule covers/);
    assert.equal(gate("timeout 60 node /k/github-write.mjs post d.md", { mode, rules: KIT_PUBLISH_ASK_RULES })?.permissionDecision, "ask", String(mode));
  }
});

test("a failed check never crashes the gate: a command it cannot even read is refused", async () => {
  const { checkFailed } = await import("../gates/git-gate.mjs");
  const unreadable = { toString() { throw new Error("boom"); } };
  for (const answerMode of [false, true]) {
    const result = checkFailed(unreadable, answerMode, "Bash", new Error("first"));
    assert.equal(result.allow, false);
    assert.notEqual(result.ask, true);
    assert.match(result.reason, /could not read this command/);
  }
  assert.equal(checkFailed("git status", false, "Bash", new Error("first")).ask, true);
  assert.equal(checkFailed("node /k/github-write.mjs reply 1 2 --body x", true, "Bash", new Error("first")).ask, undefined);
});

test("a failed check names a non-Error throw by its own text", async () => {
  const { checkFailed } = await import("../gates/git-gate.mjs");
  assert.match(checkFailed("git status", false, "Bash", "plain text failure").reason, /plain text failure/);
  assert.match(checkFailed({ toString() { throw new Error("boom"); } }, false, "Bash", 42).reason, /could not read this command \(boom\)/);
  assert.match(checkFailed("node /k/github-write.mjs reply 1 2 --body x", true, "Bash", "odd").reason, /\(odd\)/);
});
