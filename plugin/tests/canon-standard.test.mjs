import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { kitLedger, ledgerErrors } from "../lib/canon-standard.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const FILES = { "plugin/tests/size.test.mjs": 'test("every skill is small", () => {});\ntest.skip("a skipped title", () => {});\n', "plugin/evals/size.mjs": 'test("every skill is small", () => {});\n' };
const fixture = (rules, version = 1) => ({ ledger: { version, rules }, read: (file) => FILES[file], exists: (file) => file in FILES });
const rule = (fields) => ({
  id: "small",
  text: "Every skill is small.",
  since: 1,
  reason: "Context costs.",
  class: "platform",
  problems: ["S22"],
  enforced: { kind: "test", file: "plugin/tests/size.test.mjs", title: "every skill is small" },
  notCovered: "Reference files.",
  approved: "2026-10-28",
  ...fields,
});

test("a rule whose test file, test title, fields, class, kind, version, date or problems are wrong fails", () => {
  assert.deepEqual(ledgerErrors(fixture([rule({}), rule({ id: "judged", enforced: { kind: "review", whyNotMachine: "A judgment." } })])), []);
  assert.deepEqual(ledgerErrors(fixture([
    rule({ id: "gone", enforced: { kind: "test", file: "plugin/tests/gone.test.mjs", title: "every skill is small" } }),
    rule({ id: "renamed", enforced: { kind: "test", file: "plugin/tests/size.test.mjs", title: "every skill is smal" } }),
    rule({ id: "skipped", enforced: { kind: "test", file: "plugin/tests/size.test.mjs", title: "a skipped title" } }),
    rule({ id: "unrun", enforced: { kind: "test", file: "plugin/evals/size.mjs", title: "every skill is small" } }),
    rule({ id: "bare", reason: "", notCovered: undefined }),
    rule({ id: "odd", class: "taste", enforced: { kind: "lint" } }),
    rule({ id: "future", since: 2, approved: "28/10/2026", problems: ["P1"] }),
    rule({ id: "unexplained", enforced: { kind: "review" } }),
    rule({ id: "unexplained" }),
  ])), [
    "gone: enforcing test file plugin/tests/gone.test.mjs does not exist",
    'renamed: plugin/tests/size.test.mjs has no test titled "every skill is smal"',
    'skipped: plugin/tests/size.test.mjs has no test titled "a skipped title"',
    "unrun: plugin/evals/size.mjs is not a test file npm test runs",
    "bare: no reason",
    "bare: no notCovered",
    "odd: unknown class taste",
    "odd: unknown enforcement kind lint",
    "future: since 2 is not a standard version from 1 to 1",
    "future: approved 28/10/2026 is not a YYYY-MM-DD date",
    "future: problems must list registry ids such as S12",
    "unexplained: a review rule needs whyNotMachine",
    "unexplained: the id repeats",
  ]);
  assert.deepEqual(ledgerErrors(fixture([rule({})], 0)), ["the standard has no positive integer version"]);
  assert.deepEqual(ledgerErrors(fixture([])), ["the standard has no rules"]);
});

test("every rule of the kit's standard names an existing check or a reason no machine can check it", () => {
  const kit = kitLedger(REPO);
  assert.ok(kit.ledger.rules.length >= 27, String(kit.ledger.rules.length));
  assert.deepEqual(ledgerErrors(kit), []);
});
