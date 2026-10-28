import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { applies, audit, conformanceErrors, kitConformance, kitLedger, ledgerErrors } from "../lib/canon-standard.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const FILES = { "plugin/tests/size.test.mjs": 'test("every skill is small", () => {});\ntest.skip("a skipped title", () => {});\n', "plugin/evals/size.mjs": 'test("every skill is small", () => {});\n' };
const entry = (version) => ({ version, date: "2026-10-28", trigger: "A gap.", change: "A rule.", redid: [] });
const fixture = (rules, version = 1, history = [entry(1)]) => ({ ledger: { version, history, rules }, read: (file) => FILES[file], exists: (file) => file in FILES });
const rule = (fields) => ({
  id: "small",
  text: "Every skill is small.",
  since: 1,
  scope: "skill",
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
    rule({ id: "odd", class: "taste", scope: "everywhere", enforced: { kind: "lint" } }),
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
    "odd: unknown scope everywhere",
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

test("a standard whose history misses, repeats or overshoots a version, or whose entry lacks a field, fails", () => {
  assert.deepEqual(ledgerErrors(fixture([rule({})], 2, [entry(1), entry(2)])), []);
  assert.deepEqual(ledgerErrors(fixture([rule({})], 2, [entry(1)])), ["history needs exactly one entry for version 2, found 0"]);
  assert.deepEqual(ledgerErrors(fixture([rule({})], 1, [entry(1), entry(1), entry(3)])), ["history needs exactly one entry for version 1, found 2", "history holds a version outside 1 to 1"]);
  assert.deepEqual(ledgerErrors(fixture([rule({})], 1, [{ version: 1, date: "today" }])), ["history 1: no trigger", "history 1: no change", "history 1: date today is not YYYY-MM-DD", "history 1: redid must list the artifacts redone"]);
  assert.deepEqual(ledgerErrors(fixture([rule({})], 1, null)), ["the standard has no history"]);
});

const standard = (version) => ({ version, rules: [rule({ id: "small" }), rule({ id: "named", since: 2 })] });
const waiver = (fields) => ({ rule: "small", artifact: "skills/old.md", reason: "Rewritten in the next pass.", approved: "2026-10-28", version: 2, ...fields });

test("an unregistered artifact, a registered file that is gone, an out-of-range version or a malformed waiver fails", () => {
  const ok = conformanceErrors({ ledger: standard(2), conformance: { artifacts: { "skills/old.md": 1, "skills/new.md": 2 }, waivers: [waiver({})] }, artifacts: ["skills/old.md", "skills/new.md"], base: null });
  assert.deepEqual(ok.errors, []);
  assert.match(ok.skipped, /no release tag holds the standard/);
  const bad = conformanceErrors({
    ledger: standard(2),
    conformance: { artifacts: { "skills/old.md": 1, "skills/gone.md": 1, "skills/future.md": 3 }, waivers: [waiver({}), waiver({}), waiver({ rule: "renamed", artifact: "skills/stray.md", reason: "", approved: "soon", version: 0 })] },
    artifacts: ["skills/old.md", "skills/future.md", "skills/unlisted.md"],
    base: null,
  });
  assert.deepEqual(bad.errors, [
    "skills/unlisted.md: not in the conformance register",
    "skills/gone.md: registered but not a kit artifact",
    "skills/future.md: version 3 is not a standard version from 1 to 2",
    "waiver small skills/old.md: repeats",
    "waiver renamed skills/stray.md: unknown rule",
    "waiver renamed skills/stray.md: the artifact is not registered",
    "waiver renamed skills/stray.md: no reason",
    "waiver renamed skills/stray.md: approved soon is not YYYY-MM-DD",
    "waiver renamed skills/stray.md: version 0 is not a standard version from 1 to 2",
  ]);
});

test("against the latest release, a waiver added without a new standard version, a lowered version or a new artifact below the current version fails", () => {
  const base = { ledger: standard(1), conformance: { artifacts: { "skills/old.md": 1, "skills/kept.md": 2 }, waivers: [] } };
  const now = (artifacts, waivers, version = 2) => conformanceErrors({ ledger: standard(version), conformance: { artifacts, waivers }, artifacts: Object.keys(artifacts), base });
  assert.deepEqual(now({ "skills/old.md": 1, "skills/kept.md": 2, "skills/new.md": 2 }, [waiver({ version: 2 })]), { errors: [], skipped: null });
  assert.deepEqual(now({ "skills/old.md": 1, "skills/kept.md": 1, "skills/new.md": 1 }, [waiver({ version: 1 })]).errors, [
    "waiver small skills/old.md: added without a new standard version (the release has version 1)",
    "skills/kept.md: version went down from 2 to 1",
    "skills/new.md: new since the release and registered at version 1, not the current 2",
  ]);
  const shrunk = { ledger: standard(2), conformance: { artifacts: { "skills/old.md": 1 }, waivers: [waiver({ version: 2 })] } };
  assert.deepEqual(conformanceErrors({ ledger: standard(2), conformance: { artifacts: { "skills/old.md": 1 }, waivers: [] }, artifacts: ["skills/old.md"], base: shrunk }).errors, []);
});

test("a rule applies to an artifact only from the version that added it and only without a waiver, and an unknown rule or artifact throws", () => {
  const register = { ledger: standard(2), conformance: { artifacts: { "skills/old.md": 1, "skills/new.md": 2 }, waivers: [waiver({ artifact: "skills/new.md" })] } };
  assert.equal(applies(register, "named", "skills/old.md"), false);
  assert.equal(applies(register, "named", "skills/new.md"), true);
  assert.equal(applies(register, "small", "skills/old.md"), true);
  assert.equal(applies(register, "small", "skills/new.md"), false);
  assert.throws(() => applies(register, "renamed", "skills/old.md"), /no rule renamed/);
  assert.throws(() => applies(register, "small", "skills/unlisted.md"), /not in the conformance register/);
  assert.deepEqual(audit(register), [
    { artifact: "skills/old.md", version: 1, notJudgedBy: ["named"], waived: [] },
    { artifact: "skills/new.md", version: 2, notJudgedBy: [], waived: ["small"] },
  ]);
});

test("every rule of the kit's standard names an existing check or a reason no machine can check it", () => {
  const kit = kitLedger(REPO);
  assert.ok(kit.ledger.rules.length >= 27, String(kit.ledger.rules.length));
  assert.deepEqual(ledgerErrors(kit), []);
});

test("every kit skill, ADR, card and sweep record is in the conformance register and the register holds against the latest release", (t) => {
  const kit = kitConformance(REPO);
  assert.ok(kit.artifacts.length >= 40, String(kit.artifacts.length));
  const { errors, skipped } = conformanceErrors(kit);
  if (skipped) t.diagnostic(`skipped: ${skipped}`);
  assert.deepEqual(errors, []);
});
