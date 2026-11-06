import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parse } from "../lib/handoff.mjs";
import { CARD_KEYS } from "../lib/pending-cards.mjs";
import { card, cardCheck, cardNote, cards, cardStart, done, waitingText } from "../lib/pending.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const SCRIPTS = new URL("../scripts/", import.meta.url).pathname.replace(/\/$/, "");
const exec = promisify(execFile);

function project() {
  const root = tempDir("tedy-cards-");
  mkdirSync(join(root, "plans", "drafts"), { recursive: true });
  mkdirSync(join(root, "plans", "reports"), { recursive: true });
  const draft = join(root, "plans", "drafts", "review-712.md");
  writeFileSync(draft, "Line one of the review.\n");
  const map = { name: "shop", paths: [root], repos: [], sessions: [{ name: "PM - Shop", role: "pm" }] };
  return { root, draft, map };
}

const ready = (draft) => `### 1\nnode ${SCRIPTS}/github-write.mjs reply 712 99 --body-file ${draft} --repo o/r\nLine one of the review.\n`;
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

test("card publish writes the header and body, and parse reads them back", () => {
  const { root, draft, map } = project();
  const file = card(map, "publish", { title: "Post review on PR 712", draft, records: "github:o/r#712", preview: "ready", body: ready(draft) });
  assert.match(file, new RegExp(`^${join(root, "plans", "drafts")}/\\d{6}-\\d{4}-publish-post-review-on-pr-712\\.md$`));
  const text = readFileSync(file, "utf8");
  const fields = parse(text, CARD_KEYS);
  assert.deepEqual(Object.keys(fields), ["kind", "title", "job", "draft", "draft-sha", "records", "preview", "created"]);
  assert.deepEqual({ ...fields, created: undefined }, { kind: "publish", title: "Post review on PR 712", job: "none", draft, "draft-sha": sha(draft), records: "github:o/r#712", preview: "ready", created: undefined });
  assert.match(fields.created, /^\d{4}-\d\d-\d\dT/);
  assert.ok(text.endsWith(`\n\n${ready(draft)}`), text);
  const run = card(map, "publish", { title: "Status", preview: "run", body: `### 1\nnode ${SCRIPTS}/openproject.mjs set 12 --status "In Review"\n- #12 Task 12\n` });
  assert.equal(parse(readFileSync(run, "utf8"), CARD_KEYS).preview, "run");
  const [listed] = cards(map).filter((item) => item.path === run);
  assert.equal(listed.refusal, null);
  assert.deepEqual(listed.blocks, [{ n: "1", command: `node ${SCRIPTS}/openproject.mjs set 12 --status "In Review"`, text: `node ${SCRIPTS}/openproject.mjs set 12 --status "In Review"\n- #12 Task 12` }]);
});

