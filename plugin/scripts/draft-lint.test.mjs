import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, lintComment, lintDraft, parseDraft } from "./draft-lint.mjs";

const REAL = [
  { path: "store/members-store.ts", line: 220, body: "Toast đang là câu chung, chưa đúng copy PRD ạ.\n\nPRD EPIC 08 · UC_MB_09 BR7:\n> BR7 (Toast): \"{Name} spends from {vault list}\", or \"{Name} has no vault to spend from\"." },
  { path: "components/members/members-page.tsx", line: 347, body: "Sheet đóng trước khi gọi API, nên lỗi thì chỉ còn toast ạ.\n\nPRD EPIC 08 · UC_MB_09 Error States:\n> Backend unavailable → retry line in the sheet; the old scope stands." },
  { path: "apps/family/app/features/shared-wallet/lib/send-gate.ts", line: 29, body: "Có Must include là FE coi luôn như Always ask, trong khi PRD không tính đây là một gate ạ.\n\nPRD EPIC 05 · UC_FW_03 BR1:\n> Nothing else gates a spend — no per-member limit, no app-wide ceiling." },
  { path: "apps/family/app/features/shared-wallet/components/settings/settings-space-handover-ownership-sheet.tsx", line: 62, body: "Hint đang ghi \"The family votes on it.\", PM đã chốt dùng \"group\" thay \"family\" cho toàn app ạ.\n\nPRD EPIC 09 · UC_SW_08 step 1:\n> The group votes on it." },
  { path: "apps/family/app/features/shared-wallet/hooks/use-shared-assets.ts", line: 40, body: "BE dev chưa trả `inVaultAmount` / `inVaultFormatted` / `vaultCount`, nên coin nào cũng hiện \"All unallocated\", kể cả coin đang nằm trong vault ạ." },
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
  for (const comment of REAL) assert.deepEqual(lintComment(comment.body), [], comment.body);
});

test("parseDraft reads the header, sections and bodies, and accepts the older em dash header", () => {
  const parsed = parseDraft(draft(REAL.slice(0, 2)));
  assert.equal(parsed.pr, 703);
  assert.equal(parsed.sha, "22288559");
  assert.deepEqual(parsed.comments.map((comment) => `${comment.index} ${comment.path}:${comment.line}`), ["1 store/members-store.ts:220", "2 components/members/members-page.tsx:347"]);
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
  for (const [body, pattern] of cases) assert.ok(lintComment(body).some((problem) => pattern.test(problem)), body);
});

test("non-Latin text inside backticks and PRD symbols are allowed", () => {
  assert.deepEqual(lintComment("Key `家族.title` chưa có trong locale vi ạ."), []);
  assert.deepEqual(lintComment("PRD ghi khác ạ.\n\nPRD EPIC 08 · UC_MB_S01 BR5:\n> One Owner — always → never two · ok."), []);
});

test("lintDraft checks every location against the diff and points to the full path", () => {
  const text = draft([
    { path: "src/a.ts", line: 12, body: "Giá trị đang là 3 ạ." },
    { path: "src/a.ts", line: 30, body: "Dòng này ngoài diff ạ." },
    { path: "a.ts", line: 11, body: "Đường dẫn rút gọn ạ." },
  ]);
  const { problems } = lintDraft(text, DIFF);
  assert.deepEqual(problems.map((problem) => problem.index), [2, 3]);
  assert.match(problems[0].problem, /not in the PR diff/);
  assert.match(problems[1].problem, /src\/a\.ts/);
});

test("lintDraft asks new drafts to use the colon header", () => {
  const { problems } = lintDraft(draft([{ path: "src/a.ts", line: 12, body: "Giá trị đang là 3 ạ." }], "# PR #1 — comment line by line (head abcdef12)"), DIFF);
  assert.ok(problems.some((problem) => /header/.test(problem.problem)));
});

test("the first clean lint freezes the original once, so later edits by the user stay measurable", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { snapshotOnce, snapshotPath } = await import("./draft-lint.mjs");
  const dir = mkdtempSync(join(tmpdir(), "tedy-snap-"));
  const first = snapshotOnce("/w/plans/reports/review-x.md", "original", dir);
  assert.equal(first, snapshotPath("/w/plans/reports/review-x.md", dir));
  assert.equal(snapshotOnce("/w/plans/reports/review-x.md", "edited by the user", dir), null);
  assert.equal(readFileSync(first, "utf8"), "original");
});
