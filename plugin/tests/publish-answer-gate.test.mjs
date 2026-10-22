import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { needs } from "../gates/publish-answer-gate.mjs";
import { KIT_PUBLISH_ASK_RULES } from "../lib/publish-approval-settings.mjs";
import { LABELS } from "../lib/labels.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const GATE_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "../gates/git-gate.mjs");
const VI = LABELS.vi;
const QUESTION = "Đăng review PR #735 (2 comment)?";
const DRAFT = "# PR #735: comment line by line (head abc1234)\n\n## 1. `src/a.ts:10`\nc check lại chỗ này giúp e nha\n\n---\n\n## 2. `src/b.ts:4`\nđoạn này thiếu case rỗng\n";
const NOW = Date.now();
const at = (ms) => new Date(ms).toISOString();

function settingsWith(rules) {
  const file = join(tempDir("tedy-settings-"), "settings.json");
  writeFileSync(file, JSON.stringify({ permissions: { ask: rules } }));
  return file;
}

const prompt = (ms) => ({ type: "user", timestamp: at(ms), message: { content: "đăng review đi e" } });
const asked = (ms, options, id = "toolu_1", question = QUESTION) => ({ type: "assistant", timestamp: at(ms), message: { content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions: [{ question, header: VI["post.header"], options, multiSelect: false }] } }] } });
const answered = (ms, answers, { id = "toolu_1", annotations = {}, content = "Your questions have been answered.", extra = {} } = {}) => ({ type: "user", timestamp: at(ms), message: { content: [{ type: "tool_result", tool_use_id: id, content }] }, toolUseResult: { questions: [], answers, annotations, ...extra } });
const postOptions = (preview = `${DRAFT}\n${POST}`, hold = undefined) => [
  { label: VI["post.asIs"], description: "Đăng 2 comment", ...(preview === null ? {} : { preview }) },
  { label: VI["post.hold"], description: "Chưa đăng", ...(hold === undefined ? {} : { preview: hold }) },
];

function workspace(entries, { draftAt = NOW - 30_000 } = {}) {
  const dir = tempDir("tedy-answer-");
  const draft = join(dir, "d.md");
  writeFileSync(draft, DRAFT);
  utimesSync(draft, new Date(draftAt), new Date(draftAt));
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { dir, transcript };
}

function runGate(command, { dir, transcript }, { mode = "answer", rules = [], extraEnv = {} } = {}) {
  const gates = mode ? { publishApproval: mode } : {};
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: dir, ...(transcript ? { transcript_path: transcript } : {}) });
  const env = { ...process.env, TEDY_STATE_DIR: tempDir("tedy-state-"), TEDY_CLAUDE_SETTINGS: settingsWith(rules), TEDY_PROFILE_DIR: profileWith({ gates, language: { chat: "vi" } }), ...extraEnv };
  const out = execFileSync("node", [GATE_ENTRY], { input, encoding: "utf8", env });
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

const POST = "node /k/github-write.mjs post d.md";
const approvedTurn = (options = postOptions(), answers = { [QUESTION]: VI["post.asIs"] }, annotations = {}) => [prompt(NOW - 60_000), asked(NOW - 20_000, options), answered(NOW - 19_000, answers, { annotations })];

test("answer mode allows a publish after an approved AskUserQuestion whose chosen preview holds the draft verbatim", () => {
  const result = runGate(POST, workspace(approvedTurn()));
  assert.equal(result?.permissionDecision, "allow");
});

