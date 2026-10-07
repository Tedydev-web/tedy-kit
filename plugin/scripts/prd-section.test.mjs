import { test } from "node:test";
import assert from "node:assert/strict";
import { findSections, indexTab, quoteInText, MAX_WORDS } from "./prd-section.mjs";

const lines = [
  "﻿EPIC 09: Sample Settings",
  "\tHand over the keys (UC_XX_02)",
  "\tUC_XX_01: View the Card",
  "Field",
  "\tContent",
  "\tUC_XX_01",
  "\tDescription",
  "\tThe card shows the wallet’s name — one line.",
  "\tOrdinary Sequence",
  "\t[Entry Point] Home → Settings.",
  "1. System — Shows the card.",
  "2. User — Taps the row.",
  "\tBusiness Rules",
  "\t• BR1 (Name): the name is never empty.",
  "• BR2 (Count): Member, Child and Viewer read {n} members.",
  "\tUC_XX_02: Hand Over the Keys",
  "\tDescription",
  "\tThe Owner picks a voter (UC_MB_S01 BR5).",
  "\tOrdinary Sequence",
  "1. System — Picker: hint \"The group votes on it.\"",
  "3. System — Confirm sheet; button Ask the group.",
  "\tAlternate Flows",
  "\tStep 1 (AF1 — already in the vote): tapping it opens Approvals with UC_XX_03 #7.",
  "\tBusiness Rules",
  "\t• BR1 (Recipient is a voter): Admin or Member.",
  "• BR3 (Votes as any voter): the recipient’s seal counts, as BR1 says.",
  "\tError States",
  "\tBackend unavailable → retry line in the confirm sheet.",
  "\tUC_XX_03: Toasts — the registry",
  "\tBusiness Rules",
  "\t• BR1 (One registry).",
  "\t",
  "",
  "#",
  "\tUC",
  "\tWhen",
  "\tToast",
  "\t1",
  "\tUC_XX_01",
  "\tName saved",
  "\tName and photo saved",
  "\t7",
  "\tUC_XX_02",
  "\tRow tapped while pending",
  "\tAlready waiting on the group",
  "[a][b]\t",
  "\tUC_XX_04: Anchored",
  "\tDescription",
  "\tThe rule holds[c] for every member.",
  "[a]Comment thread text that is not PRD content",
  "[b]thông tin ở đây là đúng nhất nha",
  "[c]another reply",
];
const TAB = lines.join("\r\n");

test("index lists every use case heading once, skipping table-of-contents mentions", () => {
  const index = indexTab(TAB);
  assert.deepEqual(index.map((entry) => entry.id), ["UC_XX_01", "UC_XX_02", "UC_XX_03", "UC_XX_04"]);
  assert.equal(index[1].title, "Hand Over the Keys");
  assert.ok(index[1].words > 10);
});

test("a bare use case id returns each of its fields as a section", () => {
  const { hits } = findSections(TAB, "UC_XX_02");
  assert.deepEqual(hits.map((hit) => hit.label), [
    "UC_XX_02 · Description",
    "UC_XX_02 · Ordinary Sequence",
    "UC_XX_02 · Alternate Flows",
    "UC_XX_02 · Business Rules",
    "UC_XX_02 · Error States",
  ]);
});

test("step, BR and AF locators return the defining line, not every mention", () => {
  assert.deepEqual(findSections(TAB, "UC_XX_02 step 3").hits.map((hit) => hit.text), ["3. System — Confirm sheet; button Ask the group."]);
  assert.deepEqual(findSections(TAB, "UC_XX_02 BR1").hits.map((hit) => hit.text), ["• BR1 (Recipient is a voter): Admin or Member."]);
  assert.equal(findSections(TAB, "UC_XX_02 AF1").hits[0].label, "UC_XX_02 · Alternate Flows · AF1");
});

test("a #n locator returns that registry row with one cell per line joined", () => {
  const { hits } = findSections(TAB, "UC_XX_03 #7");
  assert.deepEqual(hits, [{ label: "UC_XX_03 · #7", text: "7 | UC_XX_02 | Row tapped while pending | Already waiting on the group" }]);
  assert.ok(quoteInText("Name and photo saved", findSections(TAB, "UC_XX_03 #1").hits[0].text));
});

test("comment anchors are stripped and the trailing comment threads are not PRD content", () => {
  assert.equal(findSections(TAB, "UC_XX_04 Description").hits[0].text, "The rule holds for every member.");
  assert.equal(findSections(TAB, "not PRD content").hits.length, 0);
  assert.ok(quoteInText("The rule holds for every member.", TAB));
  assert.equal(quoteInText("thông tin ở đây là đúng nhất nha", TAB), false);
});

test("a field name narrows to that field", () => {
  const { hits } = findSections(TAB, "UC_XX_01 Business Rules");
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /BR2 \(Count\)/);
});

test("free text searches the whole tab and labels each hit with its use case and field", () => {
  const { hits } = findSections(TAB, "ask the group");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, "UC_XX_02 · Ordinary Sequence");
});

test("text is returned verbatim apart from the leading tab and line ending", () => {
  const { hits } = findSections(TAB, "UC_XX_01 Description");
  assert.equal(hits[0].text, "The card shows the wallet’s name — one line.");
});

test("zero hits report what was tried", () => {
  const result = findSections(TAB, "UC_XX_02 BR9");
  assert.equal(result.hits.length, 0);
  assert.match(result.tried, /UC_XX_02 found/);
  assert.match(result.tried, /BR9/);
  assert.match(findSections(TAB, "UC_ZZ_01").tried, /UC_ZZ_01 not in tab/);
});

test("a section longer than the cap is cut and says how to narrow", () => {
  const long = `\tUC_XX_09: Long\r\n\tDescription\r\n\t${Array.from({ length: MAX_WORDS + 50 }, (_, index) => `w${index}`).join(" ")}`;
  const { hits } = findSections(long, "UC_XX_09");
  assert.equal(hits[0].text.split(/\s+/).filter((word) => /^w\d+$/.test(word)).length, MAX_WORDS);
  assert.match(hits[0].text, /narrow with a locator/);
});

test("a quote extracted by find is found again in the full tab after whitespace normalisation", () => {
  for (const query of ["UC_XX_02 step 3", "UC_XX_01 BR2", "UC_XX_02 Error States"]) {
    const [hit] = findSections(TAB, query).hits;
    assert.ok(quoteInText(hit.text, TAB), query);
  }
  assert.ok(quoteInText("button  Ask the\ngroup.", TAB));
  assert.equal(quoteInText("button Ask the family.", TAB), false);
  assert.equal(quoteInText("the recipient's seal counts", TAB), false);
});
