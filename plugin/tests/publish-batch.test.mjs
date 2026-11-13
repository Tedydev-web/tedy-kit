import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { batchSummary, itemSummary, readBatch, runBatch } from "../lib/publish-batch.mjs";
import { KIT_PUBLISH_ASK_RULES } from "../lib/publish-approval-settings.mjs";
import { check } from "../gates/publish-quote-gate.mjs";
import { classifyActions } from "../gates/role-gate.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const GATE_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "../gates/git-gate.mjs");
const BATCH_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "../scripts/publish-batch.mjs");

function batchFile(items, dir = tempDir("tedy-batch-")) {
  const file = join(dir, "batch.json");
  writeFileSync(file, JSON.stringify({ items }));
  return file;
}

test("a batch holds any write of the kit's writers in its writing form, and nothing else", () => {
  const ok = [
    ["openproject.mjs", "comment", "22039", "--body-file", "a.txt", "--apply"],
    ["openproject.mjs", "apply", "drafts.json"],
    ["openproject.mjs", "set", "22039", "--status", "Closed", "--apply", "--lock", "4"],
    ["figma-comments.mjs", "post", "1:2", "--body-file", "b.txt", "--file", "K"],
    ["github-write.mjs", "pr-body", "12", "--body-file", "body.md", "--repo", "o/r"],
    ["doc-comment-file.mjs", "post", "items.json", "--html", "c.html", "--apply"],
  ];
  assert.deepEqual(readBatch(batchFile(ok)), ok);
  for (const [items, pattern] of [
    [[], /non-empty "items" array/],
    [[["gh", "pr", "merge", "1"]], /item 1 \(gh pr\) is not a write of a kit writer/],
    [[["lib/openproject.mjs", "comment", "1", "--apply"]], /item 1 \(lib\/openproject\.mjs comment\) is not a write of a kit writer/],
    [[["publish-batch.mjs", "b.json"]], /item 1 \(publish-batch\.mjs b\.json\) is not a write of a kit writer/],
    [[["openproject.mjs", "preview", "drafts.json"]], /item 1 \(openproject\.mjs preview\) is not a write of a kit writer/],
    [[["openproject.mjs", "set", "1", "--status", "Closed"]], /item 1 has no --apply, so it would not write/],
    [[["github-write.mjs", "post", "d.md", "--dry-run"]], /item 1 is a dry run/],
    [[["openproject.mjs", 7]], /item 1 must be an array of strings/],
  ]) assert.throws(() => readBatch(batchFile(items)), pattern);
});

test("each item is summed up from its own files and flags, one line, with no character that breaks a double-quoted shell word", () => {
  const dir = tempDir("tedy-batch-sum-");
  writeFileSync(join(dir, "a.txt"), "\nA ơi task này thiếu \"AC\" cho $state ạ.\nDòng hai.\n");
  writeFileSync(join(dir, "drafts.json"), JSON.stringify([{ subject: "[FE] Vault limit pop-up" }, { id: 22040, subject: "[FE] Wire vault limit" }]));
  writeFileSync(join(dir, "d.md"), "# PR #955: comment line by line (head abcdef1234567890abcdef1234567890abcdef12)\n\n## 1. `src/a.ts:12`\n\nChỗ này thiếu retry ạ.\n\n## 2. `src/b.ts:3`\n\nChỗ này đặt tên lạ ạ.\n");
  writeFileSync(join(dir, "items.json"), JSON.stringify({ title: "Swap", items: [{ comment: "Swap trong filter là gì ạ?" }, { comment: "x" }] }));
  const cases = [
    [["openproject.mjs", "comment", "22039", "--body-file", "a.txt", "--apply"], "OP #22039 comment «A ơi task này thiếu AC cho state ạ.»"],
    [["openproject.mjs", "apply", "drafts.json"], "OP apply 2 task «[FE] Vault limit pop-up», #22040 «[FE] Wire vault limit»"],
    [["openproject.mjs", "set", "22039", "--status", "Closed", "--assignee", "Lâm Trần", "--apply", "--lock", "4"], "OP #22039 set status=Closed, assignee=Lâm Trần"],
    [["openproject.mjs", "relation", "1", "2", "--type", "blocks", "--apply"], "OP #1 blocks #2"],
    [["github-write.mjs", "post", "d.md", "--repo", "o/r"], "PR #955 review 2 comment «Chỗ này thiếu retry ạ.»"],
    [["github-write.mjs", "resolve", "PRRT_1", "PRRT_2", "--repo", "o/r"], "PR resolve 2 thread"],
    [["doc-comment-file.mjs", "post", "items.json", "--html", "c.html", "--apply"], "Doc 2 question «Swap trong filter là gì ạ?»"],
    [["figma-comments.mjs", "delete", "99", "--file", "K"], "Figma delete 99"],
  ];
  for (const [item, line] of cases) assert.equal(itemSummary(item, dir), line);
});

