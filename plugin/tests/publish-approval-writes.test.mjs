import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeOpenProject, world } from "./fake-services-for-tests.mjs";
import { renderDocComment, renderRollbackItem, renderWorkPackageDraft } from "../lib/publish-approval-render.mjs";
import { ledgerPath } from "../lib/record-lock.mjs";

const HEAD = "abc1234" + "0".repeat(33);
const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -9,2 +10,2 @@\n context line\n+added line\n";
const DRAFT = "# PR #701: comment line by line (head abc1234)\n\n## 1. `src/a.ts:10`\nThe label is wrong.\n";
const DESCRIPTION = "## Goal\nShow the pop-up when a 4th vault is started on Pro.\n\n## Checklist\n- [ ] Show the pop-up.\n\n## AC\n- [ ] On Pro, a 4th vault cannot be started.";
const TASK = { slug: "task-fe-a", type: "Task", subject: "[FE] Vault limit pop-up on Pro", description: DESCRIPTION, estimate: 1 };
const CREATE = { action: "create", id: null };
const ITEM = { group: "A", epic: "09", where: "UC_SW_13 BR1", quote: "Crypto takes the price in USDT", comment: "Which wallet pays the fee?" };
const TAB = "Crypto takes the price in USDT and the fee in GRAM from the payer\n";
const DOCUMENT = { tabs: [{ tabProperties: { tabId: "t.1" }, documentTab: { body: { content: [{ paragraph: { elements: [{ startIndex: 1, textRun: { content: TAB } }] } }] } } }] };

async function lint(w, script, args) {
  const result = await w.run(script, args);
  assert.equal(result.code, 0, result.out);
  return result.out.split("\n").filter((line) => line.startsWith("warning: ")).map((line) => `${line}\n`).join("");
}

async function onceOnly(w, script, args, preview, count, keys = []) {
  const lines = () => keys.map((key) => w.ledger(key).length);
  const before = lines();
  const refused = await w.run(script, args);
  assert.notEqual(refused.code, 0, refused.out);
  assert.match(refused.out, /no unused approval matches this write/, refused.out);
  assert.equal(count(), 0, `${script} ${args.join(" ")} wrote without a ticket`);
  w.approve(preview(w.line(script, args)));
  const first = await w.run(script, args);
  assert.ok(count() > 0, `${script} ${args.join(" ")} did not write with a ticket: ${first.out}`);
  const written = count();
  assert.deepEqual(lines(), before.map((length) => length + 1), `${script} ${args.join(" ")} did not append one ledger line per record: ${keys.join(", ")}`);
  await w.run(script, args);
  assert.equal(count(), written, `${script} ${args.join(" ")} wrote twice on one ticket`);
  assert.deepEqual(lines(), before.map((length) => length + 1), `${script} ${args.join(" ")} appended to the ledger without writing`);
}

async function heldRefuses(w, script, args, preview, key, count) {
  w.approve(preview(w.line(script, args)));
  w.holdRecord(key);
  const before = count();
  const refused = await w.run(script, args);
  assert.equal(refused.code, 1, refused.out);
  assert.ok(refused.out.includes(`refused: ${key} is being written by pid ${process.pid} (held by the test) since 2026-11-05T01:00:00.000Z; nothing was written and the approval is unused.`), refused.out);
  assert.equal(count(), before, `${script} ${args.join(" ")} wrote through a held lock`);
  assert.equal(w.tickets(), 1);
  assert.deepEqual(w.ledger(key), []);
}

function prWorld(gh) {
  const w = world({ pr: 701, gh });
  const head = w.checkout.pr(701);
  return { w, head, draft: DRAFT.replaceAll("abc1234", head.slice(0, 7)) };
}

