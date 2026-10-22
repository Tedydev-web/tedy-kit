import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeOpenProject, world } from "./fake-services-for-tests.mjs";
import { siblingRepo } from "./git-sibling-for-tests.mjs";
import { renderWorkPackageDraft } from "../lib/publish-approval-render.mjs";

const HEAD = "abc1234" + "0".repeat(33);
const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -9,2 +10,2 @@\n context line\n+added line\n";
const DRAFT = "# PR #701: comment line by line (head abc1234)\n\n## 1. `src/a.ts:10`\nThe label is wrong.\n";
const POSTED = { diff: DIFF, head: HEAD, reviewComments: [{ id: 1, path: "src/a.ts", line: 10, side: "RIGHT", commit_id: HEAD }] };
const WEB = { figma: [], drive: [], tabs: {}, document: {} };
const textDoc = (text) => ({ tabs: [{ tabProperties: { tabId: "t.1" }, documentTab: { body: { content: [{ paragraph: { elements: [{ startIndex: 1, textRun: { content: text } }] } }] } } }] });

async function lint(w, script, args) {
  const result = await w.run(script, args);
  assert.equal(result.code, 0, result.out);
  return result.out.split("\n").filter((line) => line.startsWith("pinned: "));
}

function reviewWorld(mode = "answer") {
  const sibling = siblingRepo();
  const w = world({ mode, gh: POSTED, map: { name: "p", repos: [{ path: sibling.clone, role: "backend", branch: "dev" }], language: { pr_review: "en" } } });
  mkdirSync(join(w.dir, "plans", "reports"), { recursive: true });
  writeFileSync(join(w.dir, "plans", "reports", "review-261022-1314-pr701-findings.md"), "Writer `src/a.ts:1@dev`, read at the remote ref.\n");
  w.file("d.md", DRAFT);
  return { w, sibling };
}