test("answer mode denies, never asks, when the approval is missing, refused, stale, noted, timed out or not verbatim", () => {
  const cases = [
    ["no answer", [prompt(NOW - 60_000), asked(NOW - 20_000, postOptions())]],
    ["not an approval label", approvedTurn(postOptions(), { [QUESTION]: VI["post.hold"] })],
    ["free text", approvedTurn(postOptions(), { [QUESTION]: "ok đăng đi" })],
    ["English label in a Vietnamese chat", approvedTurn(postOptions(), { [QUESTION]: LABELS.en["post.asIs"] })],
    ["preview not verbatim", approvedTurn(postOptions(`${DRAFT.replace("rỗng", "null")}\n${POST}`))],
    ["preview only on the option not chosen", approvedTurn(postOptions(null, `${DRAFT}\n${POST}`))],
    ["note on the approval", approvedTurn(postOptions(), { [QUESTION]: VI["post.asIs"] }, { [QUESTION]: { notes: "bỏ câu 2" } })],
    ["timeout", [prompt(NOW - 60_000), asked(NOW - 20_000, postOptions()), answered(NOW - 19_000, {}, { content: "No response after 600s — the user may be away from keyboard.", extra: { afkTimeoutMs: 600_000 } })]],
    ["approval in an earlier turn", [...approvedTurn(), prompt(NOW - 10_000)]],
    ["approval before a prompt with an image", [...approvedTurn(), { type: "user", timestamp: at(NOW - 10_000), message: { content: [{ type: "text", text: "khoan, đừng đăng" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] } }]],
    ["approval only in a request blob", [prompt(NOW - 60_000), asked(NOW - 20_000, postOptions()), { ...answered(NOW - 19_000, { [QUESTION]: VI["post.asIs"] }), type: "api-request-blob" }]],
  ];
  for (const [name, entries] of cases) {
    const result = runGate(POST, workspace(entries));
    assert.equal(result?.permissionDecision, "deny", name);
    assert.match(result.permissionDecisionReason, /AskUserQuestion/, name);
    assert.match(result.permissionDecisionReason, /comment [12] of .*d\.md/, name);
  }
});

test("the approving preview must hold the exact command together with the body", () => {
  const bodyOnly = runGate(POST, workspace(approvedTurn(postOptions(DRAFT))));
  assert.equal(bodyOnly?.permissionDecision, "deny");
  assert.ok(bodyOnly.permissionDecisionReason.includes(`the command \`${POST}\``), bodyOnly.permissionDecisionReason);
  const question2 = "Câu hỏi 2?";
  const split = [prompt(NOW - 60_000), asked(NOW - 20_000, postOptions(DRAFT)), answered(NOW - 19_000, { [QUESTION]: VI["post.asIs"] }), asked(NOW - 18_000, postOptions(POST), "toolu_9", question2), answered(NOW - 17_000, { [question2]: VI["post.asIs"] }, { id: "toolu_9" })];
  assert.equal(runGate(POST, workspace(split))?.permissionDecision, "deny");
});

test("one approval covers one publish call: not another command, not a rerun after it ran", () => {
  const reply = "node /k/github-write.mjs reply 1 2 --body-file b.md";
  const question = "Trả lời?";
  const approve = (ms, id) => [asked(ms, [{ label: VI["post.asIs"], description: "x", preview: `ok a\n\n${reply}` }, { label: VI["post.hold"], description: "n" }], id, question), answered(ms + 500, { [question]: VI["post.asIs"] }, { id })];
  const ran = (ms, id, content = "posted reply 77") => [{ type: "assistant", timestamp: at(ms), message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: reply } }] } }, { type: "user", timestamp: at(ms + 500), message: { content: [{ type: "tool_result", tool_use_id: id, content }] } }];
  const ws = (entries) => {
    const made = workspace(entries);
    writeFileSync(join(made.dir, "b.md"), "ok a\n");
    utimesSync(join(made.dir, "b.md"), new Date(NOW - 50_000), new Date(NOW - 50_000));
    return made;
  };
  const once = ws([prompt(NOW - 60_000), ...approve(NOW - 20_000, "toolu_a")]);
  assert.equal(runGate(reply, once)?.permissionDecision, "allow");
  for (const other of ["node /k/github-write.mjs reply 999 888 --body-file b.md", "node /k/github-write.mjs edit 4242 --body-file b.md", "node /k/figma-comments.mjs post 9:9 --body-file b.md", "node /k/gdoc-comments.mjs reply AAA --body-file b.md"]) {
    assert.equal(runGate(other, once)?.permissionDecision, "deny", other);
  }
  assert.equal(runGate(reply, ws([prompt(NOW - 60_000), ...approve(NOW - 20_000, "toolu_a"), ...ran(NOW - 15_000, "toolu_b")]))?.permissionDecision, "deny");
  assert.equal(runGate(reply, ws([prompt(NOW - 60_000), ...approve(NOW - 20_000, "toolu_a"), ...ran(NOW - 15_000, "toolu_b", "PreToolUse:Bash hook error: tedy gate: no")]))?.permissionDecision, "allow");
  assert.equal(runGate(reply, ws([prompt(NOW - 60_000), ...approve(NOW - 25_000, "toolu_a"), ...ran(NOW - 22_000, "toolu_b"), ...approve(NOW - 10_000, "toolu_c")]))?.permissionDecision, "allow");
});

test("a draft changed after the approval is denied", () => {
  const result = runGate(POST, workspace(approvedTurn(), { draftAt: NOW - 5_000 }));
  assert.equal(result?.permissionDecision, "deny");
});

test("without a transcript answer mode denies a publish", () => {
  const { dir } = workspace(approvedTurn());
  const result = runGate(POST, { dir });
  assert.equal(result?.permissionDecision, "deny");
  assert.match(result.permissionDecisionReason, /transcript/);
});

