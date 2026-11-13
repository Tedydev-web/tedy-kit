import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBatch, runBatch } from "../lib/publish-batch.mjs";
import { KIT_PUBLISH_ASK_RULES } from "../lib/publish-approval-settings.mjs";
import { check } from "../gates/publish-quote-gate.mjs";
import { classifyActions } from "../gates/role-gate.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const GATE_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "../gates/git-gate.mjs");

function batchFile(items, dir = tempDir("tedy-batch-")) {
  const file = join(dir, "batch.json");
  writeFileSync(file, JSON.stringify({ items }));
  return file;
}

test("a batch holds only comment writes of the kit's writers, each in its writing form", () => {
  const ok = [["openproject.mjs", "comment", "22039", "--body-file", "a.txt", "--apply"], ["figma-comments.mjs", "post", "1:2", "--body-file", "b.txt", "--file", "K"], ["github-write.mjs", "resolve", "PRRT_1", "--repo", "o/r"]];
  assert.deepEqual(readBatch(batchFile(ok)), ok);
  for (const [items, pattern] of [
    [[], /non-empty "items" array/],
    [[["openproject.mjs", "apply", "d.json"]], /item 1 \(openproject\.mjs apply\) is not a comment write/],
    [[["github-write.mjs", "pr-body", "1", "--repo", "o/r"]], /item 1 \(github-write\.mjs pr-body\) is not a comment write/],
    [[["gh", "pr", "merge", "1"]], /item 1 \(gh pr\) is not a comment write/],
    [[["openproject.mjs", "comment", "1", "--body-file", "a.txt"]], /item 1 has no --apply, so it would not write/],
    [[["github-write.mjs", "reply", "1", "--body-file", "a.txt", "--repo", "o/r", "--dry-run"]], /item 1 is a dry run/],
    [[["openproject.mjs", 7]], /item 1 must be an array of strings/],
  ]) assert.throws(() => readBatch(batchFile(items)), pattern);
});

test("a batch runs its items in order and stops at the first that fails, saying what ran and what did not", () => {
  const scripts = tempDir("tedy-batch-scripts-");
  const log = join(scripts, "log");
  writeFileSync(log, "");
  writeFileSync(join(scripts, "openproject.mjs"), `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, process.argv[3] + "\\n"); process.exit(process.argv[3] === "2" ? 3 : 0);\n`);
  const items = ["1", "2", "3"].map((id) => ["openproject.mjs", "comment", id, "--body-file", "a.txt", "--apply"]);
  let out = "";
  const code = runBatch(items, { scriptsDir: scripts, out: { write: (text) => { out += text; } } });
  assert.equal(code, 1);
  assert.equal(readFileSync(log, "utf8"), "1\n2\n");
  assert.match(out, /item 2 of 3 failed \(exit 3\); 1 item ran before it; item 3 was not run/);
  out = "";
  assert.equal(runBatch(items.slice(0, 1), { scriptsDir: scripts, out: { write: (text) => { out += text; } } }), 0);
  assert.match(out, /all 1 items ran/);
});

function gate(command, dir) {
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ permissions: { ask: KIT_PUBLISH_ASK_RULES } }));
  writeFileSync(join(dir, "t.jsonl"), "");
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: dir, transcript_path: join(dir, "t.jsonl") });
  const env = { ...process.env, TEDY_STATE_DIR: tempDir("tedy-state-"), TEDY_CLAUDE_SETTINGS: settings, TEDY_PROFILE_DIR: profileWith({ language: { chat: "vi" } }) };
  const out = execFileSync("node", [GATE_ENTRY], { input, encoding: "utf8", env });
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

test("the git gate asks once for a batch and names every item with the first line of its text, and denies a batch it cannot run", () => {
  const dir = tempDir("tedy-batch-gate-");
  writeFileSync(join(dir, "a.txt"), "\nAnh ơi task này thiếu AC cho trạng thái lỗi ạ.\nDòng hai.\n");
  writeFileSync(join(dir, "b.txt"), "Frame này thiếu state Turning on.\n");
  batchFile([["openproject.mjs", "comment", "22039", "--body-file", "a.txt", "--apply"], ["figma-comments.mjs", "post", "1:2", "--body-file", "b.txt", "--file", "K"]], dir);
  const asked = gate("node /k/plugin/scripts/publish-batch.mjs batch.json", dir);
  assert.equal(asked.permissionDecision, "ask");
  assert.match(asked.permissionDecisionReason, /Đăng 2 mục dưới tên anh/);
  assert.match(asked.permissionDecisionReason, /1\) openproject comment 22039: «Anh ơi task này thiếu AC cho trạng thái lỗi ạ\.»/);
  assert.match(asked.permissionDecisionReason, /2\) figma-comments post 1:2: «Frame này thiếu state Turning on\.»/);
  batchFile([["openproject.mjs", "apply", "d.json"]], dir);
  const denied = gate("node /k/plugin/scripts/publish-batch.mjs batch.json", dir);
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /refused by publish-batch: item 1 \(openproject\.mjs apply\) is not a comment write/);
});

test("the kit's ask rules cover a batch, so the prompt stays even if the hook fails to run", () => {
  assert.ok(KIT_PUBLISH_ASK_RULES.includes("Bash(*publish-batch.mjs*)"));
});

test("a batch item that posts PR text the chat has not shown is refused by the publish-quote gate", () => {
  const dir = tempDir("tedy-batch-quote-");
  writeFileSync(join(dir, "r.txt"), "Chỗ này đã sửa ạ.\n");
  batchFile([["github-write.mjs", "reply", "PRRC_1", "--body-file", "r.txt", "--repo", "o/r"]], dir);
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", timestamp: new Date(Date.now() + 60_000).toISOString(), message: { content: [{ type: "text", text: "something else" }] } })}\n`);
  const refused = check({ tool_input: { command: "node /k/plugin/scripts/publish-batch.mjs batch.json" }, cwd: dir, transcript_path: transcript });
  assert.equal(refused.ask, false);
  assert.match(refused.reason, /missing from the chat: reply body of .*r\.txt/);
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", timestamp: new Date(Date.now() + 60_000).toISOString(), message: { content: [{ type: "text", text: "```\nChỗ này đã sửa ạ.\n```" }] } })}\n`);
  assert.equal(check({ tool_input: { command: "node /k/plugin/scripts/publish-batch.mjs batch.json" }, cwd: dir, transcript_path: transcript }), null);
});

test("the role gate sees each item of a batch, so a batch cannot carry another role's write", () => {
  const dir = tempDir("tedy-batch-role-");
  batchFile([["github-write.mjs", "resolve", "PRRT_1", "--repo", "o/r"], ["openproject.mjs", "comment", "1", "--body-file", "a.txt", "--apply"]], dir);
  const kinds = classifyActions({ tool_name: "Bash", tool_input: { command: "node /k/plugin/scripts/publish-batch.mjs batch.json" }, cwd: dir }, { repos: [] }).map((action) => action.kind);
  assert.deepEqual(kinds, ["pr-review", "tracker"]);
});