test("a stale-source refusal leaves the approval ticket unused, on every path that rechecks pins", async () => {
  const post = reviewWorld();
  const postArgs = ["post", "d.md", "--repo", "o/r"];
  const pins = await lint(post.w, "draft-lint", ["pr-comment", "d.md"]);
  post.sibling.push("src/a.ts", "a2\n", "fix: writer sets the field");
  post.w.approve([DRAFT, ...pins, post.w.line("github-write", postArgs)].join("\n"));
  const refusedPost = await post.w.run("github-write", postArgs);
  assert.notEqual(refusedPost.code, 0);
  assert.match(refusedPost.out, /^refused: .* changed what the draft cites$/m);
  assert.doesNotMatch(refusedPost.out, /no unused approval/);
  assert.equal(post.w.tickets(), 1);
  assert.deepEqual(post.w.writes(), []);

  const reply = reviewWorld();
  reply.w.file("r.md", "The label is still wrong.\n");
  reply.w.file("e.md", "Still `src/a.ts:1@dev`.\n");
  const replyArgs = ["reply", "701", "123", "--repo", "o/r", "--body-file", "r.md"];
  const replyPins = await lint(reply.w, "draft-lint", ["pr-reply", "r.md", "--findings", "e.md"]);
  reply.sibling.push("src/a.ts", "a2\n", "fix: writer sets the field");
  reply.w.approve(["The label is still wrong.", ...replyPins, reply.w.line("github-write", replyArgs)].join("\n"));
  assert.match((await reply.w.run("github-write", replyArgs)).out, /^refused: .* changed what the draft cites$/m);
  assert.equal(reply.w.tickets(), 1);
  assert.deepEqual(reply.w.writes(), []);

  const thread = { id: "c1", content: "Which wallet?", resolved: false, author: { me: false, displayName: "PM" }, replies: [], createdTime: "2026-10-01T00:00:00Z" };
  const gdoc = world({ web: { drive: [thread], document: textDoc("A\n") } });
  gdoc.file("g.md", "Which wallet pays the fee?\n");
  const gdocArgs = ["reply", "c1", "--body-file", "g.md", "--doc", "D"];
  const gdocPins = await lint(gdoc, "draft-lint", ["doc-comment", "g.md", "--doc", "D"]);
  gdoc.file("web.json", JSON.stringify({ ...WEB, drive: [thread], document: textDoc("B\n") }));
  gdoc.approve(["Which wallet pays the fee?", ...gdocPins, gdoc.line("gdoc-comments", gdocArgs)].join("\n"));
  assert.match((await gdoc.run("gdoc-comments", gdocArgs)).out, /refused: Google Doc D text changed from [0-9a-f]{12} to [0-9a-f]{12}/);
  assert.equal(gdoc.tickets(), 1);
  assert.deepEqual(gdoc.writes(), []);

  const root = { id: "100", message: "Root question", user: { handle: "lam" }, created_at: "2026-10-01T00:00:00Z" };
  const figma = world({ web: { figma: [root] } });
  figma.file("f.md", "@lam Đã thêm trạng thái rỗng.\n");
  const figmaArgs = ["reply", "100", "--body-file", "f.md", "--file", "F"];
  const figmaPins = await lint(figma, "draft-lint", ["figma-comment", "f.md", "--file", "F"]);
  figma.file("web.json", JSON.stringify({ ...WEB, figma: [root], figmaVersion: "2" }));
  figma.approve(["@lam Đã thêm trạng thái rỗng.", ...figmaPins, figma.line("figma-comments", figmaArgs)].join("\n"));
  assert.match((await figma.run("figma-comments", figmaArgs)).out, /refused: Figma F version changed from 1 to 2/);
  assert.equal(figma.tickets(), 1);
  assert.deepEqual(figma.writes(), []);

  const op = await fakeOpenProject();
  try {
    const task = { slug: "task-fe-a", type: "Task", subject: "[FE] Vault limit pop-up on Pro", description: "## Goal\nShow the pop-up when a 4th vault is started on Pro, as https://docs.google.com/document/d/D2/edit says.\n\n## Checklist\n- [ ] Show the pop-up.\n\n## AC\n- [ ] On Pro, a 4th vault cannot be started.", estimate: 1 };
    const w = world({ opUrl: op.url, web: { document: textDoc("A\n") } });
    w.file("drafts.json", JSON.stringify([task]));
    const applyArgs = ["apply", "drafts.json", "--project", "183"];
    const opPins = await lint(w, "openproject", ["preview", "drafts.json", "--project", "183"]);
    assert.equal(opPins.length, 1);
    assert.match(opPins[0], /^pinned: Google Doc D2 text [0-9a-f]{12} via docs-text$/);
    w.file("web.json", JSON.stringify({ ...WEB, document: textDoc("B\n") }));
    w.approve([renderWorkPackageDraft(task, { action: "create", id: null }), ...opPins, w.line("openproject", applyArgs)].join("\n"));
    op.calls.length = 0;
    assert.match((await w.run("openproject", applyArgs)).out, /refused: Google Doc D2 text changed from [0-9a-f]{12} to [0-9a-f]{12}/);
    assert.equal(w.tickets(), 1);
    assert.deepEqual(op.calls, []);
  } finally {
    op.server.close();
  }
});