test("github-write post, edit and minimize write only with a ticket, once", async () => {
  const { w: post, draft } = prWorld({ diff: DIFF, reviewComments: [{ id: 1, path: "src/a.ts", line: 10, side: "RIGHT", commit_id: HEAD }] });
  post.file("d.md", draft);
  const postWarnings = await lint(post, "draft-lint", ["pr-comment", "d.md", "--repo", "o/r"]);
  await onceOnly(post, "github-write", ["post", "d.md", "--repo", "o/r"], (line) => `${draft}\n${postWarnings}${line}`, () => post.writes().length, ["github:o/r#701"]);
  const edit = world({ pr: 1, gh: { write: { id: 5, html_url: "u", body: "Fixed it." } } });
  edit.file("b.md", "Fixed it.\n");
  const editWarnings = await lint(edit, "draft-lint", ["pr-reply", "b.md", "--pr", "1", "--repo", "o/r"]);
  await onceOnly(edit, "github-write", ["edit", "5", "--body-file", "b.md", "--repo", "o/r"], (line) => `Fixed it.\n${editWarnings}${line}`, () => edit.writes().length, ["github:o/r#1"]);
  const minimize = world({ gh: { graphql: { data: { minimizeComment: { minimizedComment: { isMinimized: true } } } } } });
  await onceOnly(minimize, "github-write", ["minimize", "IC_x"], (line) => line, () => minimize.writes().length, ["github:node:IC_x"]);
});

test("github-write pr-body, resolve and unresolve write only with a ticket, once", async () => {
  const prBody = world({ gh: { write: { id: 5, html_url: "u", body: "Fixed it." }, prView: { number: 3, isDraft: true, author: { login: "me" }, body: "old" } } });
  prBody.file("p.md", "OP#21298\n\nTask read now\n");
  await onceOnly(prBody, "github-write", ["pr-body", "3", "--body-file", "p.md", "--repo", "X/Y"], (line) => `OP#21298\nTask read now\n${line}`, () => prBody.writes().length, ["github:x/y#3"]);
  assert.ok(prBody.writes().every((line) => line.includes("repos/X/Y/pulls/3")), prBody.writes().join("\n"));
  const threads = world({ gh: { graphql: { data: { resolveReviewThread: { thread: { isResolved: true } }, unresolveReviewThread: { thread: { isResolved: false } } } } } });
  await onceOnly(threads, "github-write", ["resolve", "PRRT_a", "PRRT_b"], (line) => line, () => threads.writes().length, ["github:node:PRRT_a", "github:node:PRRT_b"]);
  assert.equal(threads.writes().length, 2);
  const unresolve = world({ gh: { graphql: { data: { unresolveReviewThread: { thread: { isResolved: false } } } } } });
  await onceOnly(unresolve, "github-write", ["unresolve", "PRRT_a"], (line) => line, () => unresolve.writes().length, ["github:node:PRRT_a"]);
});

test("github-write reply writes only with a ticket, once, and records the job it names by its file name", async () => {
  const w = world({ pr: 1, gh: { write: { id: 5, html_url: "u" } } });
  w.file("b.md", "Fixed it.\n");
  const warnings = await lint(w, "draft-lint", ["pr-reply", "b.md", "--pr", "1", "--repo", "o/r"]);
  await onceOnly(w, "github-write", ["reply", "1", "123", "--body-file", "b.md", "--repo", "o/r", "--job", "plans/jobs/reply.md"], (line) => `Fixed it.\n${warnings}${line}`, () => w.writes().length, ["github:o/r#1"]);
  assert.equal(w.ledger("github:o/r#1")[0].job, "reply.md");
});

test("every writer refuses a --job with no file, placed last or written --job=, before it writes", async () => {
  const cases = [
    ["github-write", ["minimize", "IC_x"]],
    ["openproject", ["set", "21298", "--status", "Closed", "--apply"]],
    ["figma-comments", ["post", "1:2", "--body-file", "f.md", "--file", "F"]],
    ["gdoc-comments", ["reply", "c1", "--body-file", "g.md", "--doc", "D"]],
    ["doc-comment-file", ["post", "items.json", "--html", "x.html", "--doc", "D", "--apply"]],
  ];
  for (const [script, args] of cases) {
    for (const job of ["--job", "--job="]) {
      const w = world();
      const result = await w.run(script, [...args, job]);
      assert.equal(result.code, 1, result.out);
      assert.ok(result.out.includes(`${script}: --job needs a job file path; nothing was written`), `${script} ${job}: ${result.out}`);
      assert.deepEqual(w.writes(), []);
    }
  }
});

