import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hasRunApproval, recordRunApprovals, runApprovalsDir } from "../lib/review-run-approval.mjs";
import { LABELS } from "../lib/labels.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const EN = LABELS.en;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const HOOK = new URL("../scripts/review-run-approval.mjs", import.meta.url).pathname;
const TEXT = `PR #12 head ${SHA}: tests run all of this PR's code. Run what?`;
const question = (extra = {}) => ({ question: TEXT, header: EN["run.header"], multiSelect: false, options: [{ label: `${EN["run.lint"]} (Recommended)`, description: "d" }, { label: EN["run.all"], description: "d" }, { label: EN["run.none"], description: "d" }], ...extra });
const hookInput = (questions, answers, extra = {}) => ({ session_id: "s1", tool_use_id: "toolu_1", hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: { questions }, tool_response: { questions, answers, annotations: {}, ...extra } });
const record = (input) => {
  const dir = tempDir("tedy-review-runs-");
  return { dir, heads: recordRunApprovals(input, { dir, lang: "en", now: 1_000 }) };
};

test("an approving run answer records its head sha and scope, whichever option carried (Recommended)", () => {
  const lint = record(hookInput([question()], { [TEXT]: `${EN["run.lint"]} (Recommended)` }));
  assert.deepEqual(lint.heads, [SHA]);
  assert.ok(hasRunApproval(SHA, lint.dir));
  assert.ok(!hasRunApproval(OTHER, lint.dir));
  assert.deepEqual(JSON.parse(readFileSync(join(lint.dir, `${SHA}.json`), "utf8")), { created: 1_000, session_id: "s1", tool_use_id: "toolu_1", scope: "lint" });
  assert.equal(statSync(join(lint.dir, `${SHA}.json`)).mode & 0o777, 0o600);
  const all = record(hookInput([question()], { [TEXT]: EN["run.all"] }));
  assert.equal(JSON.parse(readFileSync(join(all.dir, `${SHA}.json`), "utf8")).scope, "all");
});

test("no run approval is recorded for run nothing, a typed answer, a note, a timeout, another header, two shas or none", () => {
  const twoShas = `heads ${SHA} and ${OTHER}`;
  for (const [name, input] of [
    ["none", hookInput([question()], { [TEXT]: EN["run.none"] })],
    ["typed", hookInput([question()], { [TEXT]: "go ahead" })],
    ["note", hookInput([question()], { [TEXT]: EN["run.all"] }, { annotations: { [TEXT]: { notes: "only lint" } } })],
    ["timeout", hookInput([question()], { [TEXT]: EN["run.all"] }, { afkTimeoutMs: 60_000 })],
    ["header", hookInput([question({ header: EN["post.header"] })], { [TEXT]: EN["run.all"] })],
    ["multi", hookInput([question({ multiSelect: true })], { [TEXT]: EN["run.all"] })],
    ["two shas", hookInput([question({ question: twoShas })], { [twoShas]: EN["run.all"] })],
    ["short sha", hookInput([question({ question: "head 0123456" })], { "head 0123456": EN["run.all"] })],
    ["label not offered", hookInput([question({ options: [{ label: EN["run.none"], description: "d" }] })], { [TEXT]: EN["run.all"] })],
  ]) {
    const { dir, heads } = record(input);
    assert.deepEqual(heads, [], name);
    assert.ok(!existsSync(dir) || readdirSync(dir).length === 0, name);
  }
});

test("the AskUserQuestion hook records a run approval in the default ask mode, under the state folder", () => {
  const state = tempDir("tedy-review-run-state-");
  const profile = profileWith({ language: { chat: "en" } });
  const hook = spawnSync("node", [HOOK], { input: JSON.stringify(hookInput([question()], { [TEXT]: EN["run.all"] })), encoding: "utf8", env: { ...process.env, TEDY_STATE_DIR: state, TEDY_PROFILE_DIR: profile } });
  assert.equal(hook.status, 0, hook.stderr);
  assert.ok(hasRunApproval(SHA, runApprovalsDir(state)));
  assert.match(readFileSync(join(state, "gate-log.jsonl"), "utf8"), /"hook":"review-run-approval","decision":"approved","heads":\["0123456789abcdef0123456789abcdef01234567"\]/);
});
