import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { countWords, lintWorkPackage } from "./task-lint.mjs";

const STYLE = readFileSync(new URL("../shared/style/tracker-task.md", import.meta.url), "utf8");
const SAMPLES = [...STYLE.matchAll(/### \d+\. ([^:\n]+): #\d+ ([^\n]+)\n\n```markdown\n([\s\S]*?)\n```/g)].map((match) => ({
  type: /story/i.test(match[1]) ? "User story" : /bug/i.test(match[1]) ? "Bug" : "Task",
  subject: match[2],
  description: match[3],
}));
const blocks = (draft) => lintWorkPackage(draft).filter((finding) => finding.severity === "BLOCK").map((finding) => finding.rule);
const task = SAMPLES.find((sample) => sample.subject.startsWith("[FE] Vault limit"));

test("every published sample in the style file passes", () => {
  assert.equal(SAMPLES.length, 6);
  for (const sample of SAMPLES) assert.deepEqual(blocks(sample), [], sample.subject);
});

test("word count leaves out headings, checkbox markers and URLs", () => {
  assert.equal(countWords("## Goal\nShow the pop-up.\n\n## Checklist\n- [ ] Add it.\n- [x] See https://example.com/a-b-c"), 7);
});

test("a missing section, an empty checklist and a code fence are blocked", () => {
  assert.ok(blocks({ ...task, description: task.description.replace("## AC", "## Notes") }).includes("desc-section"));
  assert.ok(blocks({ ...task, description: task.description.replace(/- \[ \]/g, "-") }).includes("desc-checkbox"));
  assert.ok(blocks({ ...task, description: `${task.description}\n\`\`\`ts\nconst a = 1;\n\`\`\`` }).includes("desc-codedump"));
});

test("three file paths are scope leak", () => {
  assert.ok(blocks({ ...task, description: `${task.description}\nTouch src/a/b.ts, src/c/d.tsx and api/space-api.ts.` }).includes("desc-codedump"));
});

test("length, checklist and AC ceilings are enforced", () => {
  assert.ok(blocks({ ...task, description: `${task.description}\n${"word ".repeat(200)}` }).includes("desc-over"));
  const nine = Array.from({ length: 9 }, (_, index) => `- [ ] Item ${index}.`).join("\n");
  assert.ok(blocks({ ...task, description: task.description.replace("## AC", `${nine}\n\n## AC`) }).includes("checklist-over"));
  const seven = Array.from({ length: 7 }, (_, index) => `- [ ] Check ${index}.`).join("\n");
  assert.ok(blocks({ ...task, description: task.description.replace("## AC\n", `## AC\n${seven}\n`) }).includes("ac-over"));
});

test("Vietnamese prose and placeholders are blocked, while names and quoted frame titles pass", () => {
  assert.ok(blocks({ ...task, description: `${task.description}\nCần làm thêm phần này nha.` }).includes("desc-language"));
  assert.deepEqual(blocks({ ...task, description: `${task.description}\nWiring is Tín's task; frame "Trang chọn ví".` }), []);
  assert.ok(blocks({ ...task, description: `${task.description}\nTBD after the PM answers.` }).includes("desc-placeholder"));
  assert.ok(blocks({ ...task, subject: "[FE] Màn chọn ví" }).includes("subject-language"));
});

test("a task subject without a component tag and a bare node id are warnings only", () => {
  const findings = lintWorkPackage({ ...task, subject: "Vault limit pop-up", description: `${task.description}\nSee 4408:8157.` });
  assert.deepEqual(findings.map((finding) => `${finding.severity} ${finding.rule}`).sort(), ["WARN design-ref-bare", "WARN subject-tag"]);
});

test("a task estimated over 16 hours is a warning to split it; 16 hours passes", () => {
  assert.deepEqual(lintWorkPackage({ ...task, estimate: 20 }).map((finding) => `${finding.severity} ${finding.rule}`), ["WARN estimate-oversize"]);
  assert.deepEqual(lintWorkPackage({ ...task, estimate: 16 }), []);
});
