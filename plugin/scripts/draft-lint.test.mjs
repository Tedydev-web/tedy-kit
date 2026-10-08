import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, lintChatComment, lintComment, lintDraft, parseDraft } from "./draft-lint.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const REAL = [
  { path: "src/cart/cart-store.ts", line: 120, body: "Toast đang là câu chung, chưa đúng copy PRD ạ.\n\nPRD EPIC 03 · UC_CT_04 BR2:\n> BR2 (Toast): \"{Item} added to your cart\", or \"{Item} is out of stock\"." },
  { path: "src/cart/components/cart-sheet.tsx", line: 88, body: "Sheet đóng trước khi gọi API, nên lỗi thì chỉ còn toast ạ.\n\nPRD EPIC 03 · UC_CT_04 Error States:\n> Backend unavailable → retry line in the sheet; the cart stays as it was." },
  { path: "src/checkout/lib/pay-gate.ts", line: 29, body: "FE coi thẻ quà tặng là một bước chặn, trong khi PRD không tính đây là bước chặn ạ.\n\nPRD EPIC 05 · UC_PY_03 BR1:\n> Nothing else blocks a payment — no per-order limit, no store-wide ceiling." },
  { path: "src/settings/components/settings-store-handover-sheet.tsx", line: 62, body: "Hint đang ghi \"The owner decides.\", PM đã chốt dùng \"shop\" thay \"store\" cho toàn app ạ.\n\nPRD EPIC 09 · UC_ST_08 step 1:\n> The shop decides." },
  { path: "src/orders/hooks/use-order-totals.ts", line: 40, body: "BE dev chưa trả `paidAmount` / `paidFormatted`, nên đơn nào cũng hiện \"Unpaid\", kể cả đơn đã trả ạ." },
];

const draft = (comments, header = "# PR #703: comment line by line (head 22288559)") =>
  `${header}\n\n${comments.map((comment, index) => `## ${index + 1}. \`${comment.path}:${comment.line}\`\n\n${comment.body}\n\n---\n`).join("\n")}`;

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,4 +10,5 @@ export function a() {",
  " const x = 1;",
  "-const y = 2;",
  "+const y = 3;",
  "+const z = 4;",
  " return x;",
  "\\ No newline at end of file",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-old",
].join("\n");

test("real comments written after the last style correction lint clean", () => {
  for (const comment of REAL) assert.deepEqual(lintComment(comment.body, "vi"), [], comment.body);
});

test("parseDraft reads the header, sections and bodies, and accepts the older em dash header", () => {
  const parsed = parseDraft(draft(REAL.slice(0, 2)));
  assert.equal(parsed.pr, 703);
  assert.equal(parsed.sha, "22288559");
  assert.deepEqual(parsed.comments.map((comment) => `${comment.index} ${comment.path}:${comment.line}`), ["1 src/cart/cart-store.ts:120", "2 src/cart/components/cart-sheet.tsx:88"]);
  assert.equal(parsed.comments[1].body, REAL[1].body);
  assert.equal(parseDraft(draft(REAL.slice(0, 1), "# PR #697 — comment line by line (head da61282d)")).pr, 697);
});

test("diffLines maps new-file line numbers of added and context lines", () => {
  const lines = diffLines(DIFF);
  assert.deepEqual([...lines.get("src/a.ts")], [10, 11, 12, 13]);
  assert.equal(lines.has("src/gone.ts"), false);
});

test("each broken shape is reported", () => {
  const cases = [
    ["Thiếu helper.", /end with "ạ\."/],
    ["Nút sai copy. Toast cũng sai ạ.", /one sentence/],
    ["Anh ơi, nút đang sai ạ.", /opener/],
    ["Nút đang sai ạ.\n\n```ts\nconst a = 1;\n```", /code block/],
    ["Nút đang sai ạ.\n\nPRD EPIC 9 · UC_SW_08 step 3:\n> button Ask the group.", /PRD header/],
    ["Nút đang sai ạ.\n\nPRD EPIC 09 · UC_SW_08 step 3:\nbutton Ask the group.", /followed by a "> " quote/],
    ["Nút đang sai ạ.\n\nNên đổi thành Ask the group.", /only a PRD block/],
    ["Nút đang hiện 家族 ạ.", /non-Latin/],
    [`${"Nút đang sai ".repeat(40)}ạ.`, /360/],
  ];
  for (const [body, pattern] of cases) assert.ok(lintComment(body, "vi").some((problem) => pattern.test(problem)), body);
});

