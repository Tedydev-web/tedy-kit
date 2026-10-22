import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeOpenProject, world } from "./fake-services-for-tests.mjs";
import { renderDocComment, renderRollbackItem, renderWorkPackageDraft } from "../lib/publish-approval-render.mjs";

const HEAD = "abc1234" + "0".repeat(33);
const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -9,2 +10,2 @@\n context line\n+added line\n";
const DRAFT = "# PR #701: comment line by line (head abc1234)\n\n## 1. `src/a.ts:10`\nThe label is wrong.\n";
const DESCRIPTION = "## Goal\nShow the pop-up when a 4th vault is started on Pro.\n\n## Checklist\n- [ ] Show the pop-up.\n\n## AC\n- [ ] On Pro, a 4th vault cannot be started.";
const TASK = { slug: "task-fe-a", type: "Task", subject: "[FE] Vault limit pop-up on Pro", description: DESCRIPTION, estimate: 1 };
const ITEM = { group: "A", epic: "09", where: "UC_SW_13 BR1", quote: "Crypto takes the price in USDT", comment: "Which wallet pays the fee?" };
const TAB = "Crypto takes the price in USDT and the fee in GRAM from the payer\n";
const DOCUMENT = { tabs: [{ tabProperties: { tabId: "t.1" }, documentTab: { body: { content: [{ paragraph: { elements: [{ startIndex: 1, textRun: { content: TAB } }] } }] } } }] };

async function onceOnly(w, script, args, preview, count) {
  const refused = await w.run(script, args);
  assert.notEqual(refused.code, 0, refused.out);
  assert.match(refused.out, /no unused approval matches this write/, refused.out);
  assert.equal(count(), 0, `${script} ${args.join(" ")} wrote without a ticket`);
  w.approve(preview(w.line(script, args)));
  const first = await w.run(script, args);
  assert.ok(count() > 0, `${script} ${args.join(" ")} did not write with a ticket: ${first.out}`);
  const written = count();
  await w.run(script, args);
  assert.equal(count(), written, `${script} ${args.join(" ")} wrote twice on one ticket`);
}

test("github-write post, edit and minimize write only with a ticket, once", async () => {
  const post = world({ gh: { diff: DIFF, head: HEAD, reviewComments: [{ id: 1, path: "src/a.ts", line: 10, side: "RIGHT", commit_id: HEAD }] } });
  post.file("d.md", DRAFT);
  await onceOnly(post, "github-write", ["post", "d.md", "--repo", "o/r"], (line) => `${DRAFT}\n${line}`, () => post.writes().length);
  const edit = world({ gh: { write: { id: 5, html_url: "u", body: "Fixed it." } } });
  edit.file("b.md", "Fixed it.\n");
  await onceOnly(edit, "github-write", ["edit", "5", "--body-file", "b.md", "--repo", "o/r"], (line) => `Fixed it.\n${line}`, () => edit.writes().length);
  const minimize = world({ gh: { graphql: { data: { minimizeComment: { minimizedComment: { isMinimized: true } } } } } });
  await onceOnly(minimize, "github-write", ["minimize", "IC_x"], (line) => line, () => minimize.writes().length);
});

