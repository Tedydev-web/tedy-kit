import { test } from "node:test";
import assert from "node:assert/strict";
import { checkItems, renderFile } from "./doc-comment-file.mjs";
import { quoteCount } from "./prd-section.mjs";

const TAB = "UC_SW_13 Pay\nCrypto takes the price in USDT and the fee in GRAM from the payer[a]\nThe fee is shown once.\nthe FEE is shown once.\nSplit across\nlines here.\n[a]A reviewer comment mentioning Crypto takes the price in USDT\n";
const tabOf = (epic) => ({ "09": "t.9" })[epic];
const item = (overrides) => ({ group: "A", epic: "09", where: "UC_SW_13 BR1", quote: "Crypto takes the price in USDT and the fee in GRAM from the payer", comment: "Ví nào trả a?", ...overrides });

test("quoteCount matches like Ctrl+F: case-insensitive, within one paragraph, ignoring the comment footer", () => {
  assert.equal(quoteCount("crypto takes the price in USDT", TAB), 1);
  assert.equal(quoteCount("the fee is shown once.", TAB), 2);
  assert.equal(quoteCount("Split across lines here.", TAB), 0);
  assert.equal(quoteCount("   ", TAB), 0);
});

test("checkItems passes a passage found exactly once and a clean comment", () => {
  assert.deepEqual(checkItems([item({})], { "t.9": TAB }, tabOf), []);
});

test("checkItems refuses passages found zero or several times, tagged comments, unknown epics and groups", () => {
  const problems = checkItems(
    [item({ quote: "The fee is shown once." }), item({ quote: "not in the PRD" }), item({ comment: "@Hùng xem giúp e" }), item({ epic: "99" }), item({ group: "C" })],
    { "t.9": TAB },
    tabOf,
  );
  assert.match(problems[0], /#1 .*appears 2 times/);
  assert.match(problems[1], /#2 .*appears 0 times/);
  assert.match(problems[2], /#3 .*tags nobody/);
  assert.match(problems[3], /#4 .*no PRD tab for EPIC 99/);
  assert.match(problems[4], /#5 .*group must be A or B/);
});

test("renderFile numbers group A before group B and escapes text in attributes", () => {
  const html = renderFile({
    title: "UC_SW_13",
    doc: "DOC",
    checkedAt: "08/10 09:30",
    items: [item({ group: "B", where: "B1", comment: 'PM chốt "giữ" rồi, a ghi vào PRD giúp e nha' }), item({ where: "A1" })],
  });
  assert.ok(html.indexOf("A1") < html.indexOf("B1"));
  assert.match(html, /Nhóm A \(1–1\)/);
  assert.match(html, /Nhóm B \(2–2\)/);
  assert.match(html, /data-t="PM chốt &quot;giữ&quot; rồi/);
  assert.match(html, /\(2 cái\)/);
});
