import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { APPROVAL_TTL_MS, consumeApproval, recordApprovals } from "../lib/publish-approval-ticket.mjs";
import { stateDenyRules } from "../lib/publish-approval-settings.mjs";
import { LABELS } from "../lib/labels.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const VI = LABELS.vi;
const ACCEPTED = [VI["post.asIs"], VI["approve.all"]];
const HOOK = new URL("../scripts/publish-approval-ticket.mjs", import.meta.url).pathname;
const argv = (...args) => ["/usr/bin/node", "/k/plugin/scripts/github-write.mjs", ...args];
const REPLY = "node /k/plugin/scripts/github-write.mjs reply 1 2 --body-file b.md";

const question = (preview, text = "Đăng?", extra = {}) => ({ question: text, header: "Đăng", multiSelect: false, options: [{ label: VI["post.asIs"], description: "d", preview }, { label: VI["post.hold"], description: "n", preview: "khác" }], ...extra });
const shown = (questions, answers) => Object.fromEntries(questions.flatMap((item) => { const chosen = item.options.find((option) => option.label === answers[item.question]); return chosen?.preview ? [[item.question, { preview: chosen.preview }]] : []; }));
const hookInput = (questions, answers, annotations = shown(questions, answers), extra = {}) => ({ session_id: "s1", tool_use_id: "toolu_1", hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: { questions }, tool_response: { questions, answers, annotations, ...extra } });

function ticketWith(preview, { created = Date.now() } = {}) {
  const dir = tempDir("tedy-tickets-");
  const [id] = recordApprovals(hookInput([question(preview)], { "Đăng?": VI["post.asIs"] }), { dir, accepted: ACCEPTED, now: created });
  return { dir, id };
}

const tickets = (dir) => readdirSync(dir).filter((name) => name.endsWith(".json"));
const SETTINGS = join(tempDir("tedy-claude-settings-"), "settings.json");
writeFileSync(SETTINGS, JSON.stringify({ permissions: { deny: stateDenyRules(tmpdir()) } }));
const consume = (dir, args, texts, extra = {}) => consumeApproval(argv(...args), texts, { dir, mode: "answer", settings: SETTINGS, ...extra });

test("answer mode refuses to spend a ticket while settings lack a state deny rule, and says how to add them", () => {
  const { dir } = ticketWith(`ok a\n${REPLY}`);
  const partial = join(tempDir("tedy-claude-settings-"), "settings.json");
  writeFileSync(partial, JSON.stringify({ permissions: { deny: stateDenyRules(tmpdir()).slice(0, 2) } }));
  assert.throws(() => consume(dir, ["reply", "1", "2", "--body-file", "b.md"], ["ok a"], { settings: partial }), /lacks Edit\(\/\/.*drafts\/\*\*\) in permissions\.deny.*run node <plugin>\/scripts\/profile\.mjs publish-approval answer, then this command again\. Nothing was written\./);
  assert.throws(() => consume(dir, ["reply", "1", "2", "--body-file", "b.md"], ["ok a"], { settings: join(tempDir("tedy-none-"), "settings.json") }), /publish approval is in answer mode, but .*settings\.json: not readable as JSON/);
  assert.equal(tickets(dir).length, 1);
  assert.ok(consume(dir, ["reply", "1", "2", "--body-file", "b.md"], ["ok a"]));
});

