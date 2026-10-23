import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeOpenProject, world } from "./fake-services-for-tests.mjs";
import { siblingRepo } from "./git-sibling-for-tests.mjs";
import { renderWorkPackageDraft } from "../lib/publish-approval-render.mjs";

const HEAD = "abc1234" + "0".repeat(33);
const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -9,2 +10,2 @@\n context line\n+added line\n";
const DRAFT = "# PR #701: comment line by line (head abc1234)\n\n## 1. `src/a.ts:10`\nThe label is wrong, `src/a.ts:1@dev` sets it.\n";
const POSTED = { diff: DIFF, head: HEAD, reviewComments: [{ id: 1, path: "src/a.ts", line: 10, side: "RIGHT", commit_id: HEAD }] };
const TAB = "Crypto takes the price in USDT and the fee in GRAM from the payer\n";
const FIGMA_NODE = "https://www.figma.com/design/F1/App?node-id=1-2";
const ITEM = { group: "A", epic: "09", where: "UC_SW_13 BR1", quote: "Crypto takes the price in USDT", comment: "Which wallet pays the fee?" };
const PRD_MAP = { name: "p", repos: [{ path: ".", role: "FE" }], language: { pr_review: "en", doc_figma: "en" }, prd: { doc: "D", tabs: { "09": { tab: "t.1" } } } };
const textDoc = (text) => ({ tabs: [{ tabProperties: { tabId: "t.1" }, documentTab: { body: { content: [{ paragraph: { elements: [{ startIndex: 1, textRun: { content: text } }] } }] } } }] });
const task = (link) => ({ slug: "task-fe-a", type: "Task", subject: "[FE] Vault limit pop-up on Pro", description: `## Goal\nShow the pop-up when a 4th vault is started on Pro, as ${link} says.\n\n## Checklist\n- [ ] Show the pop-up.\n\n## AC\n- [ ] On Pro, a 4th vault cannot be started.`, estimate: 1 });
const thread = { id: "c1", content: "Which wallet?", resolved: false, author: { me: false, displayName: "PM" }, replies: [], createdTime: "2026-10-01T00:00:00Z" };
const own = { id: "c2", content: "Old question?", resolved: false, author: { me: true, displayName: "me" }, replies: [], createdTime: "2026-10-01T00:00:00Z" };
const root = { id: "100", message: "Root question", user: { handle: "lam" }, created_at: "2026-10-01T00:00:00Z", client_meta: { node_id: "1:2" } };

async function lint(w, script, args) {
  const result = await w.run(script, args);
  assert.equal(result.code, 0, `${script} ${args.join(" ")}: ${result.out}`);
  return result.out.split("\n").filter((line) => /^(pinned|warning): /.test(line));
}

const web = (w) => JSON.parse(readFileSync(join(w.dir, "web.json"), "utf8"));
const changeWeb = (w, change) => w.file("web.json", JSON.stringify({ ...web(w), ...change }));
const moveFigma = (w) => changeWeb(w, { figmaModified: "2026-10-02T00:00:00Z" });
const sent = (w) => w.writes().filter((line) => !line.endsWith("/form"));

function gitWorld({ head, ...gh } = POSTED) {
  const sibling = siblingRepo();
  const w = world({ pr: 701, gh, map: { name: "p", repos: [{ path: sibling.clone, role: "BE", branch: "dev" }], language: { pr_review: "en" } } });
  return { w, sibling, draft: DRAFT.replaceAll("abc1234", w.checkout.pr(701).slice(0, 7)) };
}

const LINKED_ITEM = { ...ITEM, comment: `Which wallet pays the fee, as ${FIGMA_NODE} shows?` };
const itemLines = (item) => `EPIC 09 · tab t.1 · UC_SW_13 BR1\nquote: ${item.quote}\n${item.comment}`;

async function withOpenProject(run) {
  const op = await fakeOpenProject();
  try {
    return await run(op);
  } finally {
    op.server.close();
  }
}

const CASES = [
  ["github-write post", async () => {
    const { w, sibling, draft } = gitWorld();
    w.file("d.md", draft);
    return { w, lint: [["draft-lint", ["pr-comment", "d.md", "--repo", "o/r"]]], move: () => sibling.push("src/b.ts", "b2\n", "chore: unrelated"), script: "github-write", args: ["post", "d.md", "--repo", "o/r"], texts: [draft] };
  }],
  ["github-write reply", async () => {
    const { w, sibling } = gitWorld({});
    w.file("r.md", "The label is still wrong.\n");
    return { w, lint: [["draft-lint", ["pr-reply", "r.md", "--pr", "701", "--repo", "o/r"]]], move: () => sibling.push("src/b.ts", "b2\n", "chore: unrelated"), script: "github-write", args: ["reply", "701", "123", "--repo", "o/r", "--body-file", "r.md"], texts: ["The label is still wrong."] };
  }],
  ["github-write edit", async () => {
    const { w, sibling } = gitWorld({ writeBody: "The label is still wrong." });
    w.file("r.md", "The label is still wrong.\n");
    return { w, lint: [["draft-lint", ["pr-reply", "r.md", "--pr", "701", "--repo", "o/r"]]], move: () => sibling.push("src/b.ts", "b2\n", "chore: unrelated"), script: "github-write", args: ["edit", "5", "--body-file", "r.md", "--repo", "o/r"], texts: ["The label is still wrong."] };
  }],
  ["figma-comments post", async () => {
    const w = world({ web: { figma: [] } });
    w.file("f.md", "@lam Màn này thiếu trạng thái rỗng.\n");
    return { w, lint: [["draft-lint", ["figma-comment", "f.md", "--file", "F1", "--node", "1-2"]]], move: () => moveFigma(w), script: "figma-comments", args: ["post", "1-2", "--body-file", "f.md", "--file", "F1"], texts: ["@lam Màn này thiếu trạng thái rỗng."] };
  }],
  ["figma-comments reply", async () => {
    const w = world({ web: { figma: [root] } });
    w.file("f.md", "@lam Đã thêm trạng thái rỗng.\n");
    return { w, lint: [["draft-lint", ["figma-comment", "f.md", "--file", "F1", "--node", "1:2"]]], move: () => moveFigma(w), script: "figma-comments", args: ["reply", "100", "--body-file", "f.md", "--file", "F1"], texts: ["@lam Đã thêm trạng thái rỗng."] };
  }],
  ...[
    ["reply", ["reply", "c1"], [thread]],
    ["anchor", ["anchor", "--tab", "t.1", "--quote", "the fee in GRAM"], []],
    ["edit", ["edit", "c2"], [own]],
  ].map(([name, head, drive]) => [`gdoc-comments ${name}`, async () => {
    const body = `Which wallet pays the fee, as ${FIGMA_NODE} shows?`;
    const w = world({ web: { drive, document: textDoc(TAB) } });
    w.file("g.md", `${body}\n`);
    return { w, lint: [["draft-lint", ["doc-comment", "g.md", "--doc", "D"]]], move: () => moveFigma(w), script: "gdoc-comments", args: [...head, "--body-file", "g.md", "--doc", "D"], texts: [body] };
  }]),
  ["doc-comment-file post", async () => {
    const w = world({ web: { tabs: { "t.1": TAB }, document: textDoc(TAB) }, map: PRD_MAP });
    w.file("items.json", JSON.stringify({ title: "PRD", items: [LINKED_ITEM] }));
    const args = ["post", "items.json", "--html", "out.html", "--apply", "--doc", "D"];
    return { w, lint: [["doc-comment-file", ["items.json"]]], move: () => moveFigma(w), script: "doc-comment-file", args, texts: [itemLines(LINKED_ITEM)] };
  }],
  ["openproject apply", async (op) => {
    const w = world({ opUrl: op.url });
    const draft = task(FIGMA_NODE);
    w.file("drafts.json", JSON.stringify([draft]));
    return { w, lint: [["openproject", ["preview", "drafts.json", "--project", "183"]]], move: () => moveFigma(w), script: "openproject", args: ["apply", "drafts.json", "--project", "183"], texts: [renderWorkPackageDraft(draft, { action: "create", id: null })] };
  }],
  ["openproject comment", async (op) => {
    const w = world({ opUrl: op.url });
    const body = `The pop-up needs the Pro price, as ${FIGMA_NODE} shows.`;
    w.file("c.md", `${body}\n`);
    return { w, lint: [["openproject", ["comment", "21298", "--body-file", "c.md"]]], move: () => moveFigma(w), script: "openproject", args: ["comment", "21298", "--apply", "--body-file", "c.md"], texts: [body] };
  }],
  ["openproject comment-edit", async (op) => {
    const w = world({ opUrl: op.url });
    const body = `The pop-up needs the Pro price, as ${FIGMA_NODE} shows.`;
    w.file("e.md", `${body}\n`);
    return { w, lint: [["openproject", ["comment-edit", "9", "--body-file", "e.md"]]], move: () => moveFigma(w), script: "openproject", args: ["comment-edit", "9", "--apply", "--body-file", "e.md"], texts: [body] };
  }],
];

