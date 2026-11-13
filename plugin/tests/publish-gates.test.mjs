import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../gates/git-gate.mjs";
import { prBodyRefusal } from "../lib/github-write.mjs";
import { prBodyFrom, sameComment } from "../lib/openproject.mjs";
import { check, publishes, reasonFor, unshown } from "../gates/publish-quote-gate.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";
import { ALL_GATES_ON } from "../lib/hook-io.mjs";

const mapFile = (data) => `# Project map\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;

function projects() {
  const dir = tempDir("tedy-gate-maps-");
  const root = tempDir("tedy-gate-root-");
  mkdirSync(join(root, "fe"));
  writeFileSync(join(dir, "tracked.md"), mapFile({ name: "tracked", paths: [root], repos: [{ path: "fe", role: "FE" }], tracker: { type: "openproject", project: "x" } }));
  return { dir, repo: join(root, "fe") };
}

test("a PR in a tracked project must carry OP#<id> in its body", () => {
  const { dir, repo } = projects();
  const create = (rest) => evaluate(`gh pr create --draft --base dev --title "fix: x" ${rest}`, repo, { projectsDir: dir });
  assert.equal(create('--body "OP#21453"').allow, true);
  assert.equal(create("--body=OP#21453").allow, true);
  assert.equal(create('--body ""').allow, false);
  assert.match(create('--body ""').reason, /OP#<id>/);
  assert.match(create('--body ""').reason, /No work package yet: stop, ask the user whether to run \/tedy:pm for one, and open or edit the PR once it exists\./);
  assert.doesNotMatch(create('--body ""').reason, /PM session|hand-?off/i);
  assert.equal(create("--fill").allow, false);
  assert.equal(create('--body "#21372"').allow, false);
  writeFileSync(join(repo, "body.md"), "OP#21376\n");
  assert.equal(create("--body-file body.md").allow, true);
  assert.equal(create("--body-file missing.md").allow, false);
  assert.equal(evaluate('gh pr create --draft --body ""', "/somewhere/else", { projectsDir: dir }).allow, true);
});

test("a PR the user chose to open without a work package says so with OP#none and a reason", () => {
  const { dir, repo } = projects();
  const create = (rest) => evaluate(`gh pr create --draft --base dev --title "fix: x" ${rest}`, repo, { projectsDir: dir });
  writeFileSync(join(repo, "none.md"), "OP#none: CI hotfix agreed with the tech lead\n\n## Goal\nX.\n");
  assert.equal(create("--body-file none.md").allow, true);
  writeFileSync(join(repo, "bare.md"), "OP#none:\n\n## Goal\nX.\n");
  assert.equal(create("--body-file bare.md").allow, false);
  writeFileSync(join(repo, "inline.md"), "Fixes the build, see OP#none: later\n");
  assert.equal(create("--body-file inline.md").allow, false);
  assert.match(create('--body ""').reason, /OP#none: <reason>/);
});

test("a PR body edit in a tracked project must keep OP#<id>, with ghWrites on or off", () => {
  const { dir, repo } = projects();
  for (const gates of [ALL_GATES_ON, { ...ALL_GATES_ON, ghWrites: false }]) {
    const edit = (rest) => evaluate(`gh pr edit 12 ${rest}`, repo, { projectsDir: dir, gates });
    assert.equal(edit('--body "OP#21453 updated"').allow, true);
    assert.equal(edit("--body=OP#21453").allow, true);
    assert.equal(edit('--body "no package"').allow, false);
    assert.match(edit('--body "no package"').reason, /OP#<id>/);
    writeFileSync(join(repo, "edit.md"), "OP#21376\n");
    assert.equal(edit("--body-file edit.md").allow, true);
    assert.equal(edit("--body-file missing.md").allow, false);
  }
  assert.equal(evaluate('gh pr edit 12 --body "no package"', "/somewhere/else", { projectsDir: dir }).allow, true);
});

test("attached short body flags and the last of several body flags decide the work-package check", () => {
  const { dir, repo } = projects();
  writeFileSync(join(repo, "ok.md"), "OP#21376\n");
  writeFileSync(join(repo, "no.md"), "no package\n");
  for (const gates of [ALL_GATES_ON, { ...ALL_GATES_ON, ghWrites: false }]) {
    const edit = (rest) => evaluate(`gh pr edit 12 ${rest}`, repo, { projectsDir: dir, gates }).allow;
    assert.equal(edit('-b"no package"'), false);
    assert.equal(edit("-bno"), false);
    assert.equal(edit("-Fno.md"), false);
    assert.equal(edit("-Fok.md"), true);
    assert.equal(edit('-b"OP#21453"'), true);
    assert.equal(edit('--body "OP#1" --body "no package"'), false);
    assert.equal(edit('--body "no package" --body "OP#1"'), true);
  }
  const create = (rest) => evaluate(`gh pr create --draft --base dev --title "fix: x" ${rest}`, repo, { projectsDir: dir }).allow;
  assert.equal(create('-b"OP#21453"'), true);
  assert.equal(create('--body "OP#1" --body "no package"'), false);
});

const draft = "# PR #735: comment line by line (head abc1234)\n\n## 1. `src/a.ts:10`\nc check lại chỗ này giúp e nha\n\n---\n\n## 2. `src/b.ts:4`\nđoạn này thiếu case rỗng\n";
const at = (ms) => new Date(ms).toISOString();
const say = (ms, text) => ({ type: "assistant", timestamp: at(ms), message: { content: [{ type: "text", text }] } });

test("posting needs every comment body shown to the user after the draft's last change", () => {
  const dir = tempDir("tedy-quote-");
  const file = join(dir, "review-735-line-comments.md");
  const read = (path) => (path === file ? draft : "OP reply");
  const found = publishes(`cd ${dir} && node /k/github-write.mjs post review-735-line-comments.md`, "/", read);
  assert.equal(found.length, 1);
  assert.equal(found[0].bodies.length, 2);
  const mtime = () => 1_000;
  const quoted = "> c check lại chỗ này giúp e nha\n\n> đoạn này thiếu\n> case rỗng";
  assert.deepEqual(unshown(found, [say(2_000, quoted)], mtime), []);
  assert.deepEqual(unshown(found, [say(500, quoted)], mtime).length, 2);
  assert.deepEqual(unshown(found, [say(2_000, "Đăng review PR #735 (2 comment) thế nào?")], mtime).length, 2);
  const asked = { type: "assistant", timestamp: at(2_000), message: { content: [{ type: "tool_use", name: "AskUserQuestion", input: { questions: [{ question: "Đăng?", options: [{ label: "Đăng", description: "c check lại chỗ này giúp e nha / đoạn này thiếu case rỗng" }] }] } }] } };
  assert.equal(unshown(found, [asked], mtime).length, 2);
  assert.equal(publishes(`node /k/github-write.mjs post ${file} --dry-run`, "/", read).length, 0);
  for (const verb of ["reply 1 2", "edit 5"]) assert.equal(publishes(`node /k/github-write.mjs ${verb} --body-file b.md --dry-run`, "/w", () => "ok a").length, 1, verb);
  assert.equal(publishes(`node /k/github-write.mjs post ${file} --dry-run=no`, "/", read).length, 1);
  const files = (command) => publishes(command, "/w", (path) => `body of ${path}`).map((item) => item.file);
  assert.deepEqual(files("node /k/github-write.mjs reply 1 2 --body-file a.md --body-file b.md"), ["/w/b.md"]);
  assert.deepEqual(files("node /k/github-write.mjs --repo o/r reply 1 2 --body-file b.md"), ["/w/b.md"]);
  assert.deepEqual(files("node /k/github-write.mjs reply 1 2 --body-file=b.md"), ["/w/b.md"]);
  const reply = publishes("node /k/github-write.mjs reply 735 99 --body \"đã sửa ạ.\"", "/", read);
  assert.deepEqual(unshown(reply, [say(10, "Reply: đã sửa ạ.")], mtime), []);
  assert.equal(unshown(reply, [say(10, "Reply thread 5?")], mtime).length, 1);
});

test("only reply text counts as shown, never an AskUserQuestion string, and the block reason names its layer and what is missing", () => {
  const file = "/w/review-735-line-comments.md";
  const found = publishes(`node /k/github-write.mjs post ${file}`, "/", () => draft);
  const mtime = () => 1_000;
  const block = (content) => ({ type: "assistant", timestamp: at(2_000), message: { content: [content] } });
  const ask = (option) => block({ type: "tool_use", name: "AskUserQuestion", input: { questions: [{ question: "Đăng review PR #735?", header: "Post", multiSelect: false, options: [{ label: "Đăng", description: "Đăng 2 comment", ...option }, { label: "Giữ", description: "Giữ draft" }] }] } });
  const thought = block({ type: "thinking", thinking: "c check lại chỗ này giúp e nha\nđoạn này thiếu case rỗng" });
  const missing = unshown(found, [thought, ask({})], mtime);
  assert.deepEqual(missing, [`comment 1 of ${file}`, `comment 2 of ${file}`]);
  const reason = reasonFor(missing);
  assert.ok(reason.includes(`comment 1 of ${file}, comment 2 of ${file}`), reason);
  for (const phrase of ["(publishQuote)", "nothing was written", "missing from the chat", "Only a text block of the reply", "thinking, AskUserQuestion", "verbatim", "where it goes", "permission prompt is the approval"]) assert.ok(reason.includes(phrase), phrase);
  assert.doesNotMatch(reason, /fenced block|pinned:|notice:|and the command/);
  assert.equal(unshown(found, [ask({ preview: draft })], mtime).length, 2);
  const written = block({ type: "tool_use", name: "Write", input: { file_path: file, content: draft } });
  assert.equal(unshown(found, [written, ask({})], mtime).length, 2);
});

test("the quote check asks when there is no transcript path to confirm what the user saw", () => {
  const input = { tool_name: "Bash", tool_input: { command: 'node /k/github-write.mjs reply 1 2 --body "Fixed it."' }, cwd: "/w" };
  const result = check(input);
  assert.equal(result.ask, true);
  assert.match(result.reason, /cannot read this session's transcript/);
});

test("a subagent's publish is checked against the main session's transcript, so a body quoted only in the subagent's own transcript does not pass", () => {
  const root = tempDir("tedy-quote-subagent-");
  const main = join(root, "projects", "s-cockpit.jsonl");
  const own = join(root, "projects", "s-cockpit", "subagents", "agent-a1job.jsonl");
  mkdirSync(join(root, "projects", "s-cockpit", "subagents"), { recursive: true });
  const shown = JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { content: [{ type: "text", text: "Reply: Fixed it." }] } });
  const input = (transcript_path, extra = { agent_id: "a1job", agent_type: "tedy:review" }) => ({ tool_name: "Bash", tool_input: { command: 'node /k/github-write.mjs reply 1 2 --body "Fixed it."' }, cwd: "/w", session_id: "s-cockpit", transcript_path, ...extra });
  writeFileSync(main, "");
  writeFileSync(own, `${shown}\n`);
  for (const path of [own, main]) {
    const result = check(input(path));
    assert.equal(result?.ask, false, path);
    assert.match(result.reason, /has not seen the exact text/, path);
  }
  assert.equal(check(input(own, {})), null);
  writeFileSync(main, `${shown}\n`);
  writeFileSync(own, "");
  assert.equal(check(input(own)), null);
  assert.equal(check(input(main)), null);
  const stray = join(root, "agent-a1job.jsonl");
  writeFileSync(stray, `${shown}\n`);
  const unknown = check(input(stray));
  assert.equal(unknown?.ask, true);
  assert.match(unknown.reason, /cannot read this session's transcript/);
});

test("an OpenProject comment already on the work package is refused as a duplicate", () => {
  const activities = [{ id: 1, comment: { raw: "" } }, { id: 7, comment: { raw: "Đã fix ở PR #744\n" } }];
  assert.equal(sameComment(activities, "Đã fix ở PR #744")?.id, 7);
  assert.equal(sameComment(activities, "khác"), null);
});

test("a PR body built from a work package starts with OP#<id> and records when the package was read", () => {
  const body = prBodyFrom({ id: 21453, updatedAt: "2026-10-14T07:00:00Z", subject: "[FE] Gửi USDT không hỏi duyệt", description: { raw: "## Goal\nX.\n\n## Checklist\n- [ ] Y\n" } });
  assert.match(body, /^OP#21453\n\nTask read at 2026-10-14T07:00:00Z\n\n## \[FE\] Gửi USDT không hỏi duyệt\n\n## Goal\nX\./);
  assert.ok(body.endsWith("- [ ] Y\n"));
});

test("pr-body writes only to the user's PR: a draft takes any OP-linked body, a ready PR only the unedited pr-body output for its own work package", () => {
  const draft = { number: 744, isDraft: true, author: { login: "tedy" }, body: "OP#21453\n\nold" };
  const ready = { ...draft, isDraft: false };
  assert.equal(prBodyRefusal(draft, "tedy", "OP#21453\n\nbody", null), null);
  assert.match(prBodyRefusal(draft, "tedy", "no link", null), /OP#<id>/);
  assert.match(prBodyRefusal(ready, "tedy", "no link", null), /OP#<id>/);
  assert.match(prBodyRefusal({ ...draft, author: { login: "tin" } }, "tedy", "OP#1", "1"), /belongs to tin/);
  assert.match(prBodyRefusal({ ...ready, author: { login: "tin" } }, "tedy", "OP#21453", "21453"), /belongs to tin/);
  assert.equal(prBodyRefusal(ready, "tedy", "OP#21453\n\nnew", "21453"), null);
  assert.equal(prBodyRefusal(ready, "tedy", "OP#21453\n\nhand-edited", null), "#744 is ready; its body is replaced only with the unedited output of openproject.mjs pr-body 21453");
  assert.equal(prBodyRefusal(ready, "tedy", "OP#999\n\nother", "999"), "#744 is ready and points to OP#21453, not OP#999; a ready PR keeps its work package");
  assert.equal(prBodyRefusal({ ...ready, body: "" }, "tedy", "OP#21453", "21453"), "#744 is ready and points to no work package, not OP#21453; a ready PR keeps its work package");
});

test("openproject pr-body records what it generated, so a hand-edited body is told apart", async () => {
  const { generatedPrBodyOp, recordPrBody } = await import("../lib/openproject.mjs");
  const body = prBodyFrom({ id: 21453, updatedAt: "2026-10-22T07:00:00Z", subject: "Record test", description: { raw: "goal" } });
  assert.equal(generatedPrBodyOp(body), null);
  recordPrBody(body);
  assert.equal(generatedPrBodyOp(body), "21453");
  assert.equal(generatedPrBodyOp(`${body}\n\n`), "21453");
  assert.equal(generatedPrBodyOp(body.replace("goal", "goal, edited")), null);
});

