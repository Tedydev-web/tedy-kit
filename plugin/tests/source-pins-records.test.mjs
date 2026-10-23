import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeOpenProject, world } from "./fake-services-for-tests.mjs";

const HEAD = "abc1234" + "0".repeat(33);
const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -9,2 +10,2 @@\n context line\n+added line\n";
const TAB = "Crypto takes the price in USDT and the fee in GRAM from the payer\n";
const DOCUMENT = { tabs: [{ tabProperties: { tabId: "t.1" }, documentTab: { body: { content: [{ paragraph: { elements: [{ startIndex: 1, textRun: { content: TAB } }] } }] } } }] };
const ITEM = { group: "A", epic: "09", where: "UC_SW_13 BR1", quote: "Crypto takes the price in USDT", comment: "Which wallet pays the fee?" };
const TASK = { slug: "task-fe-a", type: "Task", subject: "[FE] Vault limit pop-up on Pro", description: "## Goal\nShow the pop-up when a 4th vault is started on Pro.\n\n## Checklist\n- [ ] Show the pop-up.\n\n## AC\n- [ ] On Pro, a 4th vault cannot be started.", estimate: 1 };

const recordPath = (w, file) => join(w.dir, "state", "drafts", `${join(w.dir, file).replace(/\//g, "_")}.sources.json`);

test("openproject apply refuses drafts edited after the preview pinned them", async () => {
  const op = await fakeOpenProject();
  try {
    const w = world({ mode: "ask", opUrl: op.url });
    w.file("drafts.json", JSON.stringify([TASK]));
    const preview = await w.run("openproject", ["preview", "drafts.json", "--project", "183"]);
    assert.equal(preview.code, 0, preview.out);
    assert.match(JSON.parse(readFileSync(recordPath(w, "drafts.json"), "utf8")).sha256, /^[0-9a-f]{64}$/);
    w.file("drafts.json", JSON.stringify([{ ...TASK, estimate: 2 }]));
    op.calls.length = 0;
    const apply = await w.run("openproject", ["apply", "drafts.json", "--project", "183"]);
    assert.notEqual(apply.code, 0);
    assert.match(apply.out, /refused: drafts\.json changed after its sources were pinned; run openproject\.mjs preview drafts\.json --project 183 \[--pinned-at <file pin-sources ran for>\], then ask the user again/);
    assert.deepEqual(op.calls, []);
  } finally {
    op.server.close();
  }
});

test("doc-comment-file post refuses an items file edited after it was pinned", async () => {
  const w = world({ mode: "ask", web: { tabs: { "t.1": TAB }, document: DOCUMENT }, map: { name: "p", repos: [{ path: ".", role: "FE" }], language: { pr_review: "en", doc_figma: "en" }, prd: { doc: "D", tabs: { "09": { tab: "t.1" } } } } });
  w.file("items.json", JSON.stringify({ title: "PRD", items: [ITEM] }));
  const lint = await w.run("doc-comment-file", ["items.json"]);
  assert.equal(lint.code, 0, lint.out);
  assert.match(JSON.parse(readFileSync(recordPath(w, "items.json"), "utf8")).sha256, /^[0-9a-f]{64}$/);
  w.file("items.json", JSON.stringify({ title: "PRD", items: [{ ...ITEM, comment: "Who pays the fee in GRAM?" }] }));
  const post = await w.run("doc-comment-file", ["post", "items.json", "--html", "out.html", "--apply", "--doc", "D"]);
  assert.notEqual(post.code, 0);
  assert.match(post.out, /refused: items\.json changed after its sources were pinned/);
  assert.deepEqual(w.writes(), []);
});

test("github-write reads no cites out of the draft: a record for another text refuses, and a matching one without the PR head pin refuses too", async () => {
  const w = world({ mode: "ask", gh: { diff: DIFF, head: HEAD, reviewComments: [{ id: 1, path: "src/a.ts", line: 10, side: "RIGHT", commit_id: HEAD }] } });
  const draft = "# PR #701: comment line by line (head abc1234)\n\n## 1. `src/a.ts:10`\nThe label is wrong, the writer `src/a.ts:1@dev` sets it.\n";
  w.file("d.md", draft);
  mkdirSync(join(w.dir, "state", "drafts"), { recursive: true });
  writeFileSync(recordPath(w, "d.md"), JSON.stringify({ file: join(w.dir, "d.md"), sha256: createHash("sha256").update(`${draft}x`).digest("hex"), sources: [] }));
  const stale = await w.run("github-write", ["post", "d.md", "--repo", "o/r"]);
  assert.notEqual(stale.code, 0);
  assert.match(stale.out, /^refused: d\.md changed after its sources were pinned; run draft-lint\.mjs pr-comment d\.md --repo o\/r \[--pinned-at <file pin-sources ran for>\], then ask the user again$/m);
  assert.deepEqual(w.writes(), []);
  writeFileSync(recordPath(w, "d.md"), JSON.stringify({ file: join(w.dir, "d.md"), sha256: createHash("sha256").update(draft).digest("hex"), warnings: [], sources: [] }));
  const post = await w.run("github-write", ["post", "d.md", "--repo", "o/r"]);
  assert.notEqual(post.code, 0, post.out);
  assert.match(post.out, /^refused: d\.md was linted for no PR, not o\/r#701; run draft-lint\.mjs pr-comment d\.md --repo o\/r from the checkout of o\/r, then ask the user again$/m);
  assert.deepEqual(w.writes(), []);
});