test("a batch runs only when --shows is its exact summary, in order, and stops at the first item that fails", () => {
  const scripts = tempDir("tedy-batch-scripts-");
  const log = join(scripts, "log");
  writeFileSync(log, "");
  writeFileSync(join(scripts, "openproject.mjs"), `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, process.argv[3] + "\\n"); process.exit(process.argv[3] === "2" ? 3 : 0);\n`);
  const items = ["1", "2", "3"].map((id) => ["openproject.mjs", "comment", id, "--body-file", "a.txt", "--apply"]);
  const summary = batchSummary(items, scripts, "vi");
  let out = "";
  const write = { write: (text) => { out += text; } };
  assert.equal(runBatch(items, { shows: `${summary} `, summary, scriptsDir: scripts, out: write }), 2);
  assert.equal(readFileSync(log, "utf8"), "");
  assert.match(out, /--shows is not this batch's summary; run publish-batch\.mjs <batch\.json> --summary[\s\S]*nothing was written/);
  out = "";
  assert.equal(runBatch(items, { shows: summary, summary, scriptsDir: scripts, out: write }), 1);
  assert.equal(readFileSync(log, "utf8"), "1\n2\n");
  assert.match(out, /item 2 of 3 failed \(exit 3\); 1 item ran before it; item 3 was not run/);
});

test("--summary prints the summary and the command to run, and writes nothing", () => {
  const dir = tempDir("tedy-batch-print-");
  writeFileSync(join(dir, "a.txt"), "Frame thiếu state ạ.\n");
  const file = batchFile([["figma-comments.mjs", "post", "1:2", "--body-file", "a.txt", "--file", "K"]], dir);
  const env = { ...process.env, TEDY_PROFILE_DIR: profileWith({ language: { chat: "vi" } }) };
  const out = execFileSync("node", [BATCH_ENTRY, file, "--summary"], { encoding: "utf8", cwd: dir, env });
  assert.match(out, /^Đăng 1 mục dưới tên anh: 1\) Figma K 1:2 comment «Frame thiếu state ạ\.»$/m);
  assert.match(out, /publish-batch\.mjs .*batch\.json --shows "Đăng 1 mục dưới tên anh: 1\) Figma K 1:2 comment «Frame thiếu state ạ\.»"/);
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

test("the git gate asks for a batch whose --shows is its summary, and denies a missing or different summary or a batch it cannot run", () => {
  const dir = tempDir("tedy-batch-gate-");
  writeFileSync(join(dir, "a.txt"), "Anh ơi task này thiếu AC ạ.\n");
  batchFile([["openproject.mjs", "comment", "22039", "--body-file", "a.txt", "--apply"]], dir);
  const summary = batchSummary(readBatch(join(dir, "batch.json")), dir, "vi");
  assert.equal(summary, "Đăng 1 mục dưới tên anh: 1) OP #22039 comment «Anh ơi task này thiếu AC ạ.»");
  const asked = gate(`node /k/plugin/scripts/publish-batch.mjs batch.json --shows "${summary}"`, dir);
  assert.equal(asked.permissionDecision, "ask");
  for (const command of ["node /k/plugin/scripts/publish-batch.mjs batch.json", `node /k/plugin/scripts/publish-batch.mjs batch.json --shows "${summary.replace("AC", "BC")}"`]) {
    const denied = gate(command, dir);
    assert.equal(denied.permissionDecision, "deny", command);
    assert.match(denied.permissionDecisionReason, /refused by publish-batch: --shows .*--summary/);
  }
  assert.equal(gate("node /k/plugin/scripts/publish-batch.mjs batch.json --summary", dir), null);
  batchFile([["openproject.mjs", "preview", "d.json"]], dir);
  const bad = gate(`node /k/plugin/scripts/publish-batch.mjs batch.json --shows "x"`, dir);
  assert.equal(bad.permissionDecision, "deny");
  assert.match(bad.permissionDecisionReason, /refused by publish-batch: item 1 \(openproject\.mjs preview\) is not a write of a kit writer/);
});

test("the kit's ask rules cover a batch, so the prompt stays even if the hook fails to run", () => {
  assert.ok(KIT_PUBLISH_ASK_RULES.includes("Bash(*publish-batch.mjs*--shows*)"));
});

test("a batch item that posts PR text the chat has not shown is refused by the publish-quote gate", () => {
  const dir = tempDir("tedy-batch-quote-");
  writeFileSync(join(dir, "r.txt"), "Chỗ này đã sửa ạ.\n");
  batchFile([["github-write.mjs", "reply", "12", "PRRC_1", "--body-file", "r.txt", "--repo", "o/r"]], dir);
  const transcript = join(dir, "t.jsonl");
  const say = (text) => writeFileSync(transcript, `${JSON.stringify({ type: "assistant", timestamp: new Date(Date.now() + 60_000).toISOString(), message: { content: [{ type: "text", text }] } })}\n`);
  const command = 'node /k/plugin/scripts/publish-batch.mjs batch.json --shows "x"';
  say("something else");
  const refused = check({ tool_input: { command }, cwd: dir, transcript_path: transcript });
  assert.equal(refused.ask, false);
  assert.match(refused.reason, /missing from the chat: reply body of .*r\.txt/);
  say("```\nChỗ này đã sửa ạ.\n```");
  assert.equal(check({ tool_input: { command }, cwd: dir, transcript_path: transcript }), null);
});

test("the role gate sees each item of a batch, so a batch cannot carry another role's write", () => {
  const dir = tempDir("tedy-batch-role-");
  batchFile([["github-write.mjs", "resolve", "PRRT_1", "--repo", "o/r"], ["openproject.mjs", "comment", "1", "--body-file", "a.txt", "--apply"], ["github-write.mjs", "pr-body", "3", "--body-file", "b.md", "--repo", "o/r"]], dir);
  const kinds = classifyActions({ tool_name: "Bash", tool_input: { command: 'node /k/plugin/scripts/publish-batch.mjs batch.json --shows "x"' }, cwd: dir }, { repos: [] }).map((action) => action.kind);
  assert.deepEqual(kinds, ["pr-review", "tracker", "code"]);
});