test("on every writer a moved pin's notice is printed only once the approval is spent, and never written", async () => {
  for (const [name, setup] of CASES) {
    await withOpenProject(async (op) => {
      const { w, lint: lints, move, script, args, texts } = await setup(op);
      const pins = [];
      for (const [lintScript, lintArgs] of lints) pins.push(...(await lint(w, lintScript, lintArgs)));
      assert.ok(pins.length, `${name}: no pinned: line`);
      move();
      const unapproved = await w.run(script, args);
      assert.match(unapproved.out, /no unused approval matches this write/, `${name}: ${unapproved.out}`);
      assert.doesNotMatch(unapproved.out, /notice:/, name);
      assert.deepEqual(sent(w), [], name);
      const warnings = pins.filter((line) => line.startsWith("warning: "));
      assert.ok(warnings.length, `${name}: no warning: line`);
      w.approve([...texts, ...pins.filter((line) => !warnings.includes(line)), w.line(script, args)].join("\n"));
      const unwarned = await w.run(script, args);
      assert.match(unwarned.out, /no unused approval matches this write/, `${name}: ${unwarned.out}`);
      assert.equal(w.tickets(), 1, name);
      assert.deepEqual([...sent(w), ...op.calls], [], name);
      op.calls.length = 0;
      w.approve([...texts, ...pins, w.line(script, args)].join("\n"));
      const posted = await w.run(script, args);
      assert.match(posted.out, /^notice: .* so it posts as drafted$/m, `${name}: ${posted.out}`);
      assert.doesNotMatch(posted.out, /refused/, `${name}: ${posted.out}`);
      assert.equal(w.tickets(), 1, name);
      const written = [...sent(w), ...op.calls].join("\n");
      assert.ok(written.length, `${name}: nothing written`);
      assert.doesNotMatch(written, /notice|posts as drafted/, name);
    });
  }
});

