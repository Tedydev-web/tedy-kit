import { test } from "node:test";
import assert from "node:assert/strict";
import { alreadyOnPr, buildReviewPayload, labelEdits, replyExists, verifyComment } from "./github-write.mjs";

const c = (path, line, body) => ({ path, line, body });

test("labelEdits compares the frozen draft with the final text by path:line", () => {
  const draft = [
    c("a.ts", 1, "Nút đang sai ạ.\n\nPRD EPIC 09 · UC_SW_08 step 3:\n> button Ask the group."),
    c("a.ts", 2, "Toast dư dấu chấm ạ."),
    c("b.ts", 5, "Sheet đóng sớm ạ."),
    c("c.ts", 9, "Thiếu helper ạ."),
  ];
  const final = [
    c("a.ts", 1, "Nút đang sai ạ."),
    c("a.ts", 2, "Toast dư dấu chấm ạ."),
    c("b.ts", 5, "Sheet đóng trước khi gọi API ạ."),
    c("d.ts", 3, "Anh tự thêm ạ."),
  ];
  assert.deepEqual(labelEdits(draft, final).map((entry) => `${entry.key} ${entry.label}`), ["a.ts:1 trimmed", "a.ts:2 unchanged", "b.ts:5 edited", "c.ts:9 cut", "d.ts:3 added"]);
});

test("the review payload posts inline comments only, as COMMENT, pinned to the commit", () => {
  const payload = buildReviewPayload([c("a.ts", 1, "x ạ.")], "f".repeat(40));
  assert.deepEqual(payload, { commit_id: "f".repeat(40), event: "COMMENT", comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "x ạ." }] });
  assert.equal("body" in payload, false);
});

const PRD = "\tUC_SW_08: Hand Over Ownership\r\n\tOrdinary Sequence\r\n3. System — Confirm sheet; button Ask the group.\r\n";
const sources = { prd: { "09": PRD }, diff: '+  <Button>Ask the family</Button>\n+  title="Hint"', inRepo: (text) => text === "propose" };

test("a verbatim PRD quote, a known use case and copy found in the diff pass", () => {
  const result = verifyComment(c("a.ts", 1, 'Nút đang là "Ask the family" ạ.\n\nPRD EPIC 09 · UC_SW_08 step 3:\n> button Ask the group.'), sources);
  assert.deepEqual(result, { refusals: [], unverified: [] });
});

test("a paraphrased quote, an unknown use case or a missing PRD tab is refused", () => {
  const body = (header, quote) => `Nút sai ạ.\n\n${header}\n> ${quote}`;
  assert.match(verifyComment(c("a.ts", 1, body("PRD EPIC 09 · UC_SW_08 step 3:", "button Ask the family.")), sources).refusals[0], /not verbatim/);
  assert.match(verifyComment(c("a.ts", 1, body("PRD EPIC 09 · UC_SW_99 step 3:", "button Ask the group.")), sources).refusals[0], /UC_SW_99/);
  assert.match(verifyComment(c("a.ts", 1, body("PRD EPIC 07 · UC_LG_01 step 1:", "x")), sources).refusals[0], /EPIC 07/);
});

test("quoted copy must come from the diff, the repository or the PRD unless the sentence links its Figma frame", () => {
  const frame = "https://www.figma.com/design/FakeFigmaKeyyyyyyyyyyy/Family-Wallet-UI?node-id=3846-8503&m=dev";
  assert.deepEqual(verifyComment(c("a.ts", 1, 'Câu lỗi lại ghi "propose" ạ.'), sources).refusals, []);
  assert.match(verifyComment(c("a.ts", 1, 'Nút đang là "Ask the crew" ạ.'), sources).refusals[0], /Ask the crew/);
  assert.deepEqual(verifyComment(c("a.ts", 1, `Ô tên chưa có counter, [Figma](${frame}) có "10/30" ạ.`), sources), { refusals: [], unverified: ['"10/30" (Figma 3846:8503)'] });
  assert.match(verifyComment(c("a.ts", 1, 'Ô tên chưa có counter, Figma 3846:8503 có "10/30" ạ.'), sources).refusals[0], /10\/30/);
});

test("draft comments already on the PR are found by path and text, wherever the line moved", () => {
  const existing = [
    { id: 901, path: "a.ts", line: 14, body: "Nút đang sai ạ.\n\nPRD EPIC 09 · UC_SW_08 step 3:\n> button Ask the group." },
    { id: 902, path: "b.ts", line: 5, body: "Sheet đóng sớm ạ.", in_reply_to_id: 800 },
  ];
  const draft = [c("a.ts", 12, "Nút đang sai ạ.\n\nPRD EPIC 09 · UC_SW_08 step 3:\n>  button Ask the group."), c("b.ts", 5, "Sheet đóng sớm ạ."), c("a.ts", 20, "Toast dư dấu chấm ạ.")];
  assert.deepEqual(alreadyOnPr(existing, draft).map((twin) => [twin.comment.line, twin.id]), [[12, 901]]);
  assert.equal(replyExists(existing, 800, "Sheet  đóng sớm ạ."), 902);
  assert.equal(replyExists(existing, 801, "Sheet đóng sớm ạ."), null);
});