test("a moved pin's notice is printed, never posted, so the ticket binds exactly what is written", async () => {
  const { w, sibling } = reviewWorld();
  const args = ["post", "d.md", "--repo", "o/r"];
  const pins = await lint(w, "draft-lint", ["pr-comment", "d.md"]);
  assert.equal(pins.length, 1);
  sibling.push("src/b.ts", "b2\n", "chore: unrelated");
  w.approve([DRAFT, ...pins, w.line("github-write", args)].join("\n"));
  const result = await w.run("github-write", args);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /^notice: .* no cited path changed, so it posts as drafted$/m);
  assert.equal(w.tickets(), 0);
  const [write] = w.writes();
  assert.equal(w.writes().length, 1);
  const payload = JSON.parse(JSON.parse(write.slice(write.indexOf(" \"") + 1)));
  assert.deepEqual(payload.comments.map((comment) => comment.body), ["The label is wrong."]);
  assert.doesNotMatch(write, /notice/);

  const ITEM = { group: "A", epic: "09", where: "UC_SW_13 BR1", quote: "Crypto takes the price in USDT", comment: "Which wallet pays the fee?" };
  const TAB = "Crypto takes the price in USDT and the fee in GRAM from the payer\n";
  const DOCUMENT = { tabs: [{ tabProperties: { tabId: "t.1" }, documentTab: { body: { content: [{ paragraph: { elements: [{ startIndex: 1, textRun: { content: TAB } }] } }] } } }] };
  const doc = world({ web: { tabs: { "t.1": TAB }, document: DOCUMENT }, map: { name: "p", repos: [{ path: ".", role: "FE" }], language: { pr_review: "en", doc_figma: "en" }, prd: { doc: "D", tabs: { "09": { tab: "t.1" } } } } });
  doc.file("items.json", JSON.stringify({ title: "PRD", items: [ITEM] }));
  const docPins = await lint(doc, "doc-comment-file", ["items.json"]);
  const docArgs = ["post", "items.json", "--html", "out.html", "--apply", "--doc", "D"];
  const preview = await doc.run("doc-comment-file", ["post", "items.json", "--html", "out.html"]);
  const approvalLines = preview.out.slice(preview.out.indexOf("approval lines:\n") + "approval lines:\n".length, preview.out.indexOf("\nWRITE →"));
  doc.file("web.json", JSON.stringify({ ...WEB, tabs: { "t.1": TAB }, document: textDoc(`${TAB}A new paragraph\n`) }));
  doc.approve([approvalLines, ...docPins, doc.line("doc-comment-file", docArgs)].join("\n"));
  const posted = await doc.run("doc-comment-file", docArgs);
  assert.equal(posted.code, 0, posted.out);
  assert.match(posted.out, /^notice: Google Doc D text changed from [0-9a-f]{12} to [0-9a-f]{12} .*every highlighted passage still appears exactly once, so it posts as drafted$/m);
  assert.equal(doc.tickets(), 0);
  assert.equal(doc.writes().filter((line) => line.startsWith("docs.googleapis.com POST")).length, 1);
});

test("a write refused for a missing sources record leaves its approval ticket unused", async () => {
  const TAB = "Crypto takes the price in USDT and the fee in GRAM from the payer\n";
  const ITEM = { group: "A", epic: "09", where: "UC_SW_13 BR1", quote: "Crypto takes the price in USDT", comment: "Which wallet pays the fee?" };
  const own = { id: "c2", content: "Old question?", resolved: false, author: { me: true, displayName: "me" }, replies: [], createdTime: "2026-10-01T00:00:00Z" };
  const cases = [
    ["github-write", ["edit", "5", "--body-file", "b.md", "--repo", "o/r"], "The label is still wrong.", { gh: { write: { id: 5, html_url: "u", body: "x" } } }],
    ["figma-comments", ["post", "1:2", "--body-file", "b.md", "--file", "F"], "@lam Màn này thiếu trạng thái rỗng.", { web: { figma: [] } }],
    ["gdoc-comments", ["anchor", "--tab", "t.1", "--quote", "the fee in GRAM", "--body-file", "b.md", "--doc", "D"], "Which wallet pays the fee?", { web: { drive: [], document: textDoc(TAB) } }],
    ["gdoc-comments", ["edit", "c2", "--body-file", "b.md", "--doc", "D"], "Which wallet pays the fee?", { web: { drive: [own], document: textDoc(TAB) } }],
    ["doc-comment-file", ["post", "items.json", "--html", "out.html", "--apply", "--doc", "D"], null, { web: { tabs: { "t.1": TAB }, document: textDoc(TAB) }, map: { name: "p", repos: [{ path: ".", role: "FE" }], language: { pr_review: "en", doc_figma: "en" }, prd: { doc: "D", tabs: { "09": { tab: "t.1" } } } } }],
  ];
  for (const [script, args, body, options] of cases) {
    const w = world(options);
    if (body) w.file("b.md", `${body}\n`);
    else w.file("items.json", JSON.stringify({ title: "PRD", items: [ITEM] }));
    w.approve([body ?? `EPIC 09 · tab t.1 · UC_SW_13 BR1\nquote: ${ITEM.quote}\n${ITEM.comment}`, w.line(script, args)].join("\n"));
    const result = await w.run(script, args);
    assert.notEqual(result.code, 0, `${script} ${args[0]}`);
    assert.match(result.out, /refused: (?:b\.md|items\.json) has no pinned sources/, `${script} ${args[0]}: ${result.out}`);
    assert.equal(w.tickets(), 1, `${script} ${args[0]}`);
    assert.deepEqual(w.writes(), [], `${script} ${args[0]}`);
  }
});