test("openproject apply, set, relation, relation-delete, comment, comment-edit and rollback write only with a ticket, once", async () => {
  const op = await fakeOpenProject();
  try {
    const w = world({ opUrl: op.url });
    const count = () => op.calls.length;
    const reset = () => (op.calls.length = 0);
    w.file("drafts.json", JSON.stringify([TASK]));
    await w.run("openproject", ["preview", "drafts.json", "--project", "183"]);
    reset();
    await onceOnly(w, "openproject", ["apply", "drafts.json", "--project", "183"], (line) => `${renderWorkPackageDraft(TASK)}\n${line}`, count);
    reset();
    await onceOnly(w, "openproject", ["rollback", "--project", "183", "--apply"], (line) => `${renderRollbackItem({ id: 30000, subject: TASK.subject })}\n${line}`, count);
    reset();
    await onceOnly(w, "openproject", ["set", "21298", "--status", "In progress", "--apply", "--lock", "0"], (line) => line, count);
    reset();
    w.file("c.md", "The pop-up needs the Pro price.\n");
    await onceOnly(w, "openproject", ["comment", "21298", "--apply", "--body-file", "c.md"], (line) => `The pop-up needs the Pro price.\n${line}`, count);
    reset();
    w.file("e.md", "The pop-up needs the Pro price, monthly.\n");
    await onceOnly(w, "openproject", ["comment-edit", "9", "--apply", "--body-file", "e.md"], (line) => `The pop-up needs the Pro price, monthly.\n${line}`, count);
    reset();
    await onceOnly(w, "openproject", ["relation", "21298", "21300", "--type", "blocks", "--apply"], (line) => line, count);
    reset();
    const created = op.calls.length;
    const relation = world({ opUrl: op.url });
    await onceOnly(relation, "openproject", ["relation-delete", "2000", "--apply"], (line) => line, () => op.calls.length - created);
  } finally {
    op.server.close();
  }
});

test("figma post and reply write only with a ticket, once", async () => {
  const w = world({ web: { figma: [{ id: "100", message: "Root question", user: { handle: "lam" }, created_at: "2026-10-01T00:00:00Z", client_meta: { node_id: "1:2" } }] } });
  w.file("f.md", "@lam Màn này thiếu trạng thái rỗng.\n");
  await onceOnly(w, "figma-comments", ["post", "1:2", "--body-file", "f.md", "--file", "F"], (line) => `@lam Màn này thiếu trạng thái rỗng.\n${line}`, () => w.writes().length);
  const reply = world({ web: { figma: [{ id: "100", message: "Root question", user: { handle: "lam" }, created_at: "2026-10-01T00:00:00Z", client_meta: { node_id: "1:2" } }] } });
  reply.file("f.md", "@lam Đã thêm trạng thái rỗng.\n");
  await onceOnly(reply, "figma-comments", ["reply", "100", "--body-file", "f.md", "--file", "F"], (line) => `@lam Đã thêm trạng thái rỗng.\n${line}`, () => reply.writes().length);
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
    await onceOnly(w, "gdoc-comments", args, (line) => (command === "delete" ? line : `${body}\n${line}`), () => w.writes().length);
  }
});

test("doc-comment-file post --apply writes only with a ticket, once", async () => {
  const w = world({ web: { tabs: { "t.1": TAB }, document: DOCUMENT }, map: { name: "p", repos: [{ path: ".", role: "FE" }], language: { pr_review: "en", doc_figma: "en" }, prd: { doc: "D", tabs: { "09": { tab: "t.1" } } } } });
  w.file("items.json", JSON.stringify({ title: "PRD", items: [ITEM] }));
  await onceOnly(w, "doc-comment-file", ["post", "items.json", "--html", "out.html", "--apply", "--doc", "D"], (line) => `${renderDocComment(ITEM, "t.1")}\n${line}`, () => w.writes().length);
});

test("a post ticket binds the PR, head, path and line, not only the comment text", async () => {
  const w = world({ gh: { diff: DIFF, head: HEAD, reviewComments: [{ id: 1, path: "src/a.ts", line: 10, side: "RIGHT", commit_id: HEAD }] } });
  w.file("d.md", DRAFT);
  const args = ["post", "d.md", "--repo", "o/r"];
  w.approve(`${DRAFT.replace("src/a.ts:10", "src/b.ts:4")}\n${w.line("github-write", args)}`);
  const moved = await w.run("github-write", args);
  assert.match(moved.out, /no unused approval/);
  w.approve(`The label is wrong.\n${w.line("github-write", args)}`);
  assert.match((await w.run("github-write", args)).out, /no unused approval/);
  assert.deepEqual(w.writes(), []);
});