test("a write whose ledger line cannot be appended still reads back and exits 0, with a warning", async () => {
  const w = world({ gh: { graphql: { data: { minimizeComment: { minimizedComment: { isMinimized: true } } } } } });
  mkdirSync(ledgerPath("github:node:IC_x", join(w.dir, "state")), { recursive: true });
  const args = ["minimize", "IC_x"];
  w.approve(w.line("github-write", args));
  const result = await w.run("github-write", args);
  assert.equal(result.code, 0, result.out);
  assert.equal(w.writes().length, 1);
  assert.match(result.out, /warning: written, but the ledger line for github:node:IC_x could not be appended/);
});

test("openproject apply, set, relation, relation-delete, comment, comment-edit and rollback write only with a ticket, once", async () => {
  const op = await fakeOpenProject();
  try {
    const w = world({ opUrl: op.url });
    const key = (kind, id) => `op:${new URL(op.url).host.replace(/:/g, "_")}:${kind}:${id}`;
    const count = () => op.calls.length;
    const reset = () => (op.calls.length = 0);
    w.file("drafts.json", JSON.stringify([TASK]));
    await w.run("openproject", ["preview", "drafts.json", "--project", "183"]);
    reset();
    await onceOnly(w, "openproject", ["apply", "drafts.json", "--project", "183"], (line) => `${renderWorkPackageDraft(TASK, CREATE)}\n${line}`, count, [key("project", 183)]);
    reset();
    await onceOnly(w, "openproject", ["rollback", "--project", "183", "--apply"], (line) => `${renderRollbackItem({ id: 30000, subject: TASK.subject })}\n${line}`, count, [key("project", 183), key("wp", 30000)]);
    reset();
    await onceOnly(w, "openproject", ["set", "21298", "--status", "In progress", "--apply", "--lock", "0"], (line) => line, count, [key("wp", 21298)]);
    reset();
    w.file("c.md", "The pop-up needs the Pro price.\n");
    await lint(w, "openproject", ["comment", "21298", "--body-file", "c.md"]);
    reset();
    await onceOnly(w, "openproject", ["comment", "21298", "--apply", "--body-file", "c.md"], (line) => `The pop-up needs the Pro price.\n${line}`, count, [key("wp", 21298)]);
    reset();
    w.file("e.md", "The pop-up needs the Pro price, monthly.\n");
    await lint(w, "openproject", ["comment-edit", "9", "--body-file", "e.md"]);
    reset();
    await onceOnly(w, "openproject", ["comment-edit", "9", "--apply", "--body-file", "e.md"], (line) => `The pop-up needs the Pro price, monthly.\n${line}`, count, [key("activity", 9)]);
    reset();
    await onceOnly(w, "openproject", ["relation", "21298", "21300", "--type", "blocks", "--apply"], (line) => line, count, [key("wp", 21298), key("wp", 21300)]);
    reset();
    const created = op.calls.length;
    const relation = world({ opUrl: op.url });
    await onceOnly(relation, "openproject", ["relation-delete", "2000", "--apply"], (line) => line, () => op.calls.length - created, [key("relation", 2000)]);
  } finally {
    op.server.close();
  }
});

test("openproject comment --apply refuses while another writer holds its work package, and spends nothing", async () => {
  const op = await fakeOpenProject();
  try {
    const w = world({ opUrl: op.url });
    w.file("c.md", "The pop-up needs the Pro price.\n");
    await lint(w, "openproject", ["comment", "21298", "--body-file", "c.md"]);
    op.calls.length = 0;
    await heldRefuses(w, "openproject", ["comment", "21298", "--apply", "--body-file", "c.md"], (line) => `The pop-up needs the Pro price.\n${line}`, `op:${new URL(op.url).host.replace(/:/g, "_")}:wp:21298`, () => op.calls.length);
  } finally {
    op.server.close();
  }
});