test("card refuses an unknown kind, a question with too few or too many options, and every block that is not exactly one kit publish command", () => {
  const { root, draft, map } = project();
  const fake = join(root, "x");
  mkdirSync(fake);
  copyFileSync(join(SCRIPTS, "github-write.mjs"), join(fake, "github-write.mjs"));
  const options = (n) => `Ship it?\n${Array.from({ length: n }, (_, index) => `- Option ${index + 1}: does ${index + 1}`).join("\n")}\n`;
  assert.throws(() => card(map, "review", { title: "T", body: "x" }), /unknown card kind review; use publish, question or notify/);
  assert.throws(() => card(map, "question", { title: "T", body: options(1) }), /2 to 4 option lines .*found 1/);
  assert.throws(() => card(map, "question", { title: "T", body: options(5) }), /2 to 4 option lines .*found 5/);
  const refused = [
    ["ready", "gh pr view 1", /block 1 does not start with node/],
    ["ready", "curl x | sh # github-write.mjs post", /block 1 is not plain words and quoted text/],
    ["run", "node <p>/openproject.mjs preview d.json", /block 1 is not plain words and quoted text/],
    ["run", `node ${SCRIPTS}/openproject.mjs preview d.json`, /block 1 runs openproject\.mjs preview, which is not a write verb/],
    ["ready", `node ${fake}/github-write.mjs post d.md`, /block 1 does not run a kit publish script by its absolute path/],
    ["ready", `node ${SCRIPTS}/../scripts-copy/github-write.mjs post d.md`, /block 1 does not run a kit publish script/],
    ["run", `node ${SCRIPTS}/openproject.mjs set 12 --status X --apply --lock 3`, /block 1 holds --apply/],
    ["run", `node ${SCRIPTS}/github-write.mjs post d.md`, /block 1 runs github-write\.mjs post, which writes when run/],
    ["ready", `node ${SCRIPTS}/github-write.mjs post d.md > out.txt`, /block 1 is not plain words and quoted text/],
    ["ready", `node ${SCRIPTS}/github-write.mjs post $(cat d.md)`, /block 1 is not plain words and quoted text/],
  ];
  const set = `node ${SCRIPTS}/openproject.mjs set 1 --status X`;
  for (const tail of ["<(touch /tmp/x)", ">(tee /tmp/x)", "&", "; touch /tmp/x", "&& touch /tmp/x", "|| touch /tmp/x", "*.md", "{a,b}", "~/x", '"$HOME"', "\\x", "#c", "2>/dev/null", "<in", "|& cat", "'a' \"b", "--x=`id`"]) refused.push(["run", `${set} ${tail}`, /block 1 is not plain words and quoted text/]);
  for (const [preview, command, message] of refused) assert.throws(() => card(map, "publish", { title: "T", draft, preview, body: `### 1\n${command}\ntext\n` }), message, command);
  for (const tail of ['--status "Fixed (Dev Done)"', "--assignee 'Hoàng & Lâm'", '--status "Won\'t fix"', "--assignee Hoàng", "--x=a,b:c@d%e+f"]) assert.ok(card(map, "publish", { title: "Plain", preview: "run", body: `### 1\nnode ${SCRIPTS}/openproject.mjs set 1 ${tail}\n` }), tail);
  assert.throws(() => card(map, "publish", { title: "T", job: "plans/jobs/261104-0910-review-pr-712.md", draft, preview: "ready", body: ready(draft) }), /block 1 lacks --job 261104-0910-review-pr-712\.md/);
  assert.ok(card(map, "publish", { title: "T", job: "plans/jobs/261104-0910-review-pr-712.md", draft, preview: "ready", body: `### 1\nnode ${SCRIPTS}/github-write.mjs post ${draft} --job 261104-0910-review-pr-712.md\n` }));
  assert.throws(() => card(map, "publish", { title: "T", preview: "ready", body: ready(draft) }), /a preview: ready card needs draft:/);
  assert.throws(() => card(map, "publish", { title: "T", draft, body: ready(draft) }), /preview: ready or preview: run/);
  assert.throws(() => card(map, "notify", { title: "!!!", body: "x" }), /no words/);
  assert.equal(readdirSync(join(root, "plans", "drafts")).filter((name) => name.includes("-publish-t")).length, 1);
});

test("every block of a ready card names its pinned draft by absolute path, and a ready card without draft-sha never runs", () => {
  const { root, draft, map } = project();
  const other = join(root, "plans", "drafts", "b.md");
  writeFileSync(other, "Another text.\n");
  const post = (file) => `node ${SCRIPTS}/github-write.mjs post ${file} --repo o/r`;
  assert.throws(() => card(map, "publish", { title: "T", draft, preview: "ready", body: `### 1\n${post(other)}\n` }), new RegExp(`block 1 does not read its draft ${draft}: github-write\\.mjs post reads the file named right after the verb`));
  assert.throws(() => card(map, "publish", { title: "T", draft, preview: "ready", body: `### 1\n${post(draft)}\n\n### 2\n${post(other)}\n` }), /block 2 does not read its draft/);
  assert.throws(() => card(map, "publish", { title: "T", draft, preview: "ready", body: "### 1\nnode " + SCRIPTS + "/github-write.mjs post plans/drafts/review-712.md\n" }), /block 1 does not read its draft .*which must be the draft by its absolute path/);
  assert.ok(card(map, "publish", { title: "T", draft, preview: "ready", body: `### 1\nnode ${SCRIPTS}/github-write.mjs reply 712 99 --body-file=${draft} --repo o/r\n` }));
  assert.ok(card(map, "publish", { title: "T", preview: "run", body: `### 1\nnode ${SCRIPTS}/openproject.mjs comment 12 --body-file ${other}\n` }));
  const hand = join(root, "plans", "drafts", "by-hand.md");
  writeFileSync(hand, `kind: publish\ntitle: No pin\njob: none\ndraft: ${draft}\npreview: ready\n\n### 1\n${post(draft)}\n`);
  assert.match(waitingText(map, { offline: true }), /^Refused cards:\n- No pin: a preview: ready card needs draft-sha:.*by-hand\.md$/m);
  assert.throws(() => cardCheck(hand, map), /needs draft-sha:/);
});