test("a run refused before it writes leaves its ticket unused", async () => {
  const post = world({ gh: { diff: "diff --git a/other.ts b/other.ts\n--- a/other.ts\n+++ b/other.ts\n@@ -1,1 +1,1 @@\n+x\n", head: HEAD } });
  post.file("d.md", DRAFT);
  const args = ["post", "d.md", "--repo", "o/r"];
  post.approve(`${DRAFT}\n${post.line("github-write", args)}`);
  assert.notEqual((await post.run("github-write", args)).code, 0);
  assert.equal(post.tickets(), 1);
  post.file("gh.json", JSON.stringify({ diff: DIFF, head: HEAD, reviewComments: [{ id: 1, path: "src/a.ts", line: 10, side: "RIGHT", commit_id: HEAD }] }));
  await post.run("github-write", args);
  assert.equal(post.writes().length, 1);
  assert.equal(post.tickets(), 0);

  const anchor = world({ web: { drive: [], document: DOCUMENT } });
  anchor.file("g.md", "Which wallet pays the fee?\n");
  const anchorArgs = ["anchor", "--tab", "t.1", "--quote", "a passage not in the tab", "--body-file", "g.md", "--doc", "D"];
  anchor.approve(`Which wallet pays the fee?\n${anchor.line("gdoc-comments", anchorArgs)}`);
  assert.match((await anchor.run("gdoc-comments", anchorArgs)).out, /quote not found/);
  assert.equal(anchor.tickets(), 1);

  const op = await fakeOpenProject({ closedStatus: false });
  try {
    const w = world({ opUrl: op.url });
    w.file("drafts.json", JSON.stringify([TASK]));
    await w.run("openproject", ["preview", "drafts.json", "--project", "183"]);
    w.approve(`${renderWorkPackageDraft(TASK)}\n${w.line("openproject", ["apply", "drafts.json", "--project", "183"])}`);
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
  assert.equal(renderWorkPackageDraft(full), ["task task-fe-b", "id: 21298", "type: Task", "subject: [FE] Màn rỗng", "status: In progress", "priority: High", "assignee: Hoàng Lâm", "start: 2026-10-23", "due: 2026-10-24", "estimate: 1.5", "parent: 21270", "relates: 21294, 21295", "fields: {\"Environment\":\"Dev\"}", "description:", "## Goal", "Show it."].join("\n"));
  assert.equal(renderRollbackItem({ id: 30000, subject: "[FE] x" }), "#30000 [FE] x");
  assert.equal(renderDocComment(ITEM, "t.1"), "EPIC 09 · tab t.1 · UC_SW_13 BR1\nquote: Crypto takes the price in USDT\nWhich wallet pays the fee?");
});

test("apply, rollback and doc-comment-file tickets need the rendered lines, which their previews print", async () => {
  const op = await fakeOpenProject();
  try {
    const w = world({ opUrl: op.url });
    w.file("drafts.json", JSON.stringify([{ ...TASK, assignee: "Hoàng Lâm" }]));
    const preview = await w.run("openproject", ["preview", "drafts.json", "--project", "183"]);
    assert.ok(preview.out.includes(`approval lines:\n${renderWorkPackageDraft({ ...TASK, assignee: "Hoàng Lâm" })}`), preview.out);
    const apply = ["apply", "drafts.json", "--project", "183"];
    w.approve(`${TASK.subject}\n${DESCRIPTION}\n${w.line("openproject", apply)}`);
    w.approve(`${renderWorkPackageDraft(TASK)}\n${w.line("openproject", apply)}`, "Q2?");
    assert.match((await w.run("openproject", apply)).out, /no unused approval/);
    w.approve(`${renderWorkPackageDraft({ ...TASK, assignee: "Hoàng Lâm" })}\n${w.line("openproject", apply)}`, "Q3?");
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
    w.approve(`${renderWorkPackageDraft(TASK)}\n${w.line("openproject", ["apply", "drafts.json"])}`);
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
