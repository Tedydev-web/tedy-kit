import { test } from "node:test";
import assert from "node:assert/strict";
import { findComments, isScannedFile, newComments } from "./comment-scan.mjs";

const texts = (source) => findComments(source).map((comment) => comment.text);

test("finds line and block comments", () => {
  assert.deepEqual(texts("const a = 1; // set a\n/* block */ const b = 2;"), ["// set a", "/* block */"]);
});

test("reports each line of a multi-line block comment once as a single comment", () => {
  const comments = findComments("/**\n * doc\n */\nexport const x = 1;");
  assert.equal(comments.length, 1);
  assert.equal(comments[0].line, 1);
});

test("ignores slashes inside strings and template literals", () => {
  assert.deepEqual(texts('const url = "https://example.com"; const t = `a // b ${x} /* c */`;'), []);
  assert.deepEqual(texts("const s = 'it\\'s // fine';"), []);
});

test("ignores slashes inside regular expression literals", () => {
  assert.deepEqual(texts("const r = /\\/\\//g; const s = x.replace(/[/*]/, '');"), []);
  assert.deepEqual(texts("if (/^\\/\\//.test(v)) return;"), []);
});

test("treats division as an operator, not a regex", () => {
  assert.deepEqual(texts("const half = total / 2; // half"), ["// half"]);
});

test("allows tool directives", () => {
  const source = [
    "#!/usr/bin/env node",
    "// eslint-disable-next-line no-console",
    "// @ts-expect-error legacy",
    "/* prettier-ignore */",
    "// biome-ignore lint: reason",
    "/// <reference types=\"vite/client\" />",
    "const x = /* @__PURE__ */ make();",
    "/* istanbul ignore next */",
  ].join("\n");
  assert.deepEqual(texts(source), []);
});

test("scans only C-style source files and skips tests", () => {
  assert.equal(isScannedFile("src/app.tsx"), true);
  assert.equal(isScannedFile("contracts/Wallet.sol"), true);
  assert.equal(isScannedFile("README.md"), false);
  assert.equal(isScannedFile("src/app.test.ts"), false);
  assert.equal(isScannedFile("src/__tests__/app.ts"), false);
  assert.equal(isScannedFile("styles/app.css"), false);
});

test("newComments returns only comments added by an edit", () => {
  const before = "// existing note\nconst a = 1;";
  const after = "// existing note\nconst a = 1; // added note";
  assert.deepEqual(newComments(before, after).map((comment) => comment.text), ["// added note"]);
});

test("newComments is empty when an edit keeps or removes comments", () => {
  assert.deepEqual(newComments("// a\nx();", "x();"), []);
  assert.deepEqual(newComments("// a\nx();", "// a\ny();"), []);
});