test("a moved pin's notice is printed only once the approval is spent", async () => {
  const { w, sibling } = reviewWorld();
  const args = ["post", "d.md", "--repo", "o/r"];
  const pins = await lint(w, "draft-lint", ["pr-comment", "d.md"]);
  sibling.push("src/b.ts", "b2\n", "chore: unrelated");
  const unapproved = await w.run("github-write", args);
  assert.match(unapproved.out, /no unused approval matches this write/);
  assert.doesNotMatch(unapproved.out, /notice:/);
  w.approve([DRAFT, ...pins, w.line("github-write", args)].join("\n"));
  const posted = await w.run("github-write", args);
  assert.equal(posted.code, 0, posted.out);
  assert.ok(posted.out.indexOf("notice:") > posted.out.indexOf("WRITE →"), posted.out);

  const TAB = "Crypto takes the price in USDT and the fee in GRAM from the payer\n";
  const ITEM = { group: "A", epic: "09", where: "UC_SW_13 BR1", quote: "Crypto takes the price in USDT", comment: "Which wallet pays the fee?" };
  const doc = world({ web: { tabs: { "t.1": TAB }, document: textDoc(TAB) }, map: { name: "p", repos: [{ path: ".", role: "FE" }], language: { pr_review: "en", doc_figma: "en" }, prd: { doc: "D", tabs: { "09": { tab: "t.1" } } } } });
  doc.file("items.json", JSON.stringify({ title: "PRD", items: [ITEM] }));
  await lint(doc, "doc-comment-file", ["items.json"]);
  doc.file("web.json", JSON.stringify({ ...WEB, tabs: { "t.1": TAB }, document: textDoc(`${TAB}A new paragraph\n`) }));
  const docArgs = ["post", "items.json", "--html", "out.html", "--apply", "--doc", "D"];
  const refused = await doc.run("doc-comment-file", docArgs);
  assert.match(refused.out, /no unused approval matches this write/);
  assert.doesNotMatch(refused.out, /notice:|every highlighted passage/);
});

test("several Doc replies and anchors in one batch do not refuse each other, because a comment changes no text", async () => {
  const TAB = "Crypto takes the price in USDT and the fee in GRAM from the payer\n";
  const thread = { id: "c1", content: "Which wallet?", resolved: false, author: { me: false, displayName: "PM" }, replies: [], createdTime: "2026-10-01T00:00:00Z" };
  const w = world({ mode: "ask", web: { drive: [thread], document: textDoc(TAB) } });
  const bodies = ["Which wallet pays the fee?", "Is the fee shown before paying?", "Does USDT cover the fee too?"];
  for (const [index, body] of bodies.entries()) {
    w.file(`g${index}.md`, `${body}\n`);
    await lint(w, "draft-lint", ["doc-comment", `g${index}.md`, "--doc", "D"]);
  }
  const commented = { ...textDoc(TAB), revisionId: "r-after-comments", namedRanges: { kix: { name: "kix", namedRanges: [] } } };
  commented.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.suggestedInsertionIds = ["suggest.1"];
  for (const [index, args] of [["reply", "c1"], ["reply", "c1"], ["anchor", "--tab", "t.1", "--quote", "the fee in GRAM"]].entries()) {
    const result = await w.run("gdoc-comments", [...args, "--body-file", `g${index}.md`, "--doc", "D"]);
    assert.equal(result.code, 0, result.out);
    assert.doesNotMatch(result.out, /refused|notice/);
    w.file("web.json", JSON.stringify({ ...WEB, drive: [thread], document: commented }));
  }
  assert.equal(w.writes().length, 3);
});

