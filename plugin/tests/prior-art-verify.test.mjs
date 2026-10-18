import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyText } from "../lib/prior-art-verify.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const SCRIPT = new URL("../lib/prior-art-verify.mjs", import.meta.url).pathname;
const SHA = "0123456789abcdef".repeat(2) + "01234567";
const blob = (anchor) => `https://github.com/o/r/blob/${SHA}/skills/tdd/SKILL.md${anchor}`;
const RAW = ["# TDD", "", "Write the failing test first.", "Watch it fail.", "Then write the code.", "", "Never skip the red run."].join("\n");
const issue = (state, reason, extra = {}) => JSON.stringify({ state, state_reason: reason, body: "The agent wrote code before the test.", ...extra });

const recorded = {
  [`-H Accept: application/vnd.github.raw repos/o/r/contents/skills/tdd/SKILL.md?ref=${SHA}`]: RAW,
  "repos/o/r/issues/1": issue("closed", "completed"),
  "repos/o/r/issues/1/comments --paginate --jq .[].body": "Fixed by making the red run mandatory.\n",
  "repos/o/r/issues/2": issue("closed", "not_planned"),
  "repos/o/r/issues/2/comments --paginate --jq .[].body": "",
  "repos/o/r/issues/3": issue("open", null),
  "repos/o/r/issues/3/comments --paginate --jq .[].body": "",
  "repos/o/r/issues/4": issue("closed", null, { pull_request: {} }),
  "repos/o/r/pulls/4": JSON.stringify({ merged_at: "2026-01-02T00:00:00Z" }),
  "repos/o/r/issues/4/comments --paginate --jq .[].body": "",
  "repos/o/r/issues/5": issue("closed", null, { pull_request: {} }),
  "repos/o/r/pulls/5": JSON.stringify({ merged_at: null }),
  "repos/o/r/issues/5/comments --paginate --jq .[].body": "",
  [`-H Accept: application/vnd.github.raw repos/o/r/contents/gone.md?ref=${SHA}`]: null,
};
const ghApi = (args) => {
  const key = args.join(" ");
  if (!(key in recorded)) throw new Error(`unrecorded call: ${key}`);
  return recorded[key];
};
const labels = (text) => verifyText("a.md", text, ghApi).map((row) => `${row.line} ${row.labels.join(" ")}`);

test("a pinned excerpt at its anchored lines is ok, elsewhere in the file is wrong-lines, absent is missing", () => {
  const text = [
    `  - ${blob("#L3-L4")} "Write the failing test first. Watch it fail."`,
    `  - ${blob("?plain=1#L3")} "Never skip the red run."`,
    `  - ${blob("#L7")} "Mock everything."`,
    `  - https://github.com/o/r/blob/${SHA}/gone.md#L1 "x"`,
  ].join("\n");
  assert.deepEqual(labels(text), ["1 ok", "2 wrong-lines", "3 missing", "4 missing"]);
});

test("issue and pull request links report their state and whether the excerpt is in the body or comments", () => {
  const text = [
    '- https://github.com/o/r/issues/1 "making the red run mandatory"',
    '- https://github.com/o/r/issues/2 "wrote code before the test"',
    '- https://github.com/o/r/issues/3 "not said anywhere"',
    '- https://github.com/o/r/pull/4 "wrote code before the test"',
    '- https://github.com/o/r/pull/5 "wrote code before the test"',
  ].join("\n");
  assert.deepEqual(labels(text), ["1 completed excerpt-found", "2 not-planned excerpt-found", "3 open excerpt-absent", "4 merged excerpt-found", "5 closed-unmerged excerpt-found"]);
});

test("evidence the script cannot check is listed as unchecked, and a link without an excerpt is flagged", () => {
  const text = [
    '  - https://www.reddit.com/r/ClaudeCode/comments/abc/x/ "quote"',
    "  - ~/.claude/skills/ak-test/SKILL.md:12",
    '  - `claude plugin eval --help` (Claude Code 2.1.302) "--ablation"',
    'no social prior art: 2026-10-18 x: "a"; reddit: "b"',
    `  - ${blob("#L3")}`,
  ].join("\n");
  assert.deepEqual(labels(text), ["1 unchecked", "2 unchecked", "3 unchecked", "4 unchecked", "5 no-excerpt"]);
});

test("the command exits 1 when a link is broken, 0 when every checked link holds, and 2 on a missing file", () => {
  const dir = tempDir("tedy-verify-");
  const file = join(dir, "card.md");
  writeFileSync(file, "  - https://www.reddit.com/r/x/comments/a/b/ \"q\"\n");
  const ok = spawnSync("node", [SCRIPT, file], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `${file}:1 unchecked https://www.reddit.com/r/x/comments/a/b/\n`);
  assert.equal(spawnSync("node", [SCRIPT, join(dir, "absent.md")], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("node", [SCRIPT], { encoding: "utf8" }).status, 2);
});