test("a ready block reads its draft through the verb's own file operand, once, and names no second file", () => {
  const { root, draft, map } = project();
  const other = join(root, "plans", "drafts", "b.md");
  writeFileSync(other, "Another text.\n");
  const gw = `node ${SCRIPTS}/github-write.mjs`;
  const make = (command) => () => card(map, "publish", { title: "T", draft, preview: "ready", body: `### 1\n${command}\n` });
  for (const [command, message] of [
    [`${gw} reply 712 99 --body-file ${draft} --body-file ${other} --repo o/r`, /block 1 repeats --body-file/],
    [`${gw} reply 712 99 --body-file=${draft} --body-file ${other} --repo o/r`, /block 1 repeats --body-file/],
    [`${gw} post ${other} ${draft} --repo o/r`, new RegExp(`block 1 does not read its draft ${draft}: github-write\\.mjs post reads the file named right after the verb`)],
    [`${gw} reply 712 99 --body-file ${other} --title ${draft} --repo o/r`, /block 1 does not read its draft .*: github-write\.mjs reply reads the file named by --body-file/],
    [`${gw} post ${draft} ${other} --repo o/r`, new RegExp(`block 1 names a second file ${other}`)],
    [`${gw} reply 712 99 --body-file ${draft} --title ${draft}`, /block 1 names a second file/],
    [`${gw} resolve PRRT_1`, /block 1 does not read its draft .*: github-write\.mjs resolve reads no file/],
    [`node ${SCRIPTS}/openproject.mjs set 1 --status X --status Y`, /block 1 repeats --status/],
  ]) assert.throws(make(command), message, command);
  for (const command of [
    `${gw} post ${draft} --repo o/r`,
    `${gw} reply 712 99 --body-file ${draft} --repo o/r`,
    `${gw} pr-body 712 --body-file=${draft} --repo o/r`,
    `node ${SCRIPTS}/openproject.mjs comment 12 --body-file ${draft} --apply`,
    `node ${SCRIPTS}/figma-comments.mjs reply 9 --body-file ${draft} --file KEY`,
    `node ${SCRIPTS}/gdoc-comments.mjs anchor --tab t.1 --quote 'a b' --body-file ${draft} --doc D`,
    `node ${SCRIPTS}/doc-comment-file.mjs post ${draft} --html ${other} --apply --doc D`,
  ]) assert.ok(make(command)(), command);
  const relativeDraft = relative(process.cwd(), draft);
  assert.throws(make(`${gw} post ${relativeDraft} --repo o/r`), /block 1 does not read its draft .* by its absolute path/);
});

test("a hand-written card resolves a relative draft: against the project, and a card whose draft is gone is refused", () => {
  const { root, draft, map } = project();
  const post = `node ${SCRIPTS}/github-write.mjs post ${draft} --repo o/r`;
  const relativeCard = join(root, "plans", "drafts", "by-hand-relative.md");
  writeFileSync(relativeCard, `kind: publish\ntitle: Relative\njob: none\ndraft: plans/drafts/review-712.md\ndraft-sha: ${sha(draft)}\npreview: ready\n\n### 1\n${post}\n`);
  assert.equal(cardCheck(relativeCard, map), 1);
  assert.match(waitingText(map, { offline: true }), /^To publish:\n- Relative \(ready, 1 command\) /m);
  const gone = join(root, "plans", "drafts", "gone.md");
  const goneCard = join(root, "plans", "drafts", "by-hand-gone.md");
  writeFileSync(goneCard, `kind: publish\ntitle: Gone\njob: none\ndraft: ${gone}\ndraft-sha: ${sha(draft)}\npreview: ready\n\n### 1\nnode ${SCRIPTS}/github-write.mjs post ${gone} --repo o/r\n`);
  assert.match(waitingText(map, { offline: true }), new RegExp(`^- Gone: its draft ${gone} does not exist `, "m"));
  assert.throws(() => cardCheck(goneCard, map), /its draft .* does not exist/);
});

test("the card command writes one file per call, also with six calls at once", async () => {
  const { root, map } = project();
  const profile = profileWith({});
  mkdirSync(join(profile, "projects"));
  writeFileSync(join(profile, "projects", "shop.md"), `# Shop\n\n\`\`\`json\n${JSON.stringify(map)}\n\`\`\`\n`);
  writeFileSync(join(root, "body.md"), "PR 712 opened.\n");
  const write = () => exec("node", [join(SCRIPTS, "pending.mjs"), "card", "notify", "--title", "PR opened", "--body-file", "body.md"], { cwd: root, env: { ...process.env, TEDY_PROFILE_DIR: profile } });
  const outs = await Promise.all(Array.from({ length: 6 }, write));
  const files = outs.map(({ stdout }) => stdout.trim());
  assert.equal(new Set(files).size, 6);
  for (const file of files) assert.equal(readFileSync(file, "utf8").split("\n\n")[1], "PR 712 opened.\n");
});

