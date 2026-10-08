import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeRole, decideNudge, hooksLoadedSince, reloadHint } from "./session-hooks.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const prompt = (text) => ({ type: "user", entrypoint: "cli", message: { content: text } });
const say = (text) => ({ type: "assistant", entrypoint: "cli", message: { content: [{ type: "text", text }] } });
const use = (name, input = {}) => ({ type: "assistant", entrypoint: "cli", message: { content: [{ type: "tool_use", name, input }] } });
const result = (text) => ({ type: "user", entrypoint: "cli", message: { content: [{ type: "tool_result", content: text }] } });

test("nudges when the turn ends with a prose question", () => {
  const entries = [prompt("review PR 12"), say("Em đã xong nháp. Anh muốn em đăng các góp ý này lên #656 không?")];
  assert.equal(decideNudge(entries, false).nudge, true);
});

test("nudges on numbered decision lists that end with a question mark", () => {
  const entries = [prompt("x"), say("1. Giữ câu tuyệt đối hay lấy hunk 7?\n2. Rule comment có sửa không?")];
  assert.equal(decideNudge(entries, false).nudge, true);
});

test("reads the reply from the hook input, because the transcript does not hold it yet when Stop fires", () => {
  const entries = [prompt("đổi tên hằng số")];
  assert.equal(decideNudge(entries, false).why, "no-text");
  assert.equal(decideNudge(entries, false, "Anh muốn em đổi tên hằng số thành MAX_WALLET_NAME_LENGTH không?").nudge, true);
  assert.equal(decideNudge(entries, false, "Đã đổi tên và chạy test xanh.").nudge, false);
});

test("does not nudge twice for the same stop", () => {
  assert.equal(decideNudge([prompt("x"), say("Anh chọn cách nào?")], true).nudge, false);
});

test("does not nudge when the turn already asked through AskUserQuestion, including timeouts", () => {
  const entries = [prompt("x"), use("AskUserQuestion", { questions: [] }), result("No response after 600s"), say("Quyết định đang chờ: anh chọn sau nhé?")];
  assert.equal(decideNudge(entries, false).nudge, false);
});

test("ignores question marks inside code fences and quoted drafts", () => {
  const entries = [prompt("x"), say("Bản nháp:\n> Nút đang là \"Ask the family\" ạ?\n```ts\nconst ok = a ? b : c;\n```\nĐã lưu file nháp.")];
  assert.equal(decideNudge(entries, false).nudge, false);
});

test("does not nudge a plain statement", () => {
  assert.equal(decideNudge([prompt("x"), say("Đã push nhánh và CI xanh.")], false).nudge, false);
});

test("skips non-interactive sessions", () => {
  const entries = [{ ...prompt("x"), entrypoint: "sdk-cli" }, { ...say("Anh muốn tiếp không?"), entrypoint: "sdk-cli" }];
  assert.equal(decideNudge(entries, false).nudge, false);
});

test("only the current turn counts", () => {
  const entries = [prompt("a"), use("AskUserQuestion"), say("ok"), prompt("b"), say("Anh muốn em làm tiếp không?")];
  assert.equal(decideNudge(entries, false).nudge, true);
});

test("activeRole returns the last tedy skill invoked", () => {
  const entries = [use("Skill", { skill: "ak:plan" }), use("Skill", { skill: "tedy:review-pr" }), use("Skill", { skill: "caveman:caveman" })];
  assert.equal(activeRole(entries), "tedy:review-pr");
  assert.equal(activeRole([use("Skill", { skill: "ak:plan" })]), null);
});