test("non-Latin text inside backticks and PRD symbols are allowed", () => {
  assert.deepEqual(lintComment("Key `家族.title` chưa có trong locale vi ạ.", "vi"), []);
  assert.deepEqual(lintComment("PRD ghi khác ạ.\n\nPRD EPIC 08 · UC_MB_S01 BR5:\n> One Owner — always → never two · ok.", "vi"), []);
});

test("lintDraft checks every location against the diff and points to the full path", () => {
  const text = draft([
    { path: "src/a.ts", line: 12, body: "Giá trị đang là 3 ạ." },
    { path: "src/a.ts", line: 30, body: "Dòng này ngoài diff ạ." },
    { path: "a.ts", line: 11, body: "Đường dẫn rút gọn ạ." },
  ]);
  const { problems } = lintDraft(text, DIFF, "vi");
  assert.deepEqual(problems.map((problem) => problem.index), [2, 3]);
  assert.match(problems[0].problem, /not in the PR diff/);
  assert.match(problems[1].problem, /src\/a\.ts/);
});

test("lintDraft asks new drafts to use the colon header", () => {
  const { problems } = lintDraft(draft([{ path: "src/a.ts", line: 12, body: "Giá trị đang là 3 ạ." }], "# PR #1 — comment line by line (head abcdef12)"), DIFF, "vi");
  assert.ok(problems.some((problem) => /header/.test(problem.problem)));
});

test("the first clean lint freezes the original once, so later edits by the user stay measurable", async () => {
  const { readFileSync } = await import("node:fs");
  const { snapshotOnce, snapshotPath } = await import("./draft-lint.mjs");
  const dir = tempDir("tedy-snap-");
  const first = snapshotOnce("/w/plans/reports/review-x.md", "original", dir);
  assert.equal(first, snapshotPath("/w/plans/reports/review-x.md", dir));
  assert.equal(snapshotOnce("/w/plans/reports/review-x.md", "edited by the user", dir), null);
  assert.equal(readFileSync(first, "utf8"), "original");
});

test("chat comments: Figma opens with a handle, Doc tags nobody, both stay short and plain", async () => {
  const { lintChatComment } = await import("./draft-lint.mjs");
  assert.deepEqual(lintChatComment('@designer.lan Hint đổi "The family votes on it." thành "The group votes on it." nha', "figma", "vi"), []);
  assert.deepEqual(lintChatComment("Thêm 1 ý ở UC_LG_01 BR8: e đang hiểu là gồm cả 2, a xác nhận giúp e nha", "doc", "vi"), []);
  assert.ok(lintChatComment("Hint đổi thành group nha", "figma", "vi").some((problem) => /@handle/.test(problem)));
  assert.ok(lintChatComment("@pm_minh chốt giúp e nha", "doc", "vi").some((problem) => /tags nobody/.test(problem)));
  assert.ok(lintChatComment(`@a ${"x ".repeat(400)}`, "figma", "vi").some((problem) => /600/.test(problem)));
  assert.ok(lintChatComment("@a Anh ơi xem giúp e", "figma", "vi").some((problem) => /openers/.test(problem)));
});

test("English comments follow the English rules: a plain sentence first, no greeting or thanks", () => {
  assert.deepEqual(lintComment("The toast still uses the generic copy, not the PRD wording.", "en"), []);
  assert.deepEqual(lintComment("The total ignores refunds.\n\nPRD EPIC 03 · UC_CT_04 BR2:\n> Refunds lower the total.", "en"), []);
  assert.ok(lintComment("Hi, the total ignores refunds.", "en").some((problem) => /openers/.test(problem)));
  assert.ok(lintComment("The total ignores refunds. Please fix it.", "en").some((problem) => /one sentence/.test(problem)));
  assert.ok(lintComment("The total ignores refunds", "en").some((problem) => /must end with "\."/.test(problem)));
  assert.deepEqual(lintChatComment("@designer.lan Should the hint say shop instead of store?", "figma", "en"), []);
  assert.ok(lintChatComment("@a thanks for the frame", "figma", "en").some((problem) => /openers/.test(problem)));
  assert.throws(() => lintComment("x", "fr"), /no comment rules for language "fr"; supported: vi, en/);
});
