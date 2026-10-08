import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEdit } from "./no-comments-gate.mjs";

test("Edit adding a comment is denied", () => {
  const result = checkEdit("Edit", { file_path: "/w/a.ts", old_string: "const a = 1;", new_string: "const a = 1; // why" });
  assert.equal(result.allow, false);
  assert.match(result.reason, /\/\/ why/);
});

test("Edit near an existing comment without adding one is allowed", () => {
  assert.equal(checkEdit("Edit", { file_path: "/w/a.ts", old_string: "// legacy\nconst a = 1;", new_string: "// legacy\nconst a = 2;" }).allow, true);
});

test("Write compares against the current file content", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedy-edit-"));
  const file = join(dir, "x.ts");
  writeFileSync(file, "// kept\nexport const x = 1;\n");
  assert.equal(checkEdit("Write", { file_path: file, content: "// kept\nexport const x = 2;\n" }).allow, true);
  assert.equal(checkEdit("Write", { file_path: file, content: "// kept\n// added\nexport const x = 2;\n" }).allow, false);
});

test("Write of a new file with a comment is denied", () => {
  assert.equal(checkEdit("Write", { file_path: "/nonexistent/new.tsx", content: "/* header */\nexport {};" }).allow, false);
});

test("non-source files and tests are allowed", () => {
  assert.equal(checkEdit("Write", { file_path: "/w/README.md", content: "// not code" }).allow, true);
  assert.equal(checkEdit("Edit", { file_path: "/w/a.spec.ts", old_string: "", new_string: "// fine" }).allow, true);
});

test("MultiEdit is checked edit by edit", () => {
  const edits = [{ old_string: "const a = 1;", new_string: "const a = 2;" }, { old_string: "const b = 1;", new_string: "const b = 1; /* why */" }];
  const result = checkEdit("MultiEdit", { file_path: "/w/a.ts", edits });
  assert.equal(result.allow, false);
  assert.match(result.reason, /why/);
  assert.equal(checkEdit("MultiEdit", { file_path: "/w/a.ts", edits: edits.slice(0, 1) }).allow, true);
});