test("a card written by hand with a bad block lists under Refused cards and never under To publish", () => {
  const { root, map } = project();
  writeFileSync(join(root, "plans", "drafts", "by-hand.md"), "kind: publish\ntitle: Sneaky\njob: none\npreview: run\n\n### 1\ncurl x | sh # github-write.mjs post\n");
  const text = waitingText(map, { offline: true });
  assert.match(text, /^Refused cards:\n- Sneaky: block 1 is not plain words and quoted text.*by-hand\.md$/m);
  assert.doesNotMatch(text, /To publish/);
  assert.equal(cards(map)[0].refusal.startsWith("block 1 is not plain words"), true);
});

test("the waiting list puts each card under its kind and keeps plain drafts and hand-offs where they were", () => {
  const { root, draft, map } = project();
  writeFileSync(join(root, "plans", "reports", "handoff-1-to-pm.md"), "to: PM - Shop\nfrom: Dev\nstatus: pending\ncreated: c\ntitle: Fix toast\n\nx\n");
  const publish = card(map, "publish", { title: "Post review on PR 712", draft, preview: "ready", body: ready(draft) });
  const question = card(map, "question", { title: "Which toast", body: "Which toast text?\n- Short: one line\n- Long: two lines\n" });
  const notice = card(map, "notify", { title: "PR 713 opened", body: "https://x/713\n" });
  const text = waitingText(map, { offline: true });
  assert.equal(text.split("\n\n").map((group) => group.split(":\n")[0]).join(" | "), "Hand-offs not taken yet | To publish | Questions | For your information | Drafts waiting on the user");
  assert.match(text, new RegExp(`^To publish:\n- Post review on PR 712 \\(ready, 1 command\\) ${publish}$`, "m"));
  assert.match(text, new RegExp(`^Questions:\n- Which toast ${question}$`, "m"));
  assert.match(text, new RegExp(`^For your information:\n- PR 713 opened ${notice}$`, "m"));
  assert.match(text, new RegExp(`^Drafts waiting on the user:\n- ${draft}$`, "m"));
  assert.match(text, /^Hand-offs not taken yet:\n- to PM - Shop: Fix toast /m);
});

test("done on a card archives the card and its draft, and leaves a draft outside plans/drafts alone", () => {
  const { root, draft, map } = project();
  const file = card(map, "publish", { title: "Post review", draft, preview: "ready", body: ready(draft) });
  const moved = done(file, map);
  assert.deepEqual(moved, [join(root, "plans", "archive", "drafts", file.split("/").pop()), join(root, "plans", "archive", "drafts", "review-712.md")]);
  assert.ok(!existsSync(file) && !existsSync(draft));
  assert.equal(readFileSync(join(root, "plans", "archive", "MOVES.tsv"), "utf8").split("\n").filter(Boolean).length, 3);
  const outside = join(root, "plans", "reports", "review-713.md");
  writeFileSync(outside, "x\n");
  const other = card(map, "publish", { title: "Post 713", draft: outside, preview: "ready", body: ready(outside) });
  assert.equal(done(other, map).length, 1);
  assert.ok(existsSync(outside));
});

test("card-note writes answers and refusals into the header, a refused card is not offered, and card-check pins the draft", () => {
  const { root, draft, map } = project();
  const question = card(map, "question", { title: "Which toast", body: "Which toast text?\n- Short: one line\n- Long: two lines\n" });
  cardNote(question, "Short");
  assert.equal(parse(readFileSync(question, "utf8"), CARD_KEYS).answer, "Short");
  assert.match(readFileSync(question, "utf8"), /\n\nWhich toast text\?\n- Short: one line\n- Long: two lines\n$/);
  const first = card(map, "publish", { title: "Post review", draft, preview: "ready", body: ready(draft) });
  assert.equal(cardCheck(first, map), 1);
  writeFileSync(draft, "Line one, reworded.\n");
  assert.throws(() => cardCheck(first, map), /the draft changed since the card was written/);
  cardNote(first, "the user asked to reword line one", { refuse: true });
  const fields = parse(readFileSync(first, "utf8"), CARD_KEYS);
  assert.equal(fields.status, "refused");
  assert.equal(fields.refused, "the user asked to reword line one");
  assert.ok(readFileSync(first, "utf8").endsWith(`\n\n${ready(draft)}`));
  assert.throws(() => cardCheck(first, map), /refused: the user asked to reword line one/);
  assert.match(waitingText(map, { offline: true }), /^Refused cards:\n- Post review: refused: the user asked to reword line one /m);
  assert.doesNotMatch(waitingText(map, { offline: true }), /To publish/);
  const second = card(map, "publish", { title: "Post review again", draft, preview: "ready", body: ready(draft) });
  assert.equal(cardCheck(second, map), 1);
  assert.equal(done(first, map).length, 1);
  assert.ok(existsSync(draft));
  assert.throws(() => done(first, map), /is not a file/);
  assert.throws(() => cardNote(first, "late"), /not a card file|no such file|ENOENT/);
  assert.throws(() => cardNote(join(root, "plans", "drafts", "review-712.md"), "x"), /not a card file/);
});

