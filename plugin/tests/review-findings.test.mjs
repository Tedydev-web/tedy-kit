import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchFindings, reviewerOutputs } from "../lib/review-findings.mjs";

const planted = [
  { id: "off-by-one", at: [{ file: "src/cart.ts", lines: [5] }] },
  { id: "string-total", at: [{ file: "src/cart.ts", lines: [6] }, { file: "src/checkout.ts", lines: [4] }] },
  { id: "unawaited", at: [{ file: "src/cart.ts", lines: [12, 13, 14] }] },
];

test("a planted problem counts as found when a finding header names one of its lines, and other findings count as extra", () => {
  const text = [
    "### 1. CONFIRMED · src/cart.ts:5",
    "State: the loop reads one past the end.",
    "### 2. PLAUSIBLE · /tmp/x/work/src/checkout.ts:4",
    "### 3. CONFIRMED · src/cart.ts:17",
    "### 4. CONFIRMED · src/cart.ts:14",
    "Pre-existing:",
    "### 5. CONFIRMED · src/cart.ts:6",
  ].join("\n");
  assert.deepEqual(matchFindings(text, planted), { found: ["off-by-one", "string-total", "unawaited"], missed: [], findings: 4, extra: 1 });
  assert.deepEqual(matchFindings("### 1. CONFIRMED · src/cart.ts:9\nPre-existing:\n### 2. CONFIRMED · src/cart.ts:5", planted), { found: [], missed: ["off-by-one", "string-total", "unawaited"], findings: 1, extra: 1 });
  assert.deepEqual(matchFindings("### 1. CONFIRMED · src/money.ts:5", planted).found, []);
  assert.deepEqual(matchFindings("  ### 1. CONFIRMED · src/cart.ts:5\n  Pre-existing:\n  ### 2. CONFIRMED · src/cart.ts:6", planted), { found: ["off-by-one"], missed: ["string-total", "unawaited"], findings: 1, extra: 0 });
});

test("a planted problem with words is found only by a finding on its lines whose text names it", () => {
  const named = [{ id: "kebab", at: [{ file: "src/priceTag.ts", lines: [1, 2, 3], words: /kebab|file ?name/i }] }];
  assert.deepEqual(matchFindings("### 1. CONFIRMED · src/priceTag.ts:3\nState: the price has no unit.\n### 2. CONFIRMED · src/money.ts:1\nState: file name", named), { found: [], missed: ["kebab"], findings: 2, extra: 2 });
  assert.deepEqual(matchFindings("### 1. CONFIRMED · src/money.ts:1\nState: x\n### 2. CONFIRMED · src/priceTag.ts:1\nState: the file name is not kebab-case.", named), { found: ["kebab"], missed: [], findings: 2, extra: 1 });
});

test("only the reviewer subagent's own results are read, not the main session's relay", () => {
  const events = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Agent", input: { subagent_type: "tedy:reviewer", prompt: "lens bugs" } }, { type: "tool_use", id: "b", name: "Agent", input: { subagent_type: "Explore" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "### 1. CONFIRMED · src/cart.ts:5" }] }, { type: "tool_result", tool_use_id: "b", content: "### 9. CONFIRMED · src/cart.ts:12" }] } },
    { type: "result", result: "### 2. CONFIRMED · src/cart.ts:12" },
  ];
  assert.deepEqual(reviewerOutputs(events), ["### 1. CONFIRMED · src/cart.ts:5"]);
  assert.deepEqual(reviewerOutputs([{ type: "result", result: "x" }]), []);
});