test("a stale-source refusal leaves the approval ticket unused, on every path that rechecks pins", async () => {
  const stale = [
    ["github-write post", async () => {
      const { w, sibling, draft } = gitWorld();
      w.file("d.md", draft);
      return { w, lint: ["draft-lint", ["pr-comment", "d.md", "--repo", "o/r"]], move: () => sibling.push("src/a.ts", "a2\n", "fix: writer sets the field"), script: "github-write", args: ["post", "d.md", "--repo", "o/r"], texts: [draft], refusal: /^refused: .* changed a file the text being posted names$/m };
    }],
    ["gdoc-comments reply", async () => {
      const w = world({ web: { drive: [thread], document: textDoc("A\n") } });
      w.file("g.md", "Which wallet pays the fee?\n");
      return { w, lint: ["draft-lint", ["doc-comment", "g.md", "--doc", "D"]], move: () => changeWeb(w, { document: textDoc("B\n") }), script: "gdoc-comments", args: ["reply", "c1", "--body-file", "g.md", "--doc", "D"], texts: ["Which wallet pays the fee?"], refusal: /refused: Google Doc D text changed from [0-9a-f]{12} to [0-9a-f]{12}/ };
    }],
    ["figma-comments reply", async () => {
      const w = world({ web: { figma: [root] } });
      w.file("f.md", "@lam Đã thêm trạng thái rỗng.\n");
      return { w, lint: ["draft-lint", ["figma-comment", "f.md", "--file", "F1", "--node", "1-2"]], move: () => changeWeb(w, { figmaNodes: { "1:2": { document: { id: "1:2", name: "changed" } } } }), script: "figma-comments", args: ["reply", "100", "--body-file", "f.md", "--file", "F1"], texts: ["@lam Đã thêm trạng thái rỗng."], refusal: /refused: Figma F1 node 1:2 changed since it was pinned/ };
    }],
    ["openproject apply", async (op) => {
      const w = world({ opUrl: op.url, web: { document: textDoc("A\n") } });
      const draft = task("https://docs.google.com/document/d/D2/edit");
      w.file("drafts.json", JSON.stringify([draft]));
      return { w, lint: ["openproject", ["preview", "drafts.json", "--project", "183"]], move: () => changeWeb(w, { document: textDoc("B\n") }), script: "openproject", args: ["apply", "drafts.json", "--project", "183"], texts: [renderWorkPackageDraft(draft, { action: "create", id: null })], refusal: /refused: Google Doc D2 text changed from [0-9a-f]{12} to [0-9a-f]{12}/ };
    }],
    ["openproject comment", async (op) => {
      const w = world({ opUrl: op.url });
      const body = `The pop-up needs the Pro price, as ${FIGMA_NODE} shows.`;
      w.file("c.md", `${body}\n`);
      return { w, lint: ["openproject", ["comment", "21298", "--body-file", "c.md"]], move: () => changeWeb(w, { figmaNodes: { "1:2": null } }), script: "openproject", args: ["comment", "21298", "--apply", "--body-file", "c.md"], texts: [body], refusal: /refused: Figma F1 node 1:2 changed since it was pinned/ };
    }],
    ["github-write reply", async () => {
      const { w, sibling } = gitWorld({});
      w.file("r.md", "The label is still wrong, see src/a.ts.\n");
      return { w, lint: ["draft-lint", ["pr-reply", "r.md", "--pr", "701", "--repo", "o/r"]], move: () => sibling.push("src/a.ts", "a2\n", "fix: writer sets the field"), script: "github-write", args: ["reply", "701", "123", "--repo", "o/r", "--body-file", "r.md"], texts: ["The label is still wrong, see src/a.ts."], refusal: /^refused: .* changed a file the text being posted names$/m };
    }],
    ["github-write edit", async () => {
      const { w } = gitWorld({ writeBody: "The label is still wrong." });
      w.file("r.md", "The label is still wrong.\n");
      return { w, lint: ["draft-lint", ["pr-reply", "r.md", "--pr", "701", "--repo", "o/r"]], move: () => w.checkout.pushPr("src/z.ts", "z\n", "fix: author pushed"), script: "github-write", args: ["edit", "5", "--body-file", "r.md", "--repo", "o/r"], texts: ["The label is still wrong."], refusal: /^refused: \S+ pull\/701\/head moved from .* so the PR under review changed$/m };
    }],
    ["openproject comment-edit", async (op) => {
      const w = world({ opUrl: op.url, web: { document: textDoc("A\n") } });
      const body = "The pop-up needs the Pro price, as https://docs.google.com/document/d/D2/edit says.";
      w.file("e.md", `${body}\n`);
      return { w, lint: ["openproject", ["comment-edit", "9", "--body-file", "e.md"]], move: () => changeWeb(w, { document: textDoc("B\n") }), script: "openproject", args: ["comment-edit", "9", "--apply", "--body-file", "e.md"], texts: [body], refusal: /refused: Google Doc D2 text changed/ };
    }],
    ["doc-comment-file post --apply", async () => {
      const w = world({ web: { tabs: { "t.1": TAB }, document: textDoc(TAB) }, map: PRD_MAP });
      w.file("items.json", JSON.stringify({ title: "PRD", items: [ITEM] }));
      return { w, lint: ["doc-comment-file", ["items.json"]], move: () => changeWeb(w, { document: textDoc(`${TAB}A new paragraph\n`) }), script: "doc-comment-file", args: ["post", "items.json", "--html", "out.html", "--apply", "--doc", "D"], texts: [itemLines(ITEM)], refusal: /refused: Google Doc D text changed from [0-9a-f]{12} to [0-9a-f]{12} since it was pinned/ };
    }],
    ["figma-comments post when the Figma API fails at publish", async () => {
      const w = world({ web: { figma: [] } });
      w.file("f.md", "@lam Màn này thiếu trạng thái rỗng.\n");
      return { w, lint: ["draft-lint", ["figma-comment", "f.md", "--file", "F1", "--node", "1-2"]], move: () => changeWeb(w, { figma429: true }), script: "figma-comments", args: ["post", "1-2", "--body-file", "f.md", "--file", "F1"], texts: ["@lam Màn này thiếu trạng thái rỗng."], refusal: /Figma answered HTTP 429 to \/files\/F1\/nodes \(Retry-After 30 s\); it is rate limited, so nothing more was sent/ };
    }],
    ["gdoc-comments reply when the Doc cannot be read at publish", async () => {
      const w = world({ web: { drive: [thread], document: textDoc("A\n") } });
      w.file("g.md", "Which wallet pays the fee?\n");
      return { w, lint: ["draft-lint", ["doc-comment", "g.md", "--doc", "D"]], move: () => changeWeb(w, { document: { error: "gone" } }), script: "gdoc-comments", args: ["reply", "c1", "--body-file", "g.md", "--doc", "D"], texts: ["Which wallet pays the fee?"], refusal: /refused: the text of Google Doc D could not be read through docs-text/ };
    }],
    ["gdoc-comments reply on a Doc the sources record does not pin", async () => {
      const w = world({ web: { drive: [thread], document: textDoc("A\n") } });
      w.file("g.md", "Which wallet pays the fee?\n");
      return { w, lint: ["draft-lint", ["doc-comment", "g.md", "--doc", "D"]], move: () => {}, script: "gdoc-comments", args: ["reply", "c1", "--body-file", "g.md", "--doc", "OTHER"], texts: ["Which wallet pays the fee?"], refusal: /refused: g\.md has no pinned text of Google Doc OTHER; run draft-lint\.mjs doc-comment g\.md --doc OTHER/ };
    }],
    ["figma-comments post to a file the sources record does not pin", async () => {
      const w = world({ web: { figma: [] } });
      w.file("f.md", "@lam Màn này thiếu trạng thái rỗng.\n");
      return { w, lint: ["draft-lint", ["figma-comment", "f.md", "--file", "F1", "--node", "1-2"]], move: () => {}, script: "figma-comments", args: ["post", "1-2", "--body-file", "f.md", "--file", "F2"], texts: ["@lam Màn này thiếu trạng thái rỗng."], refusal: /refused: f\.md has no pinned Figma F2 node 1:2/ };
    }],
  ];
  for (const [name, setup] of stale) {
    await withOpenProject(async (op) => {
      const { w, lint: [lintScript, lintArgs], move, script, args, texts, refusal } = await setup(op);
      const pins = await lint(w, lintScript, lintArgs);
      move();
      w.approve([...texts, ...pins, w.line(script, args)].join("\n"));
      op.calls.length = 0;
      const result = await w.run(script, args);
      assert.notEqual(result.code, 0, name);
      assert.match(result.out, refusal, `${name}: ${result.out}`);
      assert.doesNotMatch(result.out, /no unused approval|notice:/, name);
      assert.equal(w.tickets(), 1, name);
      assert.deepEqual([...sent(w), ...op.calls], [], name);
    });
  }
});

test("a write refused for a missing sources record leaves its approval ticket unused", async () => {
  const cases = [
    ["github-write", ["edit", "5", "--body-file", "b.md", "--repo", "o/r"], "The label is still wrong.", { gh: { write: { id: 5, html_url: "u", body: "x" }, comment: { pull_request_url: "https://api.github.com/repos/o/r/pulls/701" } } }, /refused: b\.md has no pinned sources; run draft-lint\.mjs pr-reply b\.md --pr 701 --repo o\/r \[--pinned-at <file pin-sources ran for>\],/],
    ["figma-comments", ["post", "1:2", "--body-file", "b.md", "--file", "F1"], "@lam Màn này thiếu trạng thái rỗng.", { web: { figma: [] } }, /refused: b\.md has no pinned sources; run draft-lint\.mjs figma-comment b\.md --file F1 --node 1:2 \[--pinned-at <file pin-sources ran for>\],/],
    ["gdoc-comments", ["anchor", "--tab", "t.1", "--quote", "the fee in GRAM", "--body-file", "b.md", "--doc", "D"], "Which wallet pays the fee?", { web: { drive: [], document: textDoc(TAB) } }, /refused: b\.md has no pinned sources; run draft-lint\.mjs doc-comment b\.md --doc D \[--pinned-at <file pin-sources ran for>\],/],
    ["gdoc-comments", ["edit", "c2", "--body-file", "b.md", "--doc", "D"], "Which wallet pays the fee?", { web: { drive: [own], document: textDoc(TAB) } }, /refused: b\.md has no pinned sources; run draft-lint\.mjs doc-comment b\.md --doc D \[--pinned-at <file pin-sources ran for>\],/],
    ["doc-comment-file", ["post", "items.json", "--html", "out.html", "--apply", "--doc", "D"], null, { web: { tabs: { "t.1": TAB }, document: textDoc(TAB) }, map: PRD_MAP }, /refused: items\.json has no pinned sources; run doc-comment-file\.mjs items\.json \[--pinned-at <file pin-sources ran for>\],/],
    ["openproject", ["comment", "21298", "--apply", "--body-file", "b.md"], "The pop-up needs the Pro price.", {}, /refused: b\.md has no pinned sources; run openproject\.mjs comment 21298 --body-file b\.md \[--pinned-at <file pin-sources ran for>\],/],
  ];
  for (const [script, args, body, options, refusal] of cases) {
    await withOpenProject(async (op) => {
      const w = world({ ...options, opUrl: op.url });
      if (body) w.file("b.md", `${body}\n`);
      else w.file("items.json", JSON.stringify({ title: "PRD", items: [ITEM] }));
      w.approve([body ?? `EPIC 09 · tab t.1 · UC_SW_13 BR1\nquote: ${ITEM.quote}\n${ITEM.comment}`, w.line(script, args)].join("\n"));
      op.calls.length = 0;
      const result = await w.run(script, args);
      assert.notEqual(result.code, 0, `${script} ${args[0]}`);
      assert.match(result.out, refusal, `${script} ${args[0]}: ${result.out}`);
      assert.equal(w.tickets(), 1, `${script} ${args[0]}`);
      assert.deepEqual([...sent(w), ...op.calls], [], `${script} ${args[0]}`);
    });
  }
});