test("figma post and reply write only with a ticket, once", async () => {
  const w = world({ web: { figma: [{ id: "100", message: "Root question", user: { handle: "lam" }, created_at: "2026-10-01T00:00:00Z", client_meta: { node_id: "1:2" } }] } });
  w.file("f.md", "@lam Màn này thiếu trạng thái rỗng.\n");
  const postWarnings = await lint(w, "draft-lint", ["figma-comment", "f.md", "--file", "F"]);
  await onceOnly(w, "figma-comments", ["post", "1:2", "--body-file", "f.md", "--file", "F"], (line) => `@lam Màn này thiếu trạng thái rỗng.\n${postWarnings}${line}`, () => w.writes().length, ["figma:F"]);
  const reply = world({ web: { figma: [{ id: "100", message: "Root question", user: { handle: "lam" }, created_at: "2026-10-01T00:00:00Z", client_meta: { node_id: "1:2" } }] } });
  reply.file("f.md", "@lam Đã thêm trạng thái rỗng.\n");
  const replyWarnings = await lint(reply, "draft-lint", ["figma-comment", "f.md", "--file", "F"]);
  await onceOnly(reply, "figma-comments", ["reply", "100", "--body-file", "f.md", "--file", "F"], (line) => `@lam Đã thêm trạng thái rỗng.\n${replyWarnings}${line}`, () => reply.writes().length, ["figma:F"]);
});

test("figma delete writes only with a ticket, once, and post refuses while another writer holds the file", async () => {
  const own = { id: "100", message: "Own question", user: { handle: "me" }, created_at: "2026-10-01T00:00:00Z", client_meta: { node_id: "1:2" } };
  const w = world({ web: { figma: [own] } });
  await onceOnly(w, "figma-comments", ["delete", "100", "--file", "F"], (line) => line, () => w.writes().length, ["figma:F"]);
  const held = world({ web: { figma: [] } });
  held.file("f.md", "@lam Màn này thiếu trạng thái rỗng.\n");
  const warnings = await lint(held, "draft-lint", ["figma-comment", "f.md", "--file", "F"]);
  await heldRefuses(held, "figma-comments", ["post", "1:2", "--body-file", "f.md", "--file", "F"], (line) => `@lam Màn này thiếu trạng thái rỗng.\n${warnings}${line}`, "figma:F", () => held.writes().length);
});

test("gdoc reply, anchor, edit and delete write only with a ticket, once", async () => {
  const thread = { id: "c1", content: "Which wallet?", resolved: false, author: { me: false, displayName: "PM" }, replies: [], createdTime: "2026-10-01T00:00:00Z" };
  const own = { id: "c2", content: "Old question?", resolved: false, author: { me: true, displayName: "me" }, replies: [], createdTime: "2026-10-01T00:00:00Z" };
  const body = "Which wallet pays the fee?";
  for (const [command, args] of [
    ["reply", ["reply", "c1", "--body-file", "g.md", "--doc", "D"]],
    ["anchor", ["anchor", "--tab", "t.1", "--quote", "Crypto takes the price in USDT", "--body-file", "g.md", "--doc", "D"]],
    ["edit", ["edit", "c2", "--body-file", "g.md", "--doc", "D"]],
    ["delete", ["delete", "c2", "--doc", "D"]],
  ]) {
    const w = world({ web: { drive: [thread, own], document: DOCUMENT } });
    w.file("g.md", `${body}\n`);
    const warnings = await lint(w, "draft-lint", ["doc-comment", "g.md", "--doc", "D"]);
    await onceOnly(w, "gdoc-comments", args, (line) => (command === "delete" ? line : `${body}\n${warnings}${line}`), () => w.writes().length, ["gdoc:D"]);
  }
});

test("gdoc reply refuses while another writer holds the Doc, and spends nothing", async () => {
  const thread = { id: "c1", content: "Which wallet?", resolved: false, author: { me: false, displayName: "PM" }, replies: [], createdTime: "2026-10-01T00:00:00Z" };
  const w = world({ web: { drive: [thread], document: DOCUMENT } });
  w.file("g.md", "Which wallet pays the fee?\n");
  const warnings = await lint(w, "draft-lint", ["doc-comment", "g.md", "--doc", "D"]);
  await heldRefuses(w, "gdoc-comments", ["reply", "c1", "--body-file", "g.md", "--doc", "D"], (line) => `Which wallet pays the fee?\n${warnings}${line}`, "gdoc:D", () => w.writes().length);
});

