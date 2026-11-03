import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMAINS, entryErrors, kitEntries, parseCard, parseNote, privateLink, renderIndex } from "../lib/prior-art-index.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const card = (slug, front, body = "") => parseCard({ slug, text: `---\nname: o/${slug}\nstudied: 2026-10-30\n${front}---\n\n# o/${slug}\n\n${body}` });
const note = (slug, front, body = "## Sources\n- https://example.com/post (read 2026-10-27)\n", place = "private") => parseNote({ slug, place, text: `---\n${front}---\n\nThe finding.\n\n${body}` });
const goodNote = "title: Cache the stable prefix\ndomains: cost\nuse-when: a prompt repeats across turns\nchannels: reddit, x\nverified: no\nread: 2026-10-27\n";

test("a card is read for its name, domains, use-when line and lesson headlines", () => {
  const parsed = card("x", "domains: testing, evals\nuse-when: you gate a change on its cost\n", "## Evidence\n- link \"q\"\n\n## Lessons\n- Fail a case over its budget: touches `a.mjs:3`; gap.\n- Prefer a gate over prose (#384): cost high.\n- Tag and manifest move together (S15). Touches plugin/lib/x.mjs:1; gap\n- Every rule is a checker branch (S12); but the doc and the checker drift\n- Not covered: anything else.\n");
  assert.deepEqual(parsed, { kind: "card", slug: "x", name: "o/x", domains: ["testing", "evals"], useWhen: "you gate a change on its cost", lessons: ["Fail a case over its budget", "Prefer a gate over prose (#384)", "Tag and manifest move together (S15)", "Every rule is a checker branch (S12)"] });
});

test("a note is read for its title, domains, channels, verification, read date and source URLs", () => {
  assert.deepEqual(note("cache-prefix", goodNote), { kind: "note", slug: "cache-prefix", place: "private", name: "Cache the stable prefix", domains: ["cost"], useWhen: "a prompt repeats across turns", channels: ["reddit", "x"], verified: "no", read: "2026-10-27", sources: ["https://example.com/post (read 2026-10-27)"], lessons: [] });
});

test("an entry without domains or use-when, a domain outside the vocabulary, or a note missing a channel, verification, date or source fails", () => {
  assert.deepEqual(entryErrors([card("a", ""), card("b", "domains: testing, magic\nuse-when: w\n"), card("c", "domains: cost\nuse-when: w\n")]), [
    "a: no domains: line; pick from " + Object.keys(DOMAINS).join(", "),
    "a: no use-when: line",
    "b: domain magic is not in the vocabulary",
  ]);
  assert.deepEqual(entryErrors([note("n", "domains: cost\nuse-when: w\nchannels: tiktok\nverified: maybe\nread: soon\n", "")]), [
    "notes/n: no title: line",
    "notes/n: channel tiktok is not one of github, docs, blog, reddit, x, youtube, facebook, substack, npm, hacker-news, report",
    "notes/n: verified must be yes or no",
    "notes/n: read must be the YYYY-MM-DD the sources were read",
    "notes/n: no source URL under ## Sources",
  ]);
  assert.deepEqual(entryErrors([note("ok", goodNote)]), []);
});

test("the index groups every entry under each of its domains, marks notes with their channels and verification, and links private notes from the private index", () => {
  const entries = [card("a", "domains: cost, evals\nuse-when: you price a run\n", "## Lessons\n- Count tokens: x.\n"), note("p", goodNote)];
  const index = renderIndex(entries);
  assert.match(index, /^## Contents\n\n- cost: 2 entries\n- evals: 1 entry\n/m);
  assert.match(index, /^## cost: /m);
  assert.match(index, /^- \[o\/a\]\(a\.md\): you price a run\n  - Count tokens$/m);
  assert.match(index, /^- \[Cache the stable prefix\]\(notes\/p\.md\) \(note, reddit, x, unverified 2026-10-27\): a prompt repeats across turns$/m);
  assert.ok(index.indexOf("## cost:") < index.indexOf("## evals:"));
  assert.doesNotMatch(index, /^## testing:/m);
  const privateIndex = renderIndex(entries, { link: privateLink });
  assert.match(privateIndex, /\]\(\.\.\/a\.md\)/);
  assert.match(privateIndex, /\]\(notes\/p\.md\)/);
});

test("every prior-art entry names its domains and use, and the committed knowledge index lists the public entries", () => {
  const entries = kitEntries(REPO);
  assert.ok(entries.filter((entry) => entry.kind === "card").length >= 30);
  assert.ok(entries.every((entry) => entry.kind === "card" || entry.place === "public"));
  assert.deepEqual(entryErrors(entries), []);
  assert.equal(readFileSync(join(REPO, "docs/prior-art/index.md"), "utf8"), renderIndex(entries), "run node plugin/scripts/prior-art-index.mjs write");
});
