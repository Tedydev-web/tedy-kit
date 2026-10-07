import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRates, isoWeek } from "./edit-rate.mjs";
import { labelText } from "./edit-log.mjs";

test("labelText tells unchanged, trimmed and edited apart", () => {
  const draft = "Nút đang sai ạ.\n\nPRD EPIC 09 · UC_SW_08 step 3:\n> button Ask the group.";
  assert.equal(labelText(draft, "Nút  đang sai ạ.\n\nPRD EPIC 09 · UC_SW_08 step 3:\n> button Ask the group."), "unchanged");
  assert.equal(labelText(draft, "Nút đang sai ạ."), "trimmed");
  assert.equal(labelText(draft, "Nút đang là Ask the family ạ."), "edited");
});

test("ISO weeks follow the Monday start and the Thursday rule", () => {
  assert.equal(isoWeek("2026-10-07T04:00:00Z"), "2026-W41");
  assert.equal(isoWeek("2026-01-01T04:00:00Z"), "2026-W01");
  assert.equal(isoWeek("2027-01-01T04:00:00Z"), "2026-W53");
});

test("rates are per channel and week, count trimmed as kept, and leave added and replies out of the rate", () => {
  const entries = [
    { ts: "2026-10-07T01:00:00Z", pr: 703, label: "unchanged" },
    { ts: "2026-10-07T01:00:00Z", pr: 703, label: "trimmed" },
    { ts: "2026-10-07T01:00:00Z", pr: 703, label: "edited" },
    { ts: "2026-10-07T01:00:00Z", pr: 703, label: "cut" },
    { ts: "2026-10-07T01:00:00Z", pr: 703, label: "added" },
    { ts: "2026-10-07T01:00:00Z", channel: "pr-comment", label: "reply" },
    { ts: "2026-10-08T01:00:00Z", channel: "figma-comment", label: "unchanged" },
  ];
  assert.deepEqual(computeRates(entries), [
    { channel: "figma-comment", week: "2026-W41", kept: 1, edited: 0, cut: 0, added: 0, rate: 1 },
    { channel: "pr-comment", week: "2026-W41", kept: 2, edited: 1, cut: 1, added: 1, rate: 0.5 },
  ]);
});