test("the session-start notice lists pending hand-offs with their target, and stays silent when none wait", async () => {
  const { pendingNotice } = await import("./session-hooks.mjs");
  assert.equal(pendingNotice([], "/p/handoff.md"), "");
  const notice = pendingNotice([{ to: "Dev TMA - Shop", from: "PM - Shop", title: "Fix the fake save toast", path: "/w/plans/reports/handoff-1.md" }], "/p/handoff.md");
  assert.match(notice, /- to Dev TMA - Shop: Fix the fake save toast \(from PM - Shop\) \/w\/plans\/reports\/handoff-1\.md/);
  assert.match(notice, /ListAgents prints this session's name/);
});

const line = (timestamp, extra) => JSON.stringify({ timestamp, ...extra });
const startup = (timestamp, kind = "startup") => line(timestamp, { type: "attachment", attachment: { type: "hook_success", hookName: `SessionStart:${kind}` } });
const reload = (timestamp) => line(timestamp, { type: "user", message: { content: "<command-name>/reload-plugins</command-name>\n<command-message>reload-plugins</command-message>" } });
const work = (timestamp) => line(timestamp, { type: "assistant", message: { content: [{ type: "text", text: "x".repeat(40) }] } });
const compact = (timestamp) => startup(timestamp, "compact");
const changedAt = Date.parse("2026-10-08T04:38:00Z");

function transcript(lines) {
  const path = join(tempDir("tedy-reload-"), "t.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

test("a session started, resumed or reloaded after hooks.json changed has the current hooks", () => {
  assert.equal(hooksLoadedSince(transcript([startup("2026-10-08T01:00:00Z"), work("2026-10-08T04:40:00Z"), startup("2026-10-08T06:56:00Z", "resume"), work("2026-10-08T07:00:00Z")]), changedAt), true);
  assert.equal(hooksLoadedSince(transcript([startup("2026-10-08T01:00:00Z"), reload("2026-10-08T05:00:00Z"), compact("2026-10-08T07:31:00Z")]), changedAt), true);
  assert.equal(hooksLoadedSince(transcript([startup("2026-10-08T05:00:00Z", "fork"), work("2026-10-08T05:01:00Z")]), changedAt), true);
});

test("a compaction is not a reload, so a session last loaded before the change still runs the old hooks", () => {
  const path = transcript([startup("2026-10-08T01:00:00Z"), reload("2026-10-08T03:04:00Z"), work("2026-10-08T05:00:00Z"), compact("2026-10-08T07:31:00Z"), work("2026-10-08T07:33:00Z")]);
  assert.equal(hooksLoadedSince(path, changedAt), false);
  assert.match(reloadHint(path, changedAt), /\/reload-plugins/);
  assert.match(reloadHint(path, changedAt), /2026-10-08T04:38:00\.000Z/);
});

test("the scan reads the transcript backwards in chunks and finds a marker that straddles a chunk boundary", () => {
  const lines = [startup("2026-10-08T01:00:00Z"), startup("2026-10-08T05:00:00Z", "resume"), ...Array.from({ length: 50 }, (_, index) => work(`2026-10-08T06:${String(index).padStart(2, "0")}:00Z`))];
  for (const chunk of [7, 64, 333]) assert.equal(hooksLoadedSince(transcript(lines), changedAt, chunk), true);
  assert.equal(hooksLoadedSince(transcript(lines.slice(2)), changedAt, 64), false);
});

test("no hint when the transcript is missing or the hooks did not change after the last load", () => {
  assert.equal(reloadHint(undefined, changedAt), "");
  assert.equal(reloadHint("/nonexistent/t.jsonl", changedAt), "");
  assert.equal(reloadHint(transcript([startup("2026-10-08T05:00:00Z"), compact("2026-10-08T07:31:00Z")]), changedAt), "");
});

test("a broken profile config is announced at session start, a valid or missing one is not", async () => {
  const { configWarning } = await import("./session-hooks.mjs");
  assert.equal(configWarning(profileWith({ gates: { noComments: true } })), "");
  assert.equal(configWarning(tempDir("tedy-profile-none-")), "");
  assert.match(configWarning(profileWith({ gates: { noComments: "on" } })), /config\.json.*gates\.noComments must be a boolean.*every personal gate stays on/s);
});
