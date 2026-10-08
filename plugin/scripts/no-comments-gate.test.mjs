import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkEdit } from "./no-comments-gate.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

test("Edit adding a comment is denied", () => {
  const result = checkEdit("Edit", { file_path: "/w/a.ts", old_string: "const a = 1;", new_string: "const a = 1; // why" });
  assert.equal(result.allow, false);
  assert.match(result.reason, /\/\/ why/);
});

test("Edit near an existing comment without adding one is allowed", () => {
  assert.equal(checkEdit("Edit", { file_path: "/w/a.ts", old_string: "// legacy\nconst a = 1;", new_string: "// legacy\nconst a = 2;" }).allow, true);
});

test("Write compares against the current file content", () => {
  const dir = tempDir("tedy-edit-");
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

test("the hook blocks a commented edit only when the profile turns noComments on", () => {
  const file = join(tempDir("tedy-edit-"), "a.ts");
  const input = JSON.stringify({ tool_name: "Write", tool_input: { file_path: file, content: "// why\nexport const a = 1;\n" } });
  const run = (profile) => spawnSync("node", [new URL("./no-comments-gate.mjs", import.meta.url).pathname], { input, encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: tempDir("tedy-edit-state-") } });
  assert.equal(run(profileWith({ gates: { noComments: false } })).stdout, "");
  assert.match(run(profileWith({ gates: { noComments: true } })).stdout, /"permissionDecision":"deny"/);
  assert.match(run(profileWith("{ broken")).stdout, /"permissionDecision":"deny"/);
});
