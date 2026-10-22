import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeOpenProject, world } from "./fake-services-for-tests.mjs";

const TASK = { slug: "task-fe-a", type: "Task", subject: "[FE] Vault limit pop-up on Pro", description: "## Goal\nShow the pop-up from https://www.figma.com/design/F1/App?node-id=1-2 when a 4th vault is started on Pro, per https://docs.google.com/document/d/D2/edit.\n\n## Checklist\n- [ ] Show the pop-up.\n\n## AC\n- [ ] On Pro, a 4th vault cannot be started.", estimate: 1 };
const DOCUMENT = { tabs: [{ tabProperties: { tabId: "t.1" }, documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: "PRD\n" } }] } }] } } }] };

const stateFile = (w, file, suffix) => join(w.dir, "state", "drafts", `${join(w.dir, file).replace(/\//g, "_")}${suffix}`);
const noFigmaToken = (w) => rmSync(join(w.dir, ".config", "figma", "token"));
function brokenRclone(w) {
  writeFileSync(join(w.dir, "bin", "rclone"), "#!/usr/bin/env node\nprocess.stderr.write('rclone: not configured\\n');\nprocess.exit(1);\n");
  chmodSync(join(w.dir, "bin", "rclone"), 0o755);
}

test("openproject preview names the source it cannot pin and writes no locks, snapshot or record", async () => {
  const op = await fakeOpenProject();
  try {
    for (const [breakIt, pattern] of [[noFigmaToken, /cannot pin Figma file F1: .*token/], [brokenRclone, /cannot pin Google Doc D2: /]]) {
      const w = world({ mode: "ask", opUrl: op.url, web: { document: DOCUMENT } });
      breakIt(w);
      w.file("drafts.json", JSON.stringify([TASK]));
      const preview = await w.run("openproject", ["preview", "drafts.json", "--project", "183"]);
      assert.notEqual(preview.code, 0);
      assert.match(preview.out, pattern);
      assert.doesNotMatch(preview.out, /approval lines:|original drafts frozen/);
      for (const suffix of [".locks.json", "", ".sources.json"]) assert.equal(existsSync(stateFile(w, "drafts.json", suffix)), false, suffix);
    }
  } finally {
    op.server.close();
  }
});

test("draft-lint prints no clean line when it cannot pin the Figma file or the Doc", async () => {
  const figma = world({ mode: "ask" });
  noFigmaToken(figma);
  figma.file("f.md", "@lam Màn này thiếu trạng thái rỗng.\n");
  const figmaLint = await figma.run("draft-lint", ["figma-comment", "f.md", "--file", "F"]);
  assert.notEqual(figmaLint.code, 0);
  assert.match(figmaLint.out, /cannot pin Figma file F: .*token/);
  assert.doesNotMatch(figmaLint.out, /^clean:/m);
  assert.equal(existsSync(stateFile(figma, "f.md", ".sources.json")), false);
  const doc = world({ mode: "ask", web: { document: DOCUMENT } });
  brokenRclone(doc);
  doc.file("g.md", "Which wallet pays the fee?\n");
  const docLint = await doc.run("draft-lint", ["doc-comment", "g.md", "--doc", "D"]);
  assert.notEqual(docLint.code, 0);
  assert.match(docLint.out, /cannot pin Google Doc D: /);
  assert.doesNotMatch(docLint.out, /^clean:/m);
  assert.equal(existsSync(stateFile(doc, "g.md", ".sources.json")), false);
});