test("doc-comment-file post --apply writes only with a ticket, once", async () => {
  const w = world({ web: { tabs: { "t.1": TAB }, document: DOCUMENT }, map: { name: "p", repos: [{ path: ".", role: "FE" }], language: { pr_review: "en", doc_figma: "en" }, prd: { doc: "D", tabs: { "09": { tab: "t.1" } } } } });
  w.file("items.json", JSON.stringify({ title: "PRD", items: [ITEM] }));
  const warnings = await lint(w, "doc-comment-file", ["items.json"]);
  await onceOnly(w, "doc-comment-file", ["post", "items.json", "--html", "out.html", "--apply", "--doc", "D"], (line) => `${renderDocComment(ITEM, "t.1")}\n${warnings}${line}`, () => w.writes().length, ["gdoc:D"]);
});

test("doc-comment-file post --apply refuses while gdoc-comments holds the same Doc, and a batch that fails at item 2 keeps item 1 and its ledger line", async () => {
  const map = { name: "p", repos: [{ path: ".", role: "FE" }], language: { pr_review: "en", doc_figma: "en" }, prd: { doc: "D", tabs: { "09": { tab: "t.1" } } } };
  const args = ["post", "items.json", "--html", "out.html", "--apply", "--doc", "D"];
  const held = world({ web: { tabs: { "t.1": TAB }, document: DOCUMENT }, map });
  held.file("items.json", JSON.stringify({ title: "PRD", items: [ITEM] }));
  const heldWarnings = await lint(held, "doc-comment-file", ["items.json"]);
  await heldRefuses(held, "doc-comment-file", args, (line) => `${renderDocComment(ITEM, "t.1")}\n${heldWarnings}${line}`, "gdoc:D", () => held.writes().length);
  const second = { ...ITEM, where: "UC_SW_13 BR2", quote: "the fee in GRAM from the payer", comment: "Who pays the GRAM fee?" };
  const w = world({ web: { tabs: { "t.1": TAB }, document: DOCUMENT, docsInsertLimit: 1 }, map });
  w.file("items.json", JSON.stringify({ title: "PRD", items: [ITEM, second] }));
  const warnings = await lint(w, "doc-comment-file", ["items.json"]);
  w.approve(`${renderDocComment(ITEM, "t.1")}\n${renderDocComment(second, "t.1")}\n${warnings}${w.line("doc-comment-file", args)}`);
  const failed = await w.run("doc-comment-file", args);
  assert.notEqual(failed.code, 0, failed.out);
  assert.match(failed.out, /returned HTTP 500/);
  const items = JSON.parse(readFileSync(join(w.dir, "items.json"), "utf8")).items;
  assert.equal(typeof items[0].posted?.id, "string", JSON.stringify(items));
  assert.equal(items[1].posted, undefined);
  assert.equal(w.ledger("gdoc:D").length, 1);
});

test("a post ticket binds the PR, head, path and line, not only the comment text", async () => {
  const { w, draft } = prWorld({ diff: DIFF, reviewComments: [{ id: 1, path: "src/a.ts", line: 10, side: "RIGHT", commit_id: HEAD }] });
  w.file("d.md", draft);
  await lint(w, "draft-lint", ["pr-comment", "d.md", "--repo", "o/r"]);
  const args = ["post", "d.md", "--repo", "o/r"];
  w.approve(`${draft.replace("src/a.ts:10", "src/b.ts:4")}\n${w.line("github-write", args)}`);
  const moved = await w.run("github-write", args);
  assert.match(moved.out, /no unused approval/);
  w.approve(`The label is wrong.\n${w.line("github-write", args)}`);
  assert.match((await w.run("github-write", args)).out, /no unused approval/);
  assert.deepEqual(w.writes(), []);
});

