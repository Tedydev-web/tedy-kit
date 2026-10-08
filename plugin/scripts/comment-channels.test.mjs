import { test } from "node:test";
import assert from "node:assert/strict";
import { duplicateOnNode, duplicateReply, pinOffset, rootOf, threadsSince } from "./figma-comments.mjs";
import { alreadyPosted, findQuoteRange, tokenFromDump } from "./gdoc-comments.mjs";

test("a Figma pin sits at half the width and three quarters of the height of the node", () => {
  assert.deepEqual(pinOffset({ x: 100, y: 200, width: 375, height: 812 }), { x: 188, y: 609 });
});

test("replies go to the root of a thread, never to a reply", () => {
  const comments = [{ id: "1", parent_id: "" }, { id: "2", parent_id: "1" }];
  assert.equal(rootOf(comments, "1").id, "1");
  assert.throws(() => rootOf(comments, "2"), /reply to 1/);
  assert.throws(() => rootOf(comments, "9"), /not found/);
});

test("threadsSince groups replies under their root and keeps threads touched after the mark", () => {
  const comments = [
    { id: "1", parent_id: "", created_at: "2026-10-01T00:00:00Z", user: { handle: "Lâm Trần" }, message: "@a x nha", client_meta: { node_id: "1:2" } },
    { id: "2", parent_id: "1", created_at: "2026-10-06T00:00:00Z", user: { handle: "pm_minh" }, message: "ok" },
    { id: "3", parent_id: "", created_at: "2026-09-01T00:00:00Z", user: { handle: "Lâm Trần" }, message: "old" },
  ];
  const threads = threadsSince(comments, "2026-10-05T00:00:00Z");
  assert.equal(threads.length, 1);
  assert.equal(threads[0].root.id, "1");
  assert.deepEqual(threads[0].replies.map((reply) => reply.id), ["2"]);
});

test("tokenFromDump reads the remote's token and whether it has its own OAuth client", () => {
  const dump = JSON.stringify({ gdrive: { type: "drive", client_id: "", token: JSON.stringify({ access_token: "a1", refresh_token: "r1", expiry: "2026-10-07T13:46:00+07:00" }) } });
  assert.deepEqual(tokenFromDump(dump, "gdrive"), { access: "a1", refresh: "r1", expiry: Date.parse("2026-10-07T13:46:00+07:00"), clientId: "", clientSecret: "" });
  assert.throws(() => tokenFromDump(dump, "other"), /no rclone remote "other"/);
});

test("findQuoteRange maps a quote across text runs to UTF-16 document indexes in the right tab", () => {
  const document = {
    tabs: [
      { tabProperties: { tabId: "t.0" }, documentTab: { body: { content: [] } } },
      {
        tabProperties: { tabId: "t.p59op2unmr" },
        documentTab: {
          body: {
            content: [
              { startIndex: 1, paragraph: { elements: [{ startIndex: 1, textRun: { content: "Step 3: button " } }, { startIndex: 16, textRun: { content: "Ask the group.\n" } }] } },
              { startIndex: 31, paragraph: { elements: [{ startIndex: 31, textRun: { content: "Tiếp theo\n" } }] } },
            ],
          },
        },
      },
    ],
  };
  assert.deepEqual(findQuoteRange(document, "t.p59op2unmr", "button Ask the group."), { startIndex: 9, endIndex: 30, tabId: "t.p59op2unmr" });
  assert.deepEqual(findQuoteRange(document, "t.p59op2unmr", "Tiếp"), { startIndex: 31, endIndex: 35, tabId: "t.p59op2unmr" });
  assert.throws(() => findQuoteRange(document, "t.p59op2unmr", "Ask the family"), /not found/);
  assert.throws(() => findQuoteRange(document, "t.p59op2unmr", "t"), /appears \d+ times/);
});

test("a Figma post that repeats an open comment on the same node is caught; another node or a resolved thread is not", () => {
  const comments = [
    { id: "1", parent_id: "", resolved_at: null, client_meta: { node_id: "3445:6702" }, message: "@pm_minh  nút này\nđổi tên chưa a?" },
    { id: "2", parent_id: "", resolved_at: "2026-10-01T00:00:00Z", client_meta: { node_id: "3445:6703" }, message: "@pm_minh nút này đổi tên chưa a?" },
  ];
  assert.equal(duplicateOnNode(comments, "3445:6702", "@pm_minh nút này đổi tên chưa a?").id, "1");
  assert.equal(duplicateOnNode(comments, "3445:6703", "@pm_minh nút này đổi tên chưa a?"), undefined);
  assert.equal(duplicateOnNode(comments, "3445:6702", "@pm_minh câu khác nha"), undefined);
});

test("figma-read lists frames with ids and the exact copy of every text layer, indented by depth", async () => {
  const { textLines } = await import("./figma-read.mjs");
  const tree = { type: "FRAME", name: "Name and photo", id: "3846:8420", children: [{ type: "TEXT", characters: "Change  photo\n" }, { type: "GROUP", name: "Actions", id: "3846:9", children: [{ type: "TEXT", characters: "Save" }] }] };
  assert.deepEqual(textLines(tree), ['frame Name and photo (3846:8420)', '  "Change photo"', "  group Actions (3846:9)", '    "Save"']);
});

test("a Figma reply already in the thread is found, whitespace aside", () => {
  const comments = [
    { id: "1", message: "@an frame thiếu state lỗi a", parent_id: "" },
    { id: "2", message: "@an  xong rồi\nnha", parent_id: "1" },
    { id: "3", message: "@an xong rồi nha", parent_id: "9" },
  ];
  assert.equal(duplicateReply(comments, "1", "@an xong rồi nha").id, "2");
  assert.equal(duplicateReply(comments, "1", "@an chưa xong"), undefined);
});

test("a Doc reply or anchored comment already posted is found before posting again", () => {
  const comments = [
    { id: "AAA", content: "Câu hỏi cũ a?", resolved: false, replies: [{ content: "E hỏi thêm:  ví nào trả a?" }] },
    { id: "BBB", content: "Mục này PRD ghi 30 ký tự a?", resolved: false, replies: [] },
  ];
  assert.ok(alreadyPosted(comments, "reply", "AAA", "E hỏi thêm: ví nào trả a?"));
  assert.ok(!alreadyPosted(comments, "reply", "BBB", "E hỏi thêm: ví nào trả a?"));
  assert.ok(alreadyPosted(comments, "anchor", undefined, "Mục này PRD ghi 30 ký tự a?"));
  assert.ok(!alreadyPosted(comments, "anchor", undefined, "Câu hỏi mới a?"));
});