test("several Figma replies in one batch do not refuse each other, because a comment is not part of the node JSON", async () => {
  const w = world({ mode: "ask", web: { figma: [root] } });
  const bodies = ["@lam Đã thêm trạng thái rỗng.", "@lam Đã đổi màu nút.", "@lam Đã thêm trạng thái lỗi."];
  for (const [index, body] of bodies.entries()) {
    w.file(`f${index}.md`, `${body}\n`);
    await lint(w, "draft-lint", ["figma-comment", `f${index}.md`, "--file", "F1", "--node", "1-2"]);
  }
  for (const index of bodies.keys()) {
    const result = await w.run("figma-comments", ["reply", "100", "--body-file", `f${index}.md`, "--file", "F1"]);
    assert.equal(result.code, 0, result.out);
    assert.doesNotMatch(result.out, /refused/);
    moveFigma(w);
  }
  assert.equal(w.writes().length, 3);
  assert.equal(web(w).figma.length, 1);
});

test("a Figma post on a node the lint did not pin refuses and names the lint to run", async () => {
  const w = world({ mode: "ask", web: { figma: [] } });
  w.file("f.md", "@lam Màn này thiếu trạng thái rỗng.\n");
  await lint(w, "draft-lint", ["figma-comment", "f.md", "--file", "F1", "--node", "1-2"]);
  const result = await w.run("figma-comments", ["post", "3-4", "--body-file", "f.md", "--file", "F1"]);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /refused: f\.md has no pinned Figma F1 node 3:4; run draft-lint\.mjs figma-comment f\.md --file F1 --node 3:4 \[--pinned-at <file pin-sources ran for>\], then ask the user again/);
  assert.deepEqual(w.writes(), []);
});

test("several Doc replies and anchors in one batch do not refuse each other, because a comment changes no text", async () => {
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
    changeWeb(w, { drive: [thread], document: commented });
  }
  assert.equal(w.writes().length, 3);
});