test("a draftless publish needs the verbatim command in the approving preview", () => {
  const command = "node /k/openproject.mjs set 21298 --status Closed --apply --lock 7";
  const question = "Đóng #21298?";
  const turn = (preview) => [prompt(NOW - 60_000), asked(NOW - 20_000, [{ label: VI["approve.all"], description: "Đóng", preview }, { label: VI["approve.hold"], description: "Chưa" }], "toolu_2", question), answered(NOW - 19_000, { [question]: VI["approve.all"] }, { id: "toolu_2" })];
  assert.equal(runGate(command, workspace(turn(`#21298 New → Closed\n\n${command}`)))?.permissionDecision, "allow");
  const denied = runGate(command, workspace(turn("#21298 New → Closed")));
  assert.equal(denied?.permissionDecision, "deny");
  assert.ok(denied.permissionDecisionReason.includes(command), denied.permissionDecisionReason);
  for (const draftless of ["node /k/openproject.mjs relation 1 2 --type blocks --apply", "node /k/figma-comments.mjs delete 99", "node /k/github-write.mjs resolve PRRT_x"]) {
    assert.equal(runGate(draftless, workspace(turn(`#21298 New → Closed\n\n${command}`)))?.permissionDecision, "deny", draftless);
  }
});

test("a body-file publish needs the body verbatim, and approve.all counts as an approval", () => {
  const ws = workspace([]);
  writeFileSync(join(ws.dir, "b.md"), "Màn này thiếu trạng thái rỗng ạ?\n");
  utimesSync(join(ws.dir, "b.md"), new Date(NOW - 30_000), new Date(NOW - 30_000));
  const question = "Đăng 1 comment Figma?";
  const entries = [prompt(NOW - 60_000), asked(NOW - 20_000, [{ label: VI["approve.all"], description: "Đăng", preview: "1. Màn này thiếu trạng thái rỗng ạ?\n\nnode /k/figma-comments.mjs post 1:2 --body-file b.md" }, { label: VI["approve.hold"], description: "Chưa" }], "toolu_3", question), answered(NOW - 19_000, { [question]: VI["approve.all"] }, { id: "toolu_3" })];
  writeFileSync(ws.transcript, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  assert.equal(runGate("node /k/figma-comments.mjs post 1:2 --body-file b.md", ws)?.permissionDecision, "allow");
  assert.equal(runGate("cd / && node /k/figma-comments.mjs post 1:2 --body-file b.md", ws)?.permissionDecision, "deny");
});

test("a publish that shares its command with anything but cd is denied in answer mode", () => {
  for (const command of [`${POST} && echo ok`, `${POST}; git push origin main`, `timeout 60 ${POST}`]) {
    const result = runGate(command, workspace(approvedTurn()));
    assert.equal(result?.permissionDecision, "deny", command);
  }
  assert.equal(runGate(`cd . && ${POST}`, workspace(approvedTurn()))?.permissionDecision, "allow");
  for (const command of ["grep x y; node /k/github-write.mjs reply 1 2 --body-file missing.md", "echo x; node /k/github-write.mjs reply 1 2 --body-file missing.md"]) {
    const result = runGate(command, workspace([prompt(NOW - 60_000)]));
    assert.equal(result?.permissionDecision, "deny", command);
    assert.match(result.permissionDecisionReason, /of its own/, command);
  }
  const missing = runGate("node /k/github-write.mjs reply 1 2 --body-file missing.md", workspace([prompt(NOW - 60_000)]));
  assert.equal(missing?.permissionDecision, "deny");
  assert.match(missing.permissionDecisionReason, /could not check this publish command.*ENOENT/);
});

test("ask mode is unchanged: a covered publish passes to the ask rule, an uncovered one asks", () => {
  const ws = workspace(approvedTurn());
  for (const mode of ["ask", null]) {
    assert.equal(runGate(POST, ws, { mode, rules: KIT_PUBLISH_ASK_RULES }), null, String(mode));
    const uncovered = runGate(POST, ws, { mode });
    assert.equal(uncovered?.permissionDecision, "ask", String(mode));
    assert.match(uncovered.permissionDecisionReason, /no permission rule covers/);
  }
});

test("answer mode skips the uncovered-publish ask and denies an unapproved publish instead", () => {
  const result = runGate(POST, workspace([prompt(NOW - 60_000)]));
  assert.equal(result?.permissionDecision, "deny");
  assert.doesNotMatch(result.permissionDecisionReason, /no permission rule covers/);
});

test("gh pr merge still asks in answer mode, and a plain command gets no decision", () => {
  const ws = workspace(approvedTurn());
  const merge = runGate("gh pr merge 12", ws);
  assert.equal(merge?.permissionDecision, "ask");
  assert.match(merge.permissionDecisionReason, /belongs to the user/);
  assert.equal(runGate("git status", ws), null);
  assert.equal(runGate(`${POST} --dry-run`, ws), null);
});

test("openproject apply needs every draft's subject and description, not just the command", () => {
  const command = "node /k/openproject.mjs apply drafts.json";
  const question = "Tạo 1 task?";
  const ws = workspace([]);
  writeFileSync(join(ws.dir, "drafts.json"), JSON.stringify([{ slug: "a", subject: "[FE] Pop-up giới hạn", description: "## Goal\nhiện pop-up khi hết lượt" }]));
  utimesSync(join(ws.dir, "drafts.json"), new Date(NOW - 30_000), new Date(NOW - 30_000));
  const turn = (preview) => [prompt(NOW - 60_000), asked(NOW - 20_000, [{ label: VI["approve.all"], description: "Tạo", preview }, { label: VI["approve.hold"], description: "Chưa" }], "toolu_4", question), answered(NOW - 19_000, { [question]: VI["approve.all"] }, { id: "toolu_4" })];
  const gate = (preview) => {
    writeFileSync(ws.transcript, turn(preview).map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return runGate(command, ws);
  };
  const denied = gate(`Tạo 1 task\n\n${command}`);
  assert.equal(denied?.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /subject of draft 1 of .*drafts\.json/);
  assert.equal(gate(`1. [FE] Pop-up giới hạn\n\n## Goal\nhiện pop-up khi hết lượt\n\n${command}`)?.permissionDecision, "allow");
});

test("--dry-run skips the approval only on post and pr-body, and only as a bare flag", () => {
  const ws = workspace([prompt(NOW - 60_000)]);
  writeFileSync(join(ws.dir, "b.md"), "ok a\n");
  for (const command of [
    "node /k/github-write.mjs reply 1 2 --body-file b.md --dry-run",
    "node /k/github-write.mjs edit 5 --body-file b.md --dry-run",
    "node /k/github-write.mjs resolve PRRT_x --dry-run",
    "node /k/github-write.mjs unresolve PRRT_x --dry-run",
    "node /k/github-write.mjs minimize IC_x --dry-run",
    "node /k/github-write.mjs reply 1 2 --body-file b.md --dry-run=no",
    "node /k/github-write.mjs post d.md --dry-run=no",
  ]) assert.equal(runGate(command, ws)?.permissionDecision, "deny", command);
  for (const command of ["node /k/github-write.mjs pr-body 3 --body-file b.md --dry-run", `${POST} --dry-run`]) assert.equal(runGate(command, ws), null, command);
});

test("the required texts are every body that goes out, then the command itself", () => {
  const dir = tempDir("tedy-needs-");
  const files = {
    [join(dir, "d.md")]: DRAFT,
    [join(dir, "items.json")]: JSON.stringify({ items: [{ comment: " đã đăng ", posted: { id: "x" } }, { comment: "  Câu này hỏi lại PM ạ  " }] }),
    [join(dir, "b.md")]: "trả lời\n",
    [join(dir, "drafts.json")]: JSON.stringify([{ slug: "a", subject: "[FE] Pop-up giới hạn", description: "## Goal\nhiện pop-up" }, { slug: "b", id: 21298, subject: "[FE] Màn rỗng" }]),
  };
  const read = (file) => files[file];
  const texts = (command) => needs(command, dir, read)?.texts.map((item) => item.text);
  const check = (command, bodies) => assert.deepEqual(texts(command), [...bodies, command], command);
  check("node /k/github-write.mjs post d.md", ["c check lại chỗ này giúp e nha", "đoạn này thiếu case rỗng"]);
  check("node /k/doc-comment-file.mjs post items.json --html x.html --apply", ["Câu này hỏi lại PM ạ"]);
  check("node /k/gdoc-comments.mjs anchor --tab t.1 --quote 'x y' --body-file b.md", ["trả lời\n"]);
  check("node /k/github-write.mjs reply 1 2 --body 'ok a'", ["ok a"]);
  check("node /k/openproject.mjs apply drafts.json", ["[FE] Pop-up giới hạn", "## Goal\nhiện pop-up", "[FE] Màn rỗng"]);
  check("node /k/github-write.mjs resolve PRRT_x", []);
  assert.deepEqual(needs("node /k/openproject.mjs apply drafts.json", dir, read).files, [join(dir, "drafts.json")]);
  assert.equal(needs("node /k/github-write.mjs post d.md --dry-run", dir, read), null);
});
