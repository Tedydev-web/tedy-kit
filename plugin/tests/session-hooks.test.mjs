import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeRole, decideNudge, hooksLoadedSince, reloadHint } from "../lib/session-hooks.mjs";
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
  const { pendingNotice } = await import("../lib/session-hooks.mjs");
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
  const { configWarning } = await import("../lib/session-hooks.mjs");
  assert.equal(configWarning(profileWith({ gates: { noComments: true } })), "");
  assert.equal(configWarning(join(tempDir("tedy-profile-none-"), "missing")), "");
  const empty = tempDir("tedy-profile-empty-");
  assert.match(configWarning(empty), /config\.json.*every personal gate is off/s);
  writeFileSync(join(empty, "rules.md"), "# rules\n");
  assert.match(configWarning(empty), /config\.json.*every personal gate is on/s);
  assert.match(configWarning(profileWith({ gates: { noComments: "on" } })), /config\.json.*gates\.noComments must be a boolean.*every personal gate stays on/s);
});

test("the learn line appears on an interactive startup once enough feedback waits, at most once a day and not on a held day", async () => {
  const { learnNotice, LEARN_THRESHOLD } = await import("../lib/session-hooks.mjs");
  const base = { feedbackNewer: LEARN_THRESHOLD, since: "2026-10-07", source: "startup", entrypoint: "cli", today: "2026-10-18", nudged: undefined, held: undefined };
  assert.match(learnNotice(base), /^5 feedback memories since the last \/tedy:learn \(2026-10-07\)\. Tell the user in this reply: run \/tedy:learn/);
  assert.equal(learnNotice({ ...base, feedbackNewer: LEARN_THRESHOLD - 1 }), "");
  assert.equal(learnNotice({ ...base, source: "resume" }), "");
  assert.equal(learnNotice({ ...base, entrypoint: "sdk-cli" }), "");
  assert.notEqual(learnNotice({ ...base, entrypoint: undefined }), "");
  assert.equal(learnNotice({ ...base, nudged: "2026-10-18" }), "");
  assert.equal(learnNotice({ ...base, held: "2026-10-18" }), "");
  assert.notEqual(learnNotice({ ...base, nudged: "2026-10-17", held: "2026-10-17" }), "");
  assert.match(learnNotice({ ...base, since: "" }), /\(never\)/);
});

async function learnHookFixture({ memories = 5, type = "feedback" } = {}) {
  const { spawnSync } = await import("node:child_process");
  const { chmodSync, mkdirSync, readFileSync, existsSync } = await import("node:fs");
  const { projectSlug } = await import("../lib/memory-stats.mjs");
  const scratch = tempDir("tedy-learn-hook-");
  const home = join(scratch, "home");
  const profile = join(scratch, "profile");
  const state = join(scratch, "state");
  const work = join(scratch, "work");
  const bin = join(scratch, "bin");
  const memory = join(home, ".claude", "projects", projectSlug(work), "memory");
  for (const dir of [join(profile, "projects"), work, bin, memory]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(profile, "config.json"), "{}");
  writeFileSync(join(profile, "projects", "shop.md"), `# map\n\n\`\`\`json\n${JSON.stringify({ name: "shop", paths: [work] })}\n\`\`\`\n`);
  for (let index = 0; index < memories; index += 1) writeFileSync(join(memory, `f${index}.md`), type ? `---\nname: f\nmetadata:\n  type: ${type}\n---\n\nx\n` : "no frontmatter\n");
  writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '[]'\n");
  chmodSync(join(bin, "claude"), 0o755);
  const hook = (source, env = {}) => spawnSync("node", [new URL("../scripts/session-hooks.mjs", import.meta.url).pathname, "pending-handoffs"], {
    input: JSON.stringify({ cwd: work, source, session_id: "s-1" }),
    encoding: "utf8",
    env: { ...process.env, HOME: home, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_PROJECT_DIR_NAME: "", ...env },
  });
  const stateFile = join(state, "projects", "shop.json");
  return {
    work,
    stateFile,
    hook,
    nudged: () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")).learn_nudged : undefined),
    log: () => (existsSync(join(state, "gate-log.jsonl")) ? readFileSync(join(state, "gate-log.jsonl"), "utf8") : ""),
  };
}

test("the session-start hook shows the learn line to the user, records the day, and stays quiet for a resume", async () => {
  const fixture = await learnHookFixture();
  assert.doesNotMatch(fixture.hook("resume").stdout, /feedback memories/);
  const started = JSON.parse(fixture.hook("startup").stdout);
  assert.match(started.systemMessage, /5 feedback memories since the last \/tedy:learn \(never\)/);
  assert.match(started.hookSpecificOutput.additionalContext, /Tell the user in this reply: run \/tedy:learn/);
  assert.match(fixture.nudged(), /^\d{4}-\d{2}-\d{2}$/);
  assert.doesNotMatch(fixture.hook("startup").stdout, /feedback memories/);
});

test("the day is recorded only after the notice was written, so a failing hook does not use up the nudge", async () => {
  const { mkdirSync } = await import("node:fs");
  const fixture = await learnHookFixture();
  mkdirSync(join(fixture.work, "plans"), { recursive: true });
  writeFileSync(join(fixture.work, "plans", "reports"), "not a folder");
  assert.equal(fixture.hook("startup").stdout, "");
  assert.equal(fixture.nudged(), undefined);
  assert.match(fixture.log(), /"decision":"skip-on-error"/);
});

test("a broken learn state is logged and the other notices still print", async () => {
  const { mkdirSync } = await import("node:fs");
  const fixture = await learnHookFixture();
  mkdirSync(join(fixture.stateFile, ".."), { recursive: true });
  writeFileSync(fixture.stateFile, "{ not json");
  mkdirSync(join(fixture.work, "plans", "drafts"), { recursive: true });
  writeFileSync(join(fixture.work, "plans", "drafts", "reply.md"), "draft\n");
  const output = JSON.parse(fixture.hook("startup").stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /Waiting on the user in this project/);
  assert.equal(output.systemMessage, undefined);
  assert.match(fixture.log(), /"decision":"learn-notice-skipped"/);
});

test("memories with no recognised type are logged as format drift, project-only memories are not, and a moved memory folder is reported", async () => {
  const drift = await learnHookFixture({ type: null });
  drift.hook("startup");
  assert.match(drift.log(), /"decision":"learn-notice-format-drift"/);
  const projectOnly = await learnHookFixture({ type: "project" });
  projectOnly.hook("startup");
  assert.doesNotMatch(projectOnly.log(), /format-drift/);
  const moved = await learnHookFixture();
  assert.doesNotMatch(moved.hook("startup", { CLAUDE_CODE_PROJECT_DIR_NAME: "elsewhere" }).stdout, /feedback memories/);
  assert.match(moved.log(), /"decision":"learn-notice-unsupported-layout"/);
});