test("a run refused before it writes leaves its ticket unused", async () => {
  const { w: post, head, draft } = prWorld({ diff: "diff --git a/other.ts b/other.ts\n--- a/other.ts\n+++ b/other.ts\n@@ -1,1 +1,1 @@\n+x\n" });
  post.file("d.md", draft);
  post.file("pr.diff", DIFF);
  const warnings = await lint(post, "draft-lint", ["pr-comment", "d.md", "--diff", "pr.diff", "--repo", "o/r"]);
  const args = ["post", "d.md", "--repo", "o/r"];
  post.approve(`${draft}\n${warnings}${post.line("github-write", args)}`);
  assert.notEqual((await post.run("github-write", args)).code, 0);
  assert.equal(post.tickets(), 1);
  post.file("gh.json", JSON.stringify({ diff: DIFF, head, reviewComments: [{ id: 1, path: "src/a.ts", line: 10, side: "RIGHT", commit_id: HEAD }] }));
  await post.run("github-write", args);
  assert.equal(post.writes().length, 1);
  assert.equal(post.tickets(), 0);

  const anchor = world({ web: { drive: [], document: DOCUMENT } });
  anchor.file("g.md", "Which wallet pays the fee?\n");
  await lint(anchor, "draft-lint", ["doc-comment", "g.md", "--doc", "D"]);
  const anchorArgs = ["anchor", "--tab", "t.1", "--quote", "a passage not in the tab", "--body-file", "g.md", "--doc", "D"];
  anchor.approve(`Which wallet pays the fee?\n${anchor.line("gdoc-comments", anchorArgs)}`);
  assert.match((await anchor.run("gdoc-comments", anchorArgs)).out, /quote not found/);
  assert.equal(anchor.tickets(), 1);

  const op = await fakeOpenProject({ closedStatus: false });
  try {
    const w = world({ opUrl: op.url });
    w.file("drafts.json", JSON.stringify([TASK]));
    await w.run("openproject", ["preview", "drafts.json", "--project", "183"]);
    w.approve(`${renderWorkPackageDraft(TASK, CREATE)}\n${w.line("openproject", ["apply", "drafts.json", "--project", "183"])}`);
    await w.run("openproject", ["apply", "drafts.json", "--project", "183"]);
    const rollback = ["rollback", "--project", "183", "--apply"];
    w.approve(`${renderRollbackItem({ id: 30000, subject: TASK.subject })}\n${w.line("openproject", rollback)}`);
    assert.match((await w.run("openproject", rollback)).out, /no closed status/);
    assert.equal(w.tickets(), 1);
  } finally {
    op.server.close();
  }
});