test("without an own OAuth client a Doc is pinned by its Drive text export: replies in a batch pass, a text change refuses", async () => {
  const w = world({ mode: "ask", web: { drive: [thread], document: textDoc("A\n"), exported: "Crypto takes the price in USDT\n" } });
  w.file("bin/rclone", "#!/usr/bin/env node\nif (process.argv[2] === \"config\") process.stdout.write(JSON.stringify({ gdrive: { token: JSON.stringify({ access_token: \"a\", refresh_token: \"r\", expiry: \"2999-01-01T00:00:00Z\" }) } }));\n");
  const bodies = ["Which wallet pays the fee?", "Is the fee shown before paying?", "Does USDT cover the fee too?"];
  for (const [index, body] of bodies.entries()) w.file(`g${index}.md`, `${body}\n`);
  const pins = await lint(w, "draft-lint", ["doc-comment", "g0.md", "--doc", "D"]);
  assert.match(pins.find((line) => line.startsWith("pinned: ")), /^pinned: Google Doc D text [0-9a-f]{12} via drive-export \(at lint\)$/);
  for (const index of [1, 2]) await lint(w, "draft-lint", ["doc-comment", `g${index}.md`, "--doc", "D"]);
  const withTail = (body, count) => `${body}${"[a][b]".slice(0, 3 * count)}\r\n\r\n${["[a]Which wallet?", "[b]Which wallet pays the fee?"].slice(0, count).join("\r\n")}\r\n`;
  const replied = { ...thread, replies: [{ id: "r1", content: "Which wallet pays the fee?", deleted: false, author: { me: true, displayName: "me" }, createdTime: "2026-10-22T00:00:00Z" }] };
  changeWeb(w, { exported: withTail("Crypto takes the price in USDT", 1) });
  for (const index of [0, 1]) {
    const result = await w.run("gdoc-comments", ["reply", "c1", "--body-file", `g${index}.md`, "--doc", "D"]);
    assert.equal(result.code, 0, result.out);
    assert.doesNotMatch(result.out, /refused|notice/);
    changeWeb(w, { drive: [replied], exported: withTail("Crypto takes the price in USDT", 2) });
  }
  changeWeb(w, { exported: withTail("Crypto takes the price in BTC", 2) });
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

test("read pins of the Doc hold at the lint, and read pins of Figma nodes hold until the post", async () => {
  const sibling = siblingRepo();
  const w = world({ mode: "ask", web: { drive: [thread], document: textDoc(TAB), tabs: { "t.1": TAB } }, map: { ...PRD_MAP, repos: [{ path: sibling.clone, role: "BE", branch: "dev" }] } });
  w.file("ledger.md", "# ledger\n");
  const read = await w.run("draft-lint", ["pin-sources", "ledger.md", "--doc", "D", "--file", "F1", "--node", "1-2,3-4"]);
  assert.equal(read.code, 0, read.out);
  assert.match(read.out, /^pinned: Google Doc D text [0-9a-f]{12} via docs-text \(read \S+\)$/m);
  assert.match(read.out, /^pinned: Figma F1 lastModified \S+ · node 1:2 [0-9a-f]{12}, 3:4 [0-9a-f]{12} \(read \S+\)$/m);
  assert.match((await w.run("draft-lint", ["pin-sources", "ledger.md", "--file", "F1"])).out, /pin-sources --file needs --node <node-id>\[,<node-id>…\]/);
  w.file("g.md", "Which wallet pays the fee?\n");
  w.file("f.md", "@lam Màn này thiếu trạng thái rỗng.\n");
  w.file("f2.md", "@lam Nút này thiếu trạng thái tắt.\n");
  w.file("items.json", JSON.stringify({ title: "PRD", items: [ITEM] }));
  const doc = await w.run("draft-lint", ["doc-comment", "g.md", "--doc", "D", "--pinned-at", "ledger.md"]);
  assert.equal(doc.code, 0, doc.out);
  assert.doesNotMatch(doc.out, /warning:|notice:/);
  changeWeb(w, { document: textDoc(`${TAB}A new paragraph\n`), figmaNodes: { "3:4": { document: { id: "3:4", name: "changed", absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 } } } } });
  const docLint = await w.run("draft-lint", ["doc-comment", "g.md", "--doc", "D", "--pinned-at", "ledger.md"]);
  assert.notEqual(docLint.code, 0);
  assert.match(docLint.out, /^sources: refused: Google Doc D text changed from [0-9a-f]{12} to [0-9a-f]{12} since it was pinned/m);
  const figmaLint = await w.run("draft-lint", ["figma-comment", "f.md", "--file", "F1", "--node", "1-2", "--pinned-at", "ledger.md"]);
  assert.equal(figmaLint.code, 0, figmaLint.out);
  assert.match(figmaLint.out, /^pinned: Figma F1 lastModified \S+ · node 1:2 [0-9a-f]{12} \(read \S+\)$/m);
  assert.doesNotMatch(figmaLint.out, /\b3:4 [0-9a-f]{12}|Google Doc D/);
  const nodeB = await w.run("draft-lint", ["figma-comment", "f2.md", "--file", "F1", "--node", "3-4", "--pinned-at", "ledger.md"]);
  assert.equal(nodeB.code, 0, nodeB.out);
  assert.match(nodeB.out, /^pinned: Figma F1 lastModified \S+ · node 3:4 [0-9a-f]{12} \(read \S+\)$/m);
  const postB = await w.run("figma-comments", ["post", "3-4", "--body-file", "f2.md", "--file", "F1"]);
  assert.notEqual(postB.code, 0);
  assert.match(postB.out, /refused: Figma F1 node 3:4 changed since it was pinned/);
  const items = await w.run("doc-comment-file", ["items.json", "--pinned-at", "ledger.md"]);
  assert.notEqual(items.code, 0);
  assert.match(items.out, /refused: Google Doc D text changed/);
  assert.equal(sent(w).length, 0);
});

test("doc-comment-file post without --apply prints the warnings its lint recorded, for the approval preview", async () => {
  const w = world({ mode: "ask", web: { document: textDoc(TAB), tabs: { "t.1": TAB } }, map: PRD_MAP });
  w.file("items.json", JSON.stringify({ title: "PRD", items: [ITEM] }));
  const lintWarnings = (await lint(w, "doc-comment-file", ["items.json"])).filter((line) => line.startsWith("warning: "));
  assert.ok(lintWarnings.length);
  const dry = await w.run("doc-comment-file", ["post", "items.json", "--html", "out.html"]);
  assert.equal(dry.code, 0, dry.out);
  assert.deepEqual(dry.out.split("\n").filter((line) => line.startsWith("warning: ")), lintWarnings);
  assert.deepEqual(sent(w), []);
});

test("doc-comment-file pins the Doc before it reads the tabs, and with a read pin of the Doc reads it only for the recheck", async () => {
  const w = world({ mode: "ask", web: { document: textDoc(TAB), tabs: { "t.1": TAB } }, map: PRD_MAP });
  const docReads = (from) => w.reads().slice(from).filter((line) => line.startsWith("docs."));
  w.file("items.json", JSON.stringify({ title: "PRD", items: [ITEM] }));
  const bare = await w.run("doc-comment-file", ["items.json"]);
  assert.equal(bare.code, 0, bare.out);
  assert.deepEqual(docReads(0), ["docs.googleapis.com/v1/documents/D", "docs.google.com/document/d/D/export"]);
  w.file("ledger.md", "# ledger\n");
  assert.equal((await w.run("draft-lint", ["pin-sources", "ledger.md", "--doc", "D"])).code, 0);
  const before = w.reads().length;
  w.file("items.json", JSON.stringify({ title: "PRD", items: [ITEM] }));
  const read = await w.run("doc-comment-file", ["items.json", "--pinned-at", "ledger.md"]);
  assert.equal(read.code, 0, read.out);
  assert.match(read.out, /^pinned: Google Doc D text [0-9a-f]{12} via docs-text \(read \S+\)$/m);
  assert.doesNotMatch(read.out, /warning:|\(at lint\)/);
  assert.deepEqual(docReads(before), ["docs.google.com/document/d/D/export", "docs.googleapis.com/v1/documents/D"]);
});

test("a designer's edit to node A does not stop a post on node B, and a Doc change does not stop a Figma post that does not cite the Doc", async () => {
  const w = world({ web: { figma: [], document: textDoc(TAB) } });
  w.file("ledger.md", "# ledger\n");
  assert.equal((await w.run("draft-lint", ["pin-sources", "ledger.md", "--doc", "D", "--file", "F1", "--node", "1-2,3-4"])).code, 0);
  w.file("f.md", "@lam Màn này thiếu trạng thái rỗng.\n");
  const pins = await lint(w, "draft-lint", ["figma-comment", "f.md", "--file", "F1", "--node", "3-4", "--pinned-at", "ledger.md"]);
  changeWeb(w, { figmaModified: "2026-10-02T00:00:00Z", figmaNodes: { "1:2": { document: { id: "1:2", name: "designer edit" } } }, document: textDoc("Rewritten PRD\n") });
  const args = ["post", "3-4", "--body-file", "f.md", "--file", "F1"];
  w.approve(["@lam Màn này thiếu trạng thái rỗng.", ...pins, w.line("figma-comments", args)].join("\n"));
  const posted = await w.run("figma-comments", args);
  assert.equal(posted.code, 0, posted.out);
  assert.match(posted.out, /^notice: Figma F1 lastModified changed .* node 3:4 is unchanged, so it posts as drafted$/m);
  assert.equal(sent(w).length, 1);
});

test("openproject preview, comment and comment-edit keep the read pins of --pinned-at, fail on a change since the read, and warn without them", async () => {
  await withOpenProject(async (op) => {
    const sibling = siblingRepo();
    const w = world({ mode: "ask", opUrl: op.url, map: { name: "p", repos: [{ path: sibling.clone, role: "BE", branch: "dev" }], language: { pr_review: "en" } } });
    const draft = task(FIGMA_NODE);
    w.file("drafts.json", JSON.stringify([draft]));
    const body = `The pop-up needs the Pro price, as ${FIGMA_NODE} shows.`;
    w.file("c.md", `${body}\n`);
    const runs = [
      ["preview", ["preview", "drafts.json", "--project", "183"], "drafts.json"],
      ["comment", ["comment", "21298", "--body-file", "c.md"], "c.md"],
      ["comment-edit", ["comment-edit", "9", "--body-file", "c.md"], "c.md"],
    ];
    for (const [name, args] of runs) {
      const bare = await w.run("openproject", args);
      assert.equal(bare.code, 0, `${name}: ${bare.out}`);
      assert.match(bare.out, /^warning: no read pins for /m, name);
    }
    w.file("ledger.md", "# ledger\n");
    const read = await w.run("draft-lint", ["pin-sources", "ledger.md", "--file", "F1", "--node", "1-2"]);
    assert.equal(read.code, 0, read.out);
    const readLines = read.out.split("\n").filter((line) => line.startsWith("pinned: "));
    const guarded = await w.run("openproject", ["preview", "drafts.json", "--project", "183", "--pinned-at", "ledger.md"]);
    assert.notEqual(guarded.code, 0);
    assert.match(guarded.out, /^sources: the read pins for ledger\.md were taken at \S+, after drafts\.json was last written/m);
    w.file("drafts.json", JSON.stringify([draft]));
    w.file("c.md", `${body}\n`);
    for (const [name, args] of runs) {
      const kept = await w.run("openproject", [...args, "--pinned-at", "ledger.md"]);
      assert.equal(kept.code, 0, `${name}: ${kept.out}`);
      assert.doesNotMatch(kept.out, /warning:|notice:/, name);
      for (const line of readLines) assert.ok(kept.out.includes(`${line}\n`), `${name}: ${line}\n${kept.out}`);
    }
    changeWeb(w, { figmaNodes: { "1:2": { document: { id: "1:2", name: "changed" } } } });
    const reads = w.reads().length;
    const unasked = await w.run("openproject", ["comment", "21298", "--body-file", "c.md", "--pinned-at", "ledger.md"]);
    assert.equal(unasked.code, 0, unasked.out);
    assert.deepEqual(w.reads().slice(reads), []);
    sibling.push("docs/Pro", "x\n", "docs: change the Pro plan");
    for (const [name, args, file] of runs) {
      const stateFile = join(w.dir, "state", "drafts", `${join(w.dir, file).replace(/\//g, "_")}.sources.json`);
      const before = readFileSync(stateFile, "utf8");
      const failed = await w.run("openproject", [...args, "--pinned-at", "ledger.md"]);
      assert.notEqual(failed.code, 0, name);
      assert.match(failed.out, /^sources: refused: .* changed a file the text being posted names$/m, `${name}: ${failed.out}`);
      assert.match(failed.out, /^sources: a source changed while it was being read; run draft-lint\.mjs pin-sources ledger\.md again/m, name);
      assert.doesNotMatch(failed.out, /^WRITE →.*run again with --apply|approval lines:/m, name);
      assert.equal(readFileSync(stateFile, "utf8"), before, name);
    }
  });
});

test("a branch cite that no repo pins warns at the lint, and the post needs that warning in its approval", async () => {
  const { w, draft } = gitWorld();
  const cited = draft.replace("`src/a.ts:1@dev`", "`src/a.ts:1@release/9`");
  w.file("d.md", cited);
  const pins = await lint(w, "draft-lint", ["pr-comment", "d.md", "--repo", "o/r"]);
  const warning = "warning: the cite @release/9 pins nothing: no repo in the project map has origin/release/9; check the branch name, or add pin-sources --branch <repo>:release/9 before the read";
  assert.ok(pins.includes(warning), pins.join("\n"));
  const args = ["post", "d.md", "--repo", "o/r"];
  w.approve([cited, ...pins.filter((line) => line !== warning), w.line("github-write", args)].join("\n"));
  const unwarned = await w.run("github-write", args);
  assert.match(unwarned.out, /no unused approval matches this write/, unwarned.out);
  assert.deepEqual(sent(w), []);
  w.approve([cited, ...pins, w.line("github-write", args)].join("\n"));
  const posted = await w.run("github-write", args);
  assert.equal(posted.code, 0, posted.out);
  assert.equal(sent(w).length, 1);
});

test("the Doc and OpenProject lints record the warning of a branch cite that no repo pins", async () => {
  const warning = "warning: the cite @release/9 pins nothing: no repo in the project map has origin/release/9; check the branch name, or add pin-sources --branch <repo>:release/9 before the read";
  const cite = "Does src/fee.ts:4@release/9 still charge the payer?";
  const sibling = siblingRepo();
  const map = { ...PRD_MAP, repos: [{ path: sibling.clone, role: "BE", branch: "dev" }] };
  const recorded = (w, name) => JSON.parse(readFileSync(join(w.dir, "state", "drafts", `${join(w.dir, name).replace(/\//g, "_")}.sources.json`), "utf8")).warnings;
  await withOpenProject(async (op) => {
    const w = world({ mode: "ask", opUrl: op.url, web: { tabs: { "t.1": TAB }, document: textDoc(TAB) }, map });
    w.file("g.md", `${cite}\n`);
    w.file("items.json", JSON.stringify({ title: "PRD", items: [{ ...ITEM, comment: cite }] }));
    w.file("c.md", `${cite}\n`);
    for (const [name, script, args] of [["g.md", "draft-lint", ["doc-comment", "g.md", "--doc", "D"]], ["items.json", "doc-comment-file", ["items.json"]], ["c.md", "openproject", ["comment", "21298", "--body-file", "c.md"]]]) {
      const pins = await lint(w, script, args);
      assert.ok(pins.includes(warning), `${script}: ${pins.join("\n")}`);
      assert.ok(recorded(w, name).includes(warning), script);
    }
  });
});

test("a Doc writer rechecks the read git pins against the body it posts", async () => {
  const sibling = siblingRepo();
  const w = world({ mode: "ask", web: { drive: [thread], document: textDoc(TAB) }, map: { name: "p", repos: [{ path: sibling.clone, role: "BE", branch: "dev" }], language: { doc_figma: "en" } } });
  w.file("ledger.md", "# ledger\n");
  assert.equal((await w.run("draft-lint", ["pin-sources", "ledger.md", "--doc", "D"])).code, 0);
  w.file("g.md", "Does the fees.md rule still hold?\n");
  assert.equal((await w.run("draft-lint", ["doc-comment", "g.md", "--doc", "D", "--pinned-at", "ledger.md"])).code, 0);
  sibling.push("docs/fees.md", "new\n", "docs: change the fee rule");
  const result = await w.run("gdoc-comments", ["reply", "c1", "--body-file", "g.md", "--doc", "D"]);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /refused: .* since it was pinned and changed a file the text being posted names/);
  assert.deepEqual(w.writes(), []);
});