test("without an own OAuth client a Doc is pinned by its Drive text export: replies in a batch pass, a text change refuses", async () => {
  const thread = { id: "c1", content: "Which wallet?", resolved: false, author: { me: false, displayName: "PM" }, replies: [], createdTime: "2026-10-01T00:00:00Z" };
  const w = world({ mode: "ask", web: { drive: [thread], document: textDoc("A\n"), exported: "Crypto takes the price in USDT\n" } });
  w.file("bin/rclone", "#!/usr/bin/env node\nif (process.argv[2] === \"config\") process.stdout.write(JSON.stringify({ gdrive: { token: JSON.stringify({ access_token: \"a\", refresh_token: \"r\", expiry: \"2999-01-01T00:00:00Z\" }) } }));\n");
  const bodies = ["Which wallet pays the fee?", "Is the fee shown before paying?", "Does USDT cover the fee too?"];
  for (const [index, body] of bodies.entries()) w.file(`g${index}.md`, `${body}\n`);
  const pins = await lint(w, "draft-lint", ["doc-comment", "g0.md", "--doc", "D"]);
  assert.match(pins[0], /^pinned: Google Doc D text [0-9a-f]{12} via drive-export$/);
  for (const index of [1, 2]) await lint(w, "draft-lint", ["doc-comment", `g${index}.md`, "--doc", "D"]);
  for (const index of [0, 1]) {
    const result = await w.run("gdoc-comments", ["reply", "c1", "--body-file", `g${index}.md`, "--doc", "D"]);
    assert.equal(result.code, 0, result.out);
  }
  w.file("web.json", JSON.stringify({ ...WEB, drive: [thread], document: textDoc("A\n"), exported: "Crypto takes the price in BTC\n" }));
  const refused = await w.run("gdoc-comments", ["reply", "c1", "--body-file", "g2.md", "--doc", "D"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /refused: Google Doc D text changed from [0-9a-f]{12} to [0-9a-f]{12}/);
  assert.equal(w.writes().length, 2);
});

test("a ready PR body refresh needs --repo and a ticket in answer mode, and neither in ask mode", async () => {
  const op = await fakeOpenProject();
  try {
    for (const mode of ["answer", "ask"]) {
      const w = world({ mode, opUrl: op.url, gh: { prView: { number: 3, isDraft: false, author: { login: "me" }, body: "OP#21298\n\nTask read at earlier" }, login: "me" } });
      const generated = await w.run("openproject", ["pr-body", "21298"]);
      assert.equal(generated.code, 0, generated.out);
      w.file("p.md", generated.out);
      const bare = ["pr-body", "3", "--body-file", "p.md"];
      const named = [...bare, "--repo", "o/r"];
      if (mode === "ask") {
        await w.run("github-write", bare);
        assert.equal(w.writes().length, 1, mode);
        assert.throws(() => readdirSync(join(w.dir, "state", "approvals")));
        continue;
      }
      assert.match((await w.run("github-write", bare)).out, /name the write target with --repo/);
      assert.match((await w.run("github-write", named)).out, /no unused approval matches this write/);
      assert.deepEqual(w.writes(), []);
      w.approve(`${generated.out.trim()}\n${w.line("github-write", named)}`);
      await w.run("github-write", named);
      assert.equal(w.writes().length, 1);
      assert.ok(w.writes()[0].includes("repos/o/r/pulls/3"), w.writes()[0]);
      assert.equal(w.tickets(), 0);
      await w.run("github-write", named);
      assert.equal(w.writes().length, 1);
    }
  } finally {
    op.server.close();
  }
});
