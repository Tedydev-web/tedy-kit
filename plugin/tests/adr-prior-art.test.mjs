import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAdrFolder, checkAdrText, GRANDFATHERED } from "../lib/prior-art.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SHA = "0123456789abcdef".repeat(2) + "01234567";
const BLOB = `https://github.com/o/r/blob/${SHA}/skills/tdd/SKILL.md#L10-L12`;
const cards = new Set(["superpowers"]);
const cardExists = (slug) => cards.has(slug);
const check = (section) => checkAdrText(`# 0099 Title\n\n## Context\n\ntext\n\n${section}\n## Decision\n\nx\n`, { cardExists });

const github = (evidence = [`${BLOB} "Write the test first."`], extra = []) => [
  "- obra/superpowers (MIT, studied 2026-10-18, via github)",
  "  - card: superpowers",
  ...evidence.map((line) => `  - ${line}`),
  ...extra,
  "  - Lesson: a skill is tested against a baseline before it ships.",
  "  - Taken: the pre-change arm in phase 03.",
];
const social = [
  "- a practitioner thread (public post, studied 2026-10-18, via reddit)",
  '  - https://www.reddit.com/r/ClaudeCode/comments/abc/x/ "Agents skip the failing test unless told to run it."',
  "  - Lesson: make the agent show the red run.",
  "  - Not taken: already covered by dev step 4.",
];
const section = (...blocks) => ["## Prior art", "", ...blocks.flat(), ""].join("\n");
const NO_SOCIAL = 'no social prior art: 2026-10-18 x: "agent tdd skill"; reddit: "claude code tests first"';

test("a section with pinned evidence, a card, a social source and excerpts passes", () => {
  assert.deepEqual(check(section(github(), social)), []);
  assert.deepEqual(check(section(github([`${BLOB.replace("#L10-L12", "?plain=1#L4")} "Run it."`]), NO_SOCIAL)), []);
});

test("an ADR without the section, or with the section only inside a code fence, fails", () => {
  assert.match(check("")[0], /no "## Prior art" section/);
  assert.match(check(["```md", section(github(), social), "```"].join("\n"))[0], /no "## Prior art" section/);
});

test("unpinned, short-sha or excerpt-less GitHub evidence fails", () => {
  assert.match(check(section(github([`https://github.com/o/r/blob/main/x.md#L1 "a"`]), social)).join("\n"), /unpinned GitHub link/);
  assert.match(check(section(github([`https://github.com/o/r/blob/0123456/x.md#L1 "a"`]), social)).join("\n"), /unpinned GitHub link/);
  assert.match(check(section(github([BLOB]), social)).join("\n"), /needs a quoted excerpt/);
  assert.match(check(section(github(["https://github.com/o/r/issues/12"]), social)).join("\n"), /needs a quoted excerpt/);
});

test("every source needs evidence, a lesson and a taken or not-taken line", () => {
  assert.match(check(section(github([]), social)).join("\n"), /obra\/superpowers: no evidence/);
  const noLesson = github().filter((line) => !line.includes("Lesson:"));
  assert.match(check(section(noLesson, social)).join("\n"), /no Lesson/);
  const noTaken = github().filter((line) => !line.includes("Taken:"));
  assert.match(check(section(noTaken, social)).join("\n"), /no Taken or Not taken/);
});

test("a GitHub source needs a card line naming an existing card", () => {
  const withoutCard = github().filter((line) => !line.includes("card:"));
  assert.match(check(section(withoutCard, social)).join("\n"), /needs "card: <slug>"/);
  assert.match(check(section(github().map((line) => line.replace("card: superpowers", "card: nowhere")), social)).join("\n"), /card "nowhere" not found/);
});

test("proprietary sources point to local lines without quoting them", () => {
  const paid = ["- ak-test (proprietary (installed), studied 2026-10-18, via local)", "  - ~/.claude/skills/ak-test/SKILL.md:12", "  - Lesson: tests are named for behavior.", "  - Not taken: dev already says so."];
  assert.deepEqual(check(section(paid, social)), []);
  const quoted = paid.map((line) => (line.endsWith(":12") ? `${line} "quoted text"` : line));
  assert.match(check(section(quoted, social)).join("\n"), /proprietary source must not quote/);
});

test("a command with its version is evidence; an unknown reference is not", () => {
  const local = ["- claude plugin eval (Anthropic, studied 2026-10-18, via local)", '  - `claude plugin eval --help` (Claude Code 2.1.302) "--ablation <mode>"', "  - Lesson: ablation is built in.", "  - Taken: ADR 0009."];
  assert.deepEqual(check(section(local, social)), []);
  assert.match(check(section(github(['see the docs "a"']), social)).join("\n"), /unknown evidence/);
});

test("without a social source the section needs a well-formed no-social line naming two social channels", () => {
  assert.match(check(section(github())).join("\n"), /no social source and no "no social prior art:" line/);
  assert.match(check(section(github(), 'no social prior art: 2026-10-18 x: "a"; web: "b"')).join("\n"), /two social channels/);
});

test("a no-prior-art line replaces the sources and must name two channels, one of them social", () => {
  assert.deepEqual(check(section('no prior art: 2026-10-18 github: "adr prior art template"; x: "prior art section adr"')), []);
  assert.match(check(section('no prior art: 2026-10-18 github: "a"')).join("\n"), /at least two channels/);
  assert.match(check(section('no prior art: 2026-10-18 github: "a"; web: "b"')).join("\n"), /one of them social/);
  assert.match(check(section('no prior art: 18/10 github: "a"; x: "b"')).join("\n"), /no prior art: .*date/);
});

function adrDir(files) {
  const root = tempDir("tedy-adr-");
  const dir = join(root, "adr");
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { dir, cards: join(root, "prior-art") };
}

test("the folder check grandfathers the existing ADRs by name, gates every other file and rejects odd names", () => {
  const ok = section('no prior art: 2026-10-18 github: "a"; x: "b"');
  const { dir, cards: cardsDir } = adrDir({ "0001-re-architecture-consolidation.md": "# old\n", "0009-new.md": `# n\n\n${ok}`, "0010-bad.md": "# b\n", "notes.md": ok });
  const problems = checkAdrFolder(dir, cardsDir).map((problem) => `${problem.file} ${problem.error}`);
  assert.deepEqual(problems, ['0010-bad.md no "## Prior art" section', "notes.md name is not NNNN-kebab-case.md"]);
  assert.equal(GRANDFATHERED.size, 8);
});

test("an empty ADR folder fails", () => {
  const { dir, cards: cardsDir } = adrDir({});
  assert.deepEqual(checkAdrFolder(dir, cardsDir), [{ file: "docs/adr", error: "no ADR files" }]);
});

test("the kit's own ADRs pass", () => {
  assert.deepEqual(checkAdrFolder(join(REPO, "docs", "adr"), join(REPO, "docs", "prior-art")), []);
});