test("a figma-comment lint on a node the read pins lack pins it at lint and warns", async () => {
  const w = world({ mode: "ask", web: { figma: [] } });
  w.file("ledger.md", "# ledger\n");
  assert.equal((await w.run("draft-lint", ["pin-sources", "ledger.md", "--file", "F1", "--node", "1-2"])).code, 0);
  w.file("f.md", "@lam Màn này thiếu trạng thái rỗng.\n");
  const result = await w.run("draft-lint", ["figma-comment", "f.md", "--file", "F1", "--node", "5-6", "--pinned-at", "ledger.md"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /^warning: Figma F1 node 5:6 was not pinned by draft-lint\.mjs pin-sources ledger\.md, so it was pinned now, at lint$/m);
});

test("a read pin of some nodes does not narrow a draft that links the whole file: the whole file is pinned at lint and any edit refuses", async () => {
  const w = world({ mode: "ask", web: { figma: [] } });
  w.file("ledger.md", "# ledger\n");
  assert.equal((await w.run("draft-lint", ["pin-sources", "ledger.md", "--file", "F1", "--node", "1-2"])).code, 0);
  w.file("f.md", "@lam Màn này thiếu trạng thái rỗng, xem https://www.figma.com/design/F1/App.\n");
  const result = await w.run("draft-lint", ["figma-comment", "f.md", "--file", "F1", "--node", "1-2", "--pinned-at", "ledger.md"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /^pinned: Figma F1 lastModified \S+ · node 1:2 [0-9a-f]{12} \(read \S+\)$/m);
  assert.match(result.out, /^pinned: Figma F1 lastModified \S+ · node 1:2 [0-9a-f]{12} · whole file \(at lint\)$/m);
  assert.match(result.out, /^warning: Figma F1 file was not pinned by draft-lint\.mjs pin-sources ledger\.md, so it was pinned now, at lint$/m);
  moveFigma(w);
  const posted = await w.run("figma-comments", ["post", "1-2", "--body-file", "f.md", "--file", "F1"]);
  assert.notEqual(posted.code, 0);
  assert.match(posted.out, /refused: Figma F1 lastModified changed from \S+ to \S+ since it was pinned and the draft links the whole file, not a node/);
  assert.deepEqual(sent(w), []);
});

test("every lint pins the links in its text and the map repos, and figma-comment warns without --node", async () => {
  const doc = "https://docs.google.com/document/d/D2/edit";
  const figma = world({ mode: "ask", web: { figma: [], document: textDoc(TAB) }, map: { name: "p", repos: [{ path: ".", role: "FE", branch: "dev" }], language: { doc_figma: "en", pr_review: "en" } } });
  figma.file("f.md", `@lam Màn này thiếu trạng thái rỗng như ${doc} ghi.\n`);
  const pinned = await lint(figma, "draft-lint", ["figma-comment", "f.md", "--file", "F1"]);
  assert.ok(pinned.some((line) => line.startsWith("pinned: Google Doc D2 ")), pinned.join("\n"));
  assert.ok(pinned.some((line) => line.startsWith("pinned: . origin/dev@")), pinned.join("\n"));
  assert.match((await figma.run("draft-lint", ["figma-comment", "f.md", "--file", "F1"])).out, /^warning: no --node, so Figma F1 is pinned as a whole file and any edit to it refuses the post/m);
  const record = JSON.parse(readFileSync(join(figma.dir, "state", "drafts", `${join(figma.dir, "f.md").replace(/\//g, "_")}.sources.json`), "utf8"));
  assert.deepEqual(record.warnings.map((line) => line.split(",")[0]), ["warning: no --node", "warning: no read pins for f.md"]);
  const review = world({ pr: 701, gh: POSTED, web: { document: textDoc(TAB) }, map: { name: "p", repos: [{ path: ".", role: "FE", branch: "dev" }], language: { pr_review: "en" } } });
  review.file("d.md", DRAFT.replace("sets it.", `sets it, see ${FIGMA_NODE}.`));
  const reviewPins = await lint(review, "draft-lint", ["pr-comment", "d.md"]);
  assert.ok(reviewPins.some((line) => line.startsWith("pinned: Figma F1 ")), reviewPins.join("\n"));
  assert.ok(reviewPins.some((line) => line.startsWith("pinned: . pull/701/head@")), reviewPins.join("\n"));
});

const tierOne = (w, from = 0) => w.reads().slice(from).filter((line) => /^\/v1\/files\/[^/?]+(?:\/nodes)?\?/.test(line));

test("a Figma comment costs at most one Tier 1 call: the lint reuses read pins that cover its nodes, and the post rechecks from the call that finds the node", async () => {
  const w = world({ mode: "ask", web: { figma: [] } });
  w.file("ledger.md", "# ledger\n");
  assert.equal((await w.run("draft-lint", ["pin-sources", "ledger.md", "--file", "F1", "--node", "1-2,3-4"])).code, 0);
  assert.equal(tierOne(w).length, 1, w.reads().join("\n"));
  w.file("f.md", "@lam Màn này thiếu trạng thái rỗng.\n");
  let from = w.reads().length;
  const pinned = await lint(w, "draft-lint", ["figma-comment", "f.md", "--file", "F1", "--node", "1-2", "--pinned-at", "ledger.md"]);
  assert.deepEqual(tierOne(w, from), []);
  assert.ok(pinned.some((line) => /^pinned: Figma F1 lastModified \S+ · node 1:2 [0-9a-f]{12} \(read \S+\)$/.test(line)), pinned.join("\n"));
  from = w.reads().length;
  const posted = await w.run("figma-comments", ["post", "1-2", "--body-file", "f.md", "--file", "F1"]);
  assert.equal(posted.code, 0, posted.out);
  assert.equal(tierOne(w, from).length, 1, w.reads().slice(from).join("\n"));
  w.file("f3.md", "@lam Màn này lệch với https://www.figma.com/design/F1/App?node-id=3-4 nha.\n");
  await lint(w, "draft-lint", ["figma-comment", "f3.md", "--file", "F1", "--node", "1-2", "--pinned-at", "ledger.md"]);
  from = w.reads().length;
  const linked = await w.run("figma-comments", ["post", "1-2", "--body-file", "f3.md", "--file", "F1"]);
  assert.equal(linked.code, 0, linked.out);
  assert.deepEqual(tierOne(w, from), ["/v1/files/F1/nodes?ids=1%3A2%2C3%3A4"]);
  changeWeb(w, { figmaNodes: { "1:2": { document: { id: "1:2", name: "changed", absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 } } } } });
  w.file("f2.md", "@lam Nút này thiếu trạng thái tắt.\n");
  await lint(w, "draft-lint", ["figma-comment", "f2.md", "--file", "F1", "--node", "1-2", "--pinned-at", "ledger.md"]);
  const refused = await w.run("figma-comments", ["post", "1-2", "--body-file", "f2.md", "--file", "F1"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /refused: Figma F1 node 1:2 changed since it was pinned/);
});

test("a draft that links several nodes of one Figma file pins them with one call", async () => {
  const w = world({ mode: "ask", web: { figma: [] } });
  w.file("f.md", "@lam Hai màn https://www.figma.com/design/F1/App?node-id=1-2 và https://www.figma.com/design/F1/App?node-id=3-4 lệch nhau.\n");
  const pinned = await lint(w, "draft-lint", ["figma-comment", "f.md", "--file", "F1", "--node", "5-6"]);
  assert.ok(pinned.some((line) => /node 5:6 [0-9a-f]{12}, 1:2 [0-9a-f]{12}, 3:4 [0-9a-f]{12}/.test(line)), pinned.join("\n"));
  assert.equal(tierOne(w).length, 1, w.reads().join("\n"));
});

test("a Drive file that is not a Doc is pinned by its md5Checksum, or its modifiedTime, and a change to it refuses", async () => {
  const pdf = { mimeType: "application/pdf", md5Checksum: "aa11", modifiedTime: "2026-10-01T00:00:00Z" };
  const video = { mimeType: "video/mp4", modifiedTime: "2026-10-01T00:00:00Z" };
  const w = world({ mode: "ask", web: { drive: [thread], document: textDoc(TAB), driveFiles: { Kq8pdf: pdf, Zt3vid: video } } });
  w.file("g.md", "Is the fee in https://drive.google.com/file/d/Kq8pdf/view and https://drive.google.com/open?id=Zt3vid the same as https://drive.google.com/open?id=Gd7doc?\n");
  const pinned = await lint(w, "draft-lint", ["doc-comment", "g.md", "--doc", "D"]);
  assert.ok(pinned.some((line) => /^pinned: Google Doc Gd7doc text [0-9a-f]{12} via docs-text \(at lint\)$/.test(line)), pinned.join("\n"));
  assert.ok(pinned.includes("pinned: Drive file Kq8pdf md5 aa11 (at lint)"), pinned.join("\n"));
  assert.ok(pinned.includes("pinned: Drive file Zt3vid modified 2026-10-01T00:00:00Z (at lint)"), pinned.join("\n"));
  const args = ["reply", "c1", "--body-file", "g.md", "--doc", "D"];
  changeWeb(w, { driveFiles: { Kq8pdf: { ...pdf, md5Checksum: "bb22" }, Zt3vid: video } });
  const refused = await w.run("gdoc-comments", args);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /refused: Drive file Kq8pdf changed from md5 aa11 to md5 bb22 since it was pinned/);
  changeWeb(w, { driveFiles: { Kq8pdf: pdf, Zt3vid: video } });
  const posted = await w.run("gdoc-comments", args);
  assert.equal(posted.code, 0, posted.out);
  assert.equal(w.writes().length, 1);
});

test("a Drive shortcut pins the file it points to, Sheets and Slides pin their modifiedTime, and a Drive folder fails the lint", async () => {
  const pdf = { mimeType: "application/pdf", md5Checksum: "aa11" };
  const files = {
    Sc1pdf: { mimeType: "application/vnd.google-apps.shortcut", modifiedTime: "2026-09-01T00:00:00Z", shortcutDetails: { targetId: "Kq8pdf", targetMimeType: "application/pdf" } },
    Sc2doc: { mimeType: "application/vnd.google-apps.shortcut", modifiedTime: "2026-09-01T00:00:00Z", shortcutDetails: { targetId: "Gd7doc", targetMimeType: "application/vnd.google-apps.document" } },
    Kq8pdf: pdf,
    Sh4fee: { mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-10-02T00:00:00Z" },
    Pr5deck: { mimeType: "application/vnd.google-apps.presentation", modifiedTime: "2026-10-03T00:00:00Z" },
    Fo6dir: { mimeType: "application/vnd.google-apps.folder", modifiedTime: "2026-10-04T00:00:00Z" },
    Sc3dir: { mimeType: "application/vnd.google-apps.shortcut", modifiedTime: "2026-09-01T00:00:00Z", shortcutDetails: { targetId: "Fo6dir", targetMimeType: "application/vnd.google-apps.folder" } },
  };
  const w = world({ mode: "ask", web: { drive: [thread], document: textDoc(TAB), driveFiles: files } });
  w.file("g.md", "Do https://drive.google.com/file/d/Sc1pdf/view, https://drive.google.com/open?id=Sc2doc, https://docs.google.com/spreadsheets/d/Sh4fee/edit and https://docs.google.com/presentation/d/Pr5deck/edit agree on the fee?\n");
  const pinned = await lint(w, "draft-lint", ["doc-comment", "g.md", "--doc", "D"]);
  for (const line of ["pinned: Drive file Kq8pdf md5 aa11 (at lint)", "pinned: Drive file Sh4fee modified 2026-10-02T00:00:00Z (at lint)", "pinned: Drive file Pr5deck modified 2026-10-03T00:00:00Z (at lint)"]) assert.ok(pinned.includes(line), `${line}\n${pinned.join("\n")}`);
  assert.ok(pinned.some((line) => /^pinned: Google Doc Gd7doc text [0-9a-f]{12} via docs-text \(at lint\)$/.test(line)), pinned.join("\n"));
  changeWeb(w, { driveFiles: { ...files, Kq8pdf: { ...pdf, md5Checksum: "bb22" } } });
  const refused = await w.run("gdoc-comments", ["reply", "c1", "--body-file", "g.md", "--doc", "D"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /refused: Drive file Kq8pdf changed from md5 aa11 to md5 bb22 since it was pinned/);
  for (const link of ["https://drive.google.com/drive/folders/Fo6dir", "https://drive.google.com/open?id=Fo6dir", "https://drive.google.com/open?id=Sc3dir"]) {
    w.file("h.md", `Is the fee sheet in ${link} still current?\n`);
    const folder = await w.run("draft-lint", ["doc-comment", "h.md", "--doc", "D"]);
    assert.notEqual(folder.code, 0, link);
    assert.match(folder.out, /Fo6dir is a Drive folder, which cannot be pinned; link the files in it/, `${link}\n${folder.out}`);
    assert.doesNotMatch(folder.out, /^clean:/m, link);
  }
});

test("a Figma 429 refuses after one call, without retrying", async () => {
  const w = world({ mode: "ask", web: { figma: [] } });
  w.file("f.md", "@lam Màn này thiếu trạng thái rỗng.\n");
  await lint(w, "draft-lint", ["figma-comment", "f.md", "--file", "F1", "--node", "1-2"]);
  changeWeb(w, { figma429: true });
  const before = w.reads().length;
  const result = await w.run("figma-comments", ["post", "1-2", "--body-file", "f.md", "--file", "F1"]);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /Figma answered HTTP 429 to \/files\/F1\/nodes \(Retry-After 30 s\)/);
  assert.equal(w.reads().length - before, 1, w.reads().slice(before).join("\n"));
  assert.deepEqual(w.writes(), []);
});

test("a Figma post on an instance node reads and posts the whole instance id", async () => {
  const w = world({ mode: "ask", web: { figma: [] } });
  w.file("f.md", "@lam Màn này thiếu trạng thái rỗng.\n");
  await lint(w, "draft-lint", ["figma-comment", "f.md", "--file", "F1", "--node", "I1-2;3-4"]);
  const posted = await w.run("figma-comments", ["post", "I1-2;3-4", "--body-file", "f.md", "--file", "F1"]);
  assert.equal(posted.code, 0, posted.out);
  assert.match(posted.out, /^WRITE → Figma F1 node I1:2;3:4 : 1 comment$/m);
  assert.equal(web(w).figma.length, 0);
  assert.ok(w.reads().some((line) => line.includes("ids=I1%3A2%3B3%3A4")), w.reads().join("\n"));
});

test("a corrupt sources record refuses with a clear message and writes nothing", async () => {
  const w = world({ mode: "ask", web: { drive: [thread], document: textDoc(TAB) } });
  w.file("g.md", "Which wallet pays the fee?\n");
  await lint(w, "draft-lint", ["doc-comment", "g.md", "--doc", "D"]);
  const drafts = join(w.dir, "state", "drafts");
  mkdirSync(drafts, { recursive: true });
  const [record] = readdirSync(drafts).filter((name) => name.endsWith(".sources.json"));
  writeFileSync(join(drafts, record), "{ broken");
  const result = await w.run("gdoc-comments", ["reply", "c1", "--body-file", "g.md", "--doc", "D"]);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /refused: the sources record for g\.md cannot be read \(.+\); run draft-lint\.mjs doc-comment g\.md --doc D \[--pinned-at <file pin-sources ran for>\], then ask the user again/);
  assert.deepEqual(w.writes(), []);
});
