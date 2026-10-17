import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { countWords, lintDrafts, lintWorkPackage, readiness } from "./task-lint.mjs";

const STYLE = readFileSync(new URL("../shared/style/tracker-task.md", import.meta.url), "utf8");
const SAMPLES = [...STYLE.matchAll(/### \d+\. ([^:\n]+): #\d+ ([^\n]+)\n\n```markdown\n([\s\S]*?)\n```/g)].map((match) => ({
  type: /story/i.test(match[1]) ? "User story" : /bug/i.test(match[1]) ? "Bug" : "Task",
  subject: match[2],
  description: match[3],
}));
const blocks = (draft) => lintWorkPackage(draft).filter((finding) => finding.severity === "BLOCK").map((finding) => finding.rule);
const task = SAMPLES.find((sample) => sample.subject.startsWith("[FE] Cart limit"));

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
  assert.deepEqual(blocks({ ...task, description: `${task.description}\nWiring is Sam's task; frame "Trang chọn ví".` }), []);
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

const story = SAMPLES.find((sample) => sample.type === "User story");
const withQuestion = (line) => ({ ...task, description: task.description.replace("## Open questions\n", `## Open questions\n- ${line}\n`) });

test("a blocking open question needs a Tried trail; plain questions in the published style stay exempt", () => {
  assert.ok(task.description.includes("## Open questions"));
  assert.ok(blocks(withQuestion("Blocking: the limit is 3 or 5? Asked the PM.")).includes("oq-untried"));
  assert.ok(!blocks(withQuestion("Blocking: the limit is 3 or 5? Tried: PRD UC_SW_05 BR2, Figma 4408-8157, BE origin/dev; asked the PM.")).includes("oq-untried"));
  assert.ok(!blocks(withQuestion("The limit lives in code; asked the PM.")).includes("oq-untried"));
});

const good = (slug, extra = {}) => ({ ...task, slug, estimate: 2, parent: "story-a", ...extra });
const bare = { slug: "t-bare", type: "Task", subject: "[BE] Validate mining", description: "", parent: "story-a" };
const storyDraft = { ...story, slug: "story-a" };

test("readiness follows pg thresholds: mixed is thin, clean is ready, bare or unproven is missing", () => {
  const mixed = readiness([storyDraft, good("t-good"), bare]);
  assert.deepEqual([mixed.lintable, mixed.descOk, mixed.leaves, mixed.estimated], [3, 2, 2, 1]);
  assert.equal(mixed.verdict, "thin");
  assert.equal(readiness([storyDraft, good("t-1"), good("t-2")]).verdict, "ready");
  assert.equal(readiness([{ ...bare, parent: undefined }]).verdict, "missing");
  assert.equal(readiness([{ slug: "m", type: "Milestone", subject: "M" }]).verdict, "missing");
  assert.equal(readiness([storyDraft, good("t-1", { estimate: undefined }), good("t-2", { estimate: undefined })]).verdict, "missing");
  const blocking = good("t-q", { description: withQuestion("Blocking: which wallet pays? Tried: PRD UC_SW_13.").description });
  assert.equal(readiness([storyDraft, blocking]).blockingQuestions, 1);
});

test("a new story with a UI task and no wire task, or the reverse, is flagged; a story referenced by id is not", () => {
  const ui = good("t-ui", { subject: "[FE] Name sheet" });
  const wire = good("t-wire", { subject: "[FE] Wire the name sheet to the API" });
  const rules = (drafts) => lintDrafts(drafts).map((finding) => `${finding.slug}:${finding.rule}`);
  assert.deepEqual(rules([storyDraft, ui]), ["story-a:story-layers-unjoined"]);
  assert.deepEqual(rules([storyDraft, wire]), ["story-a:story-layers-unjoined"]);
  assert.deepEqual(rules([storyDraft, ui, wire]), []);
  assert.deepEqual(rules([{ ...ui, parent: 21270 }]), []);
});

test("glossary drift is flagged in prose but not in code spans, quoted copy or placeholders", () => {
  const glossary = { "shared wallet": ["space"] };
  const drift = lintDrafts([good("t-1", { subject: "[FE] Space name sheet" })], { glossary });
  assert.equal(drift.length, 1);
  assert.equal(drift[0].rule, "glossary-drift");
  const clean = good("t-2", { description: `${task.description}\nToast "You left {space}" and \`space\` stay as written.` });
  assert.deepEqual(lintDrafts([clean], { glossary }), []);
});

test("updates of existing work packages are not asked for an estimate", () => {
  const update = good("t-u", { id: 21298, estimate: undefined, parent: 21270 });
  assert.equal(readiness([update]).verdict, "ready");
  assert.equal(readiness([good("t-s", { estimate: undefined, parent: 21270 })], { updating: new Set(["t-s"]) }).verdict, "ready");
  assert.equal(readiness([good("t-n", { estimate: undefined, parent: 21270 })]).verdict, "missing");
});

test("the readiness line names the verdict in the chat language", async () => {
  const { readinessLine } = await import("./task-lint.mjs");
  const stats = { verdict: "missing", descOk: 0, lintable: 1, estimated: 0, leaves: 1, blockingQuestions: 0 };
  assert.match(readinessLine(stats, "vi"), /^readiness thiếu nặng:/);
  assert.match(readinessLine(stats, "en"), /^readiness not ready:/);
});
