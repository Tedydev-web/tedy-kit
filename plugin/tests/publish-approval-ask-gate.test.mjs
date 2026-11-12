import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LABELS } from "../lib/labels.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const VI = LABELS.vi;
const GATE = new URL("../scripts/publish-approval-ask-gate.mjs", import.meta.url).pathname;
const REPLY = "node /k/plugin/scripts/github-write.mjs reply 1 2 --body-file b.md";
const PREVIEW = `ok a\nthêm dòng 2\n${REPLY}`;
const fenced = (body) => `Em sẽ đăng:\n\n\`\`\`\n${body}\n\`\`\``;
const said = (blocks) => ({ type: "assistant", message: { content: blocks } });
const text = (value) => ({ type: "text", text: value });
const thinking = { type: "thinking", thinking: "the user should approve this" };
const result = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_0", content: "ok" }] } };
const prompt = { type: "user", message: { content: "đăng giúp anh" } };
const ASK = { type: "tool_use", name: "AskUserQuestion", id: "toolu_1", input: {} };
const BASH = { type: "tool_use", name: "Bash", id: "toolu_0", input: {} };

const question = (preview, description = "d") => ({ question: "Đăng?", header: "Đăng", multiSelect: false, options: [{ label: VI["post.asIs"], description, preview }, { label: VI["post.hold"], description: "n" }] });

function gate(entries, { questions = [question(PREVIEW)], mode = "answer", extra = {}, transcript } = {}) {
  const path = transcript ?? join(tempDir("tedy-transcript-"), "session.jsonl");
  if (!transcript) writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const state = tempDir("tedy-state-");
  const profile = profileWith({ gates: { publishApproval: mode }, language: { chat: "vi" } });
  const input = { session_id: "s1", tool_use_id: "toolu_1", hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions }, transcript_path: path, ...extra };
  const run = spawnSync(process.execPath, [GATE], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, TEDY_STATE_DIR: state, TEDY_PROFILE_DIR: profile } });
  assert.equal(run.status, 0, run.stderr);
  let log = "";
  try {
    log = readFileSync(join(state, "gate-log.jsonl"), "utf8");
  } catch {
    log = "";
  }
  return { denied: run.stdout ? JSON.parse(run.stdout).hookSpecificOutput : null, log };
}

test("an approving question asked right after a tool result with only thinking between is denied with how to quote the preview", () => {
  const { denied } = gate([prompt, said([BASH]), result, said([thinking])]);
  assert.equal(denied?.permissionDecision, "deny");
  assert.equal(denied.hookEventName, "PreToolUse");
  assert.match(denied.permissionDecisionReason, /quote the whole preview verbatim in one fenced block of a reply text, then call AskUserQuestion again/);
  assert.match(denied.permissionDecisionReason, /Never switch publish approval to another mode/);
});

test("an approving question passes once the newest reply text quotes the whole preview, with or without the call in the transcript", () => {
  assert.equal(gate([prompt, said([text(fenced(PREVIEW))])]).denied, null);
  assert.equal(gate([prompt, said([text(fenced(PREVIEW))]), said([thinking])]).denied, null);
  assert.equal(gate([prompt, said([text(fenced(PREVIEW)), ASK])]).denied, null);
  assert.equal(gate([prompt, said([text(fenced(PREVIEW))]), said([ASK])]).denied, null);
});

test("the quote must be whole, the newest text, and have no tool call after it", () => {
  assert.equal(gate([prompt, said([text(fenced("ok a"))])]).denied?.permissionDecision, "deny");
  assert.equal(gate([prompt, said([text(fenced(PREVIEW))]), said([BASH]), result, said([text("Anh duyệt nhé")])]).denied?.permissionDecision, "deny");
  assert.equal(gate([prompt, said([text(fenced(PREVIEW)), BASH]), said([ASK])]).denied?.permissionDecision, "deny");
});

test("a preview held in the question's own strings needs no reply text", () => {
  assert.equal(gate([prompt, said([BASH]), result], { questions: [question(PREVIEW, PREVIEW)] }).denied, null);
});

test("the gate judges only main-thread approving questions in answer mode, and lets the call through when it cannot read the transcript", () => {
  const bare = [prompt, said([BASH]), result];
  assert.equal(gate(bare, { mode: "ask" }).denied, null);
  assert.equal(gate(bare, { extra: { agent_id: "a1", agent_type: "tedy:pm" } }).denied, null);
  assert.equal(gate(bare, { questions: [{ ...question(PREVIEW), options: [{ label: VI["post.hold"], description: "n", preview: PREVIEW }, { label: VI["post.asIs"], description: "d" }] }] }).denied, null);
  const missing = gate([], { transcript: join(tempDir("tedy-none-"), "missing.jsonl") });
  assert.equal(missing.denied, null);
  assert.match(missing.log, /"hook":"publish-approval-ask","decision":"transcript-unread"/);
});