test("card-start runs only a fully approved card, marks it started, and a started card is never offered or checked again", () => {
  const { draft, map } = project();
  const post = `node ${SCRIPTS}/github-write.mjs reply 712 99 --body-file ${draft} --repo o/r`;
  const file = card(map, "publish", { title: "Two replies", draft, preview: "ready", body: `### 1\n${post}\n\n### 2\n${post}\n` });
  assert.throws(() => cardStart(file, map, ["1"]), /approval covers block\(s\) 1 of 1, 2; a card runs only when every block was approved/);
  assert.throws(() => cardStart(file, map, []), /approval covers block\(s\) none of 1, 2/);
  assert.equal(parse(readFileSync(file, "utf8"), CARD_KEYS).status, undefined);
  assert.equal(cardStart(file, map, ["2", "1"]), 2);
  const fields = parse(readFileSync(file, "utf8"), CARD_KEYS);
  assert.equal(fields.status, "started");
  assert.match(fields.started, /^\d{4}-\d\d-\d\dT/);
  assert.ok(readFileSync(file, "utf8").endsWith(`\n\n### 1\n${post}\n\n### 2\n${post}\n`));
  assert.throws(() => cardCheck(file, map), /started at .*: its commands may already have written/);
  assert.throws(() => cardStart(file, map, ["1", "2"]), /started at /);
  const text = waitingText(map, { offline: true });
  assert.doesNotMatch(text, /To publish|Refused cards/);
  assert.match(text, new RegExp(`^Started, not closed:\n- Two replies \\(started ${fields.started}\\) ${file}$`, "m"));
  assert.equal(done(file, map).length, 2);
});

test("an answered question is shown as answered, so the skill does not ask it again", () => {
  const { map } = project();
  const question = card(map, "question", { title: "Which toast", body: "Which toast text?\n- Short: one line\n- Long: two lines\n" });
  assert.match(waitingText(map, { offline: true }), new RegExp(`^Questions:\n- Which toast ${question}$`, "m"));
  cardNote(question, "Short");
  assert.match(waitingText(map, { offline: true }), new RegExp(`^Questions:\n- Which toast \\(answered: Short\\) ${question}$`, "m"));
});

test("a card file name taken by a dangling symlink is skipped, never written through", async () => {
  const { symlinkSync } = await import("node:fs");
  const { root, map } = project();
  const target = join(tempDir("tedy-cards-target-"), "planted.md");
  const { stamp } = await import("../lib/handoff.mjs");
  const now = Date.now();
  for (const at of [now, now + 60_000]) symlinkSync(target, join(root, "plans", "drafts", `${stamp(new Date(at))}-notify-pr-opened.md`));
  const file = card(map, "notify", { title: "PR opened", body: "x" });
  assert.match(file, /-notify-pr-opened-2\.md$/);
  assert.ok(!existsSync(target));
});

test("a card whose job is still running is listed but not offered, and card-check refuses it", () => {
  const { root, draft, map } = project();
  mkdirSync(join(root, "plans", "jobs"));
  const job = join(root, "plans", "jobs", "261104-0910-review-pr-712.md");
  writeFileSync(job, "to: tedy:review\nfrom: cockpit\nstatus: running\ncreated: c\ntitle: Review 712\n\nx\n");
  const file = card(map, "publish", { title: "Post review", job, draft, preview: "ready", body: `### 1\nnode ${SCRIPTS}/github-write.mjs post ${draft} --job=261104-0910-review-pr-712.md\n` });
  assert.match(waitingText(map, { offline: true }), /^To publish:\n- Post review \(ready, 1 command, job running\) /m);
  assert.throws(() => cardCheck(file, map), /its job .* is still running/);
  writeFileSync(job, "to: tedy:review\nfrom: cockpit\nstatus: done\ncreated: c\ntitle: Review 712\n\nx\n");
  assert.equal(cardCheck(file, map), 1);
});