test("the hook writes one 600 ticket per approved question, holding the chosen option's preview", () => {
  const dir = tempDir("tedy-tickets-");
  const ids = recordApprovals(hookInput([question("A\nnode x.mjs a"), question("B", "Câu 2?")], { "Đăng?": VI["post.asIs"], "Câu 2?": VI["post.hold"] }), { dir, accepted: ACCEPTED, now: 1_000 });
  assert.equal(ids.length, 1);
  const [name] = tickets(dir);
  const ticket = JSON.parse(readFileSync(join(dir, name), "utf8"));
  assert.deepEqual(ticket, { created: 1_000, session_id: "s1", tool_use_id: "toolu_1", preview: "A\nnode x.mjs a" });
  assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("the hook writes no ticket for a refusal, a typed answer, a note, a timeout, duplicate question text or a preview on another option", () => {
  for (const [name, input] of [
    ["hold", hookInput([question("A")], { "Đăng?": VI["post.hold"] })],
    ["typed", hookInput([question("A")], { "Đăng?": "ok đăng đi" })],
    ["English label", hookInput([question("A")], { "Đăng?": LABELS.en["post.asIs"] })],
    ["note", hookInput([question("A")], { "Đăng?": VI["post.asIs"] }, { "Đăng?": { preview: "A", notes: "bỏ câu 2" } })],
    ["AFK auto-resolve with the approval already picked", hookInput([question("A")], { "Đăng?": VI["post.asIs"] }, undefined, { afkTimeoutMs: 600000 })],
    ["followUp", hookInput([question("A")], { "Đăng?": VI["post.asIs"] }, undefined, { followUp: true })],
    ["freeform response", hookInput([question("A")], { "Đăng?": VI["post.asIs"] }, undefined, { response: "khoan, sửa câu 2" })],
    ["multiSelect with only the approval picked", hookInput([question("A", "Đăng?", { multiSelect: true })], { "Đăng?": VI["post.asIs"] })],
    ["annotation preview differs from the option", hookInput([question("A")], { "Đăng?": VI["post.asIs"] }, { "Đăng?": { preview: "B" } })],
    ["no annotation preview", hookInput([question("A")], { "Đăng?": VI["post.asIs"] }, {})],
    ["timeout", hookInput([question("A")], {})],
    ["duplicate question text", hookInput([question("node x.mjs reply 1 2 --body A"), question("node x.mjs reply 1 3 --body B")], { "Đăng?": VI["post.asIs"] })],
    ["no preview on the chosen option", hookInput([{ ...question("A"), options: [{ label: VI["post.asIs"], description: "d" }, { label: VI["post.hold"], description: "n", preview: "A" }] }], { "Đăng?": VI["post.asIs"] })],
    ["multiSelect with another option", hookInput([question("A", "Đăng?", { multiSelect: true })], { "Đăng?": `${VI["post.asIs"]}, ${VI["post.hold"]}` })],
    ["no tool response", { ...hookInput([question("A")], {}), tool_response: undefined }],
  ]) {
    const dir = tempDir("tedy-tickets-");
    assert.deepEqual(recordApprovals(input, { dir, accepted: ACCEPTED }), [], name);
  }
});

test("the hook entry writes tickets only in answer mode", () => {
  for (const [mode, expected] of [["answer", 1], ["ask", 0], [null, 0]]) {
    const state = tempDir("tedy-ticket-state-");
    const profile = profileWith({ gates: mode ? { publishApproval: mode } : {}, language: { chat: "vi" } });
    const run = spawnSync("node", [HOOK], { input: JSON.stringify(hookInput([question("A")], { "Đăng?": VI["post.asIs"] })), encoding: "utf8", env: { ...process.env, TEDY_STATE_DIR: state, TEDY_PROFILE_DIR: profile } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "");
    let count = 0;
    try {
      count = tickets(join(state, "approvals")).length;
    } catch {
      count = 0;
    }
    assert.equal(count, expected, String(mode));
  }
});

test("in answer mode the hook logs an AskUserQuestion that gave no ticket, with the response keys it saw", () => {
  const state = tempDir("tedy-ticket-state-");
  const profile = profileWith({ gates: { publishApproval: "answer" }, language: { chat: "vi" } });
  const run = spawnSync("node", [HOOK], { input: JSON.stringify(hookInput([question("A")], {})), encoding: "utf8", env: { ...process.env, TEDY_STATE_DIR: state, TEDY_PROFILE_DIR: profile } });
  assert.equal(run.status, 0, run.stderr);
  const entry = readFileSync(join(state, "gate-log.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((item) => item.hook === "publish-approval-ticket");
  assert.equal(entry.decision, "no-ticket");
  assert.deepEqual(entry.response_keys, ["questions", "answers", "annotations"]);
});

test("a ticket is used once, for the command line on a line of its own and every text on whole lines", () => {
  const { dir } = ticketWith(`Trả lời thread 2:\n\nok a\nthêm dòng 2\n\n${REPLY}`);
  assert.throws(() => consume(dir, ["reply", "1", "3", "--body-file", "b.md"], ["ok a"]), /no unused approval/);
  assert.throws(() => consume(dir, ["reply", "1", "2", "--body-file", "b.md"], ["ok"]), /no unused approval/);
  assert.throws(() => consume(dir, ["reply", "1", "2", "--body-file", "b.md"], ["ok a\nthêm dòng"]), /no unused approval/);
  assert.ok(consume(dir, ["reply", "1", "2", "--body-file", "b.md"], ["ok a\n  thêm   dòng 2\n"]));
  assert.equal(tickets(dir).length, 0);
  assert.throws(() => consume(dir, ["reply", "1", "2", "--body-file", "b.md"], ["ok a\nthêm dòng 2"]), /no unused approval/);
});

test("a prefix, a strict-prefix body, a dry-run line, a comment or a redirect in the line never match", () => {
  const cases = [
    ["Xoá comment\nnode /k/figma-comments.mjs delete 1234", ["/k/figma-comments.mjs", "delete", "123"], []],
    ["Looks good, except the auth bug must be fixed first\n\n" + REPLY, ["/k/github-write.mjs", "reply", "1", "2", "--body-file", "b.md"], ["Looks good"]],
    ["body one\n\nnode /k/github-write.mjs post d.md --dry-run", ["/k/github-write.mjs", "post", "d.md"], ["body one"]],
    ["body one\n\nnode /k/github-write.mjs post d.md # --dry-run", ["/k/github-write.mjs", "post", "d.md"], ["body one"]],
    ["body one\n\nnode /k/github-write.mjs post d.md > --dry-run", ["/k/github-write.mjs", "post", "d.md"], ["body one"]],
    ["body one\n\nnode /k/github-write.mjs post d.md && echo ok", ["/k/github-write.mjs", "post", "d.md"], ["body one"]],
    ["the body is in the command: node /k/github-write.mjs reply 1 2 --body ok", ["/k/github-write.mjs", "reply", "1", "2", "--body", "ok"], []],
  ];
  for (const [preview, [script, ...args], texts] of cases) {
    const { dir } = ticketWith(preview);
    assert.throws(() => consumeApproval(["node", script, ...args], texts, { dir, mode: "answer", settings: SETTINGS }), /no unused approval/, preview);
  }
});

test("the line may carry node, an absolute script path, quotes, backticks or a leading $", () => {
  for (const line of [REPLY, "`node /k/plugin/scripts/github-write.mjs reply 1 2 --body-file b.md`", "$ node github-write.mjs reply 1 2 --body-file 'b.md'", "/usr/bin/node /x/github-write.mjs reply 1 2 --body-file \"b.md\"", "github-write.mjs reply 1 2 --body-file b.md"]) {
    const { dir } = ticketWith(`ok a\n${line}`);
    assert.ok(consume(dir, ["reply", "1", "2", "--body-file", "b.md"], ["ok a"]), line);
  }
  const { dir } = ticketWith("Trả lời:\nnode /k/github-write.mjs reply 1 2 --body 'ok   a'");
  assert.throws(() => consume(dir, ["reply", "1", "2", "--body", "ok a"], []), /no unused approval/);
  assert.ok(consume(dir, ["reply", "1", "2", "--body", "ok   a"], []));
});

test("a draft changed after the approval no longer matches, and a ticket past its TTL is refused and removed", () => {
  const { dir } = ticketWith(`old body\n${REPLY}`);
  assert.throws(() => consume(dir, ["reply", "1", "2", "--body-file", "b.md"], ["new body"]), /no unused approval/);
  const stale = ticketWith(`ok a\n${REPLY}`, { created: Date.now() - APPROVAL_TTL_MS - 1_000 });
  assert.throws(() => consume(stale.dir, ["reply", "1", "2", "--body-file", "b.md"], ["ok a"]), /no unused approval/);
  assert.equal(tickets(stale.dir).length, 0);
  assert.equal(APPROVAL_TTL_MS, 30 * 60 * 1000);
});

test("ask mode checks no ticket", () => {
  const dir = tempDir("tedy-tickets-");
  assert.equal(consumeApproval(argv("reply", "1", "2", "--body-file", "b.md"), ["ok a"], { dir, mode: "ask" }), null);
});

test("two processes racing for one ticket: exactly one wins", async () => {
  const { dir } = ticketWith(`ok a\n${REPLY}`);
  const racer = join(tempDir("tedy-racer-"), "race.mjs");
  const lib = new URL("../lib/publish-approval-ticket.mjs", import.meta.url).href;
  writeFileSync(racer, `import { consumeApproval } from ${JSON.stringify(lib)};\ntry { consumeApproval(["node", "/k/github-write.mjs", "reply", "1", "2", "--body-file", "b.md"], ["ok a"], { dir: process.argv[2], mode: "answer", settings: process.argv[3] }); console.log("won"); } catch { console.log("lost"); }\n`);
  const run = promisify(execFile);
  const results = await Promise.all(Array.from({ length: 6 }, () => run("node", [racer, dir, SETTINGS]).then((result) => result.stdout.trim())));
  assert.deepEqual(results.filter((result) => result === "won").length, 1, results.join(","));
});
