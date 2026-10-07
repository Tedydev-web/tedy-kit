import { test } from "node:test";
import assert from "node:assert/strict";
import { activeRole, decideNudge } from "./session-hooks.mjs";

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