test("the rendered approval lines name every field a write sends", () => {
  const full = { slug: "task-fe-b", id: 21298, type: "Task", subject: "[FE] Màn rỗng", status: "In progress", priority: "High", assignee: "Hoàng Lâm", startDate: "2026-10-23", dueDate: "2026-10-24", estimate: 1.5, parent: 21270, relates: [21294, 21295], blocks: [], fields: { Environment: "Dev" }, description: "## Goal\nShow it." };
  assert.equal(renderWorkPackageDraft(full, { action: "update", id: 21298 }), ["task task-fe-b", "action update #21298", "id: 21298", "type: Task", "subject: [FE] Màn rỗng", "status: In progress", "priority: High", "assignee: Hoàng Lâm", "start: 2026-10-23", "due: 2026-10-24", "estimate: 1.5", "parent: 21270", "relates: 21294, 21295", "fields: {\"Environment\":\"Dev\"}", "description:", "## Goal", "Show it."].join("\n"));
  assert.match(renderWorkPackageDraft(TASK, CREATE), /^task task-fe-a\naction create\n/);
  assert.match(renderWorkPackageDraft({ ...TASK, merge: 21000 }, { action: "merge", id: 21000 }), /^task task-fe-a\naction merge #21000\n/);
  assert.equal(renderRollbackItem({ id: 30000, subject: "[FE] x" }), "#30000 [FE] x");
  assert.equal(renderDocComment(ITEM, "t.1"), "EPIC 09 · tab t.1 · UC_SW_13 BR1\nquote: Crypto takes the price in USDT\nWhich wallet pays the fee?");
});

test("apply, rollback and doc-comment-file tickets need the rendered lines, which their previews print", async () => {
  const op = await fakeOpenProject();
  try {
    const w = world({ opUrl: op.url });
    w.file("drafts.json", JSON.stringify([{ ...TASK, assignee: "Hoàng Lâm" }]));
    const preview = await w.run("openproject", ["preview", "drafts.json", "--project", "183"]);
    assert.ok(preview.out.includes(`approval lines:\n${renderWorkPackageDraft({ ...TASK, assignee: "Hoàng Lâm" }, CREATE)}`), preview.out);
    assert.match(preview.out, /approval lines:\ntask task-fe-a\naction create\n/);
    w.approve(`${renderWorkPackageDraft({ ...TASK, assignee: "Hoàng Lâm" }, CREATE).replace("action create\n", "")}\n${w.line("openproject", ["apply", "drafts.json", "--project", "183"])}`, "Q0?");
    const apply = ["apply", "drafts.json", "--project", "183"];
    w.approve(`${TASK.subject}\n${DESCRIPTION}\n${w.line("openproject", apply)}`);
    w.approve(`${renderWorkPackageDraft(TASK, CREATE)}\n${w.line("openproject", apply)}`, "Q2?");
    assert.match((await w.run("openproject", apply)).out, /no unused approval/);
    w.approve(`${renderWorkPackageDraft({ ...TASK, assignee: "Hoàng Lâm" }, CREATE)}\n${w.line("openproject", apply)}`, "Q3?");
    assert.match((await w.run("openproject", apply)).out, /verified 1\/1/);
    const rollback = ["rollback", "--project", "183", "--apply"];
    assert.ok((await w.run("openproject", ["rollback", "--project", "183"])).out.includes(`approval lines:\n${renderRollbackItem({ id: 30000, subject: TASK.subject })}`));
    w.approve(w.line("openproject", rollback), "Q4?");
    assert.match((await w.run("openproject", rollback)).out, /no unused approval/);
  } finally {
    op.server.close();
  }
  const doc = world({ web: { tabs: { "t.1": TAB }, document: DOCUMENT }, map: { name: "p", repos: [{ path: ".", role: "FE" }], language: { pr_review: "en", doc_figma: "en" }, prd: { doc: "D", tabs: { "09": { tab: "t.1" } } } } });
  doc.file("items.json", JSON.stringify({ title: "PRD", items: [ITEM] }));
  await lint(doc, "doc-comment-file", ["items.json"]);
  const args = ["post", "items.json", "--html", "out.html", "--apply", "--doc", "D"];
  assert.ok((await doc.run("doc-comment-file", ["post", "items.json", "--html", "out.html"])).out.includes(`approval lines:\n${renderDocComment(ITEM, "t.1")}`));
  doc.approve(`${ITEM.comment}\n${doc.line("doc-comment-file", args)}`);
  doc.approve(`${renderDocComment({ ...ITEM, quote: "Crypto takes the price" }, "t.1")}\n${doc.line("doc-comment-file", args)}`, "Q2?");
  assert.match((await doc.run("doc-comment-file", args)).out, /no unused approval/);
  assert.deepEqual(doc.writes(), []);
});

test("in answer mode a write whose target would come from the cwd or the map must name it on the command line", async () => {
  const gh = world({ gh: { write: { id: 5, html_url: "u", body: "Fixed it." } } });
  gh.file("b.md", "Fixed it.\n");
  for (const args of [["edit", "5", "--body-file", "b.md"], ["reply", "1", "2", "--body-file", "b.md"], ["pr-body", "3", "--body-file", "b.md"]]) {
    gh.approve(`Fixed it.\n${gh.line("github-write", args)}`);
    assert.match((await gh.run("github-write", args)).out, /name the write target with --repo/, args.join(" "));
  }
  assert.deepEqual(gh.writes(), []);
  const figma = world({ web: { figma: [{ id: "100", message: "Root", user: { handle: "me" }, created_at: "2026-10-01T00:00:00Z" }] }, map: { name: "p", repos: [{ path: ".", role: "FE" }], language: { pr_review: "en", doc_figma: "en" }, figma: { file: "F" }, prd: { doc: "D", tabs: { "09": { tab: "t.1" } } } } });
  figma.file("f.md", "@lam Màn này thiếu trạng thái rỗng.\n");
  for (const args of [["post", "1:2", "--body-file", "f.md"], ["delete", "100"]]) assert.match((await figma.run("figma-comments", args)).out, /name the write target with --file/, args.join(" "));
  figma.file("g.md", "Which wallet pays the fee?\n");
  for (const args of [["reply", "c1", "--body-file", "g.md"], ["delete", "c2"]]) assert.match((await figma.run("gdoc-comments", args)).out, /name the write target with --doc/, args.join(" "));
  assert.deepEqual(figma.writes(), []);
  const op = await fakeOpenProject();
  try {
    const w = world({ opUrl: op.url, map: { name: "p", repos: [{ path: ".", role: "FE" }], language: { pr_review: "en", doc_figma: "en" }, tracker: { type: "openproject", project: "183" } } });
    w.file("drafts.json", JSON.stringify([TASK]));
    await w.run("openproject", ["preview", "drafts.json"]);
    w.approve(`${renderWorkPackageDraft(TASK, CREATE)}\n${w.line("openproject", ["apply", "drafts.json"])}`);
    assert.match((await w.run("openproject", ["apply", "drafts.json"])).out, /name the write target with --project/);
    assert.match((await w.run("openproject", ["rollback", "--apply"])).out, /name the write target with --project/);
    assert.deepEqual(op.calls, []);
  } finally {
    op.server.close();
  }
  const doc = world({ web: { tabs: { "t.1": TAB }, document: DOCUMENT }, map: { name: "p", repos: [{ path: ".", role: "FE" }], language: { pr_review: "en", doc_figma: "en" }, prd: { doc: "D", tabs: { "09": { tab: "t.1" } } } } });
  doc.file("items.json", JSON.stringify({ title: "PRD", items: [ITEM] }));
  for (const args of [["post", "items.json", "--html", "out.html", "--apply"], ["post", "items.json", "--html", "out.html", "--apply", "--doc", "OTHER"]]) {
    doc.approve(`${renderDocComment(ITEM, "t.1")}\n${doc.line("doc-comment-file", args)}`);
    assert.match((await doc.run("doc-comment-file", args)).out, /name the write target with --doc/, args.join(" "));
  }
  assert.deepEqual(doc.writes(), []);
});

test("doc-comment-file finds every quote in the Doc before it spends the ticket", async () => {
  const otherDocument = { tabs: [{ tabProperties: { tabId: "t.1" }, documentTab: { body: { content: [{ paragraph: { elements: [{ startIndex: 1, textRun: { content: "A different paragraph\n" } }] } }] } } }] };
  const doc = world({ web: { tabs: { "t.1": TAB }, document: otherDocument }, map: { name: "p", repos: [{ path: ".", role: "FE" }], language: { pr_review: "en", doc_figma: "en" }, prd: { doc: "D", tabs: { "09": { tab: "t.1" } } } } });
  doc.file("items.json", JSON.stringify({ title: "PRD", items: [ITEM] }));
  await lint(doc, "doc-comment-file", ["items.json"]);
  const args = ["post", "items.json", "--html", "out.html", "--apply", "--doc", "D"];
  doc.approve(`${renderDocComment(ITEM, "t.1")}\n${doc.line("doc-comment-file", args)}`);
  assert.match((await doc.run("doc-comment-file", args)).out, /quote not found/);
  assert.equal(doc.tickets(), 1);
  assert.deepEqual(doc.writes(), []);
});

test("a null field the payload still sends shows in the approval lines", async () => {
  const { buildPayload } = await import("../lib/openproject-client.mjs");
  const draft = { slug: "s", type: "Task", subject: "x", description: "d", estimate: null, parent: null };
  assert.equal(buildPayload(draft, { types: { task: "/api/v3/types/1" }, assignees: [] }).estimatedTime, "PT0H");
  const lines = renderWorkPackageDraft(draft, { action: "create" }).split("\n");
  assert.ok(lines.includes("estimate: null"), lines.join("\n"));
  assert.ok(lines.includes("parent: null"), lines.join("\n"));
});

test("in answer mode a real dry run of post or pr-body needs no --repo and spends nothing", async () => {
  const { w: post, draft } = prWorld({ diff: DIFF });
  post.file("d.md", draft);
  await lint(post, "draft-lint", ["pr-comment", "d.md"]);
  const dry = await post.run("github-write", ["post", "d.md", "--dry-run"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /WRITE → o\/r#701/);
  assert.match((await post.run("github-write", ["post", "d.md"])).out, /name the write target with --repo/);
  const prBody = world({ gh: { prView: { number: 3, isDraft: true, author: { login: "me" }, body: "old" } } });
  prBody.file("p.md", "OP#21298\n\nTask read now\n");
  const dryBody = await prBody.run("github-write", ["pr-body", "3", "--body-file", "p.md", "--dry-run"]);
  assert.equal(dryBody.code, 0, dryBody.out);
  assert.deepEqual([...post.writes(), ...prBody.writes()], []);
});
