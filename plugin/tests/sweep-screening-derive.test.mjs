import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EMPTY_TABLE, derive } from "../lib/sweep-screening-derive.mjs";

const STUDY = fileURLToPath(new URL("../evals/probes/study/", import.meta.url));
const score = (v) => ({ v, why: "w" });
const scores = (a, m, o, d, p, r = 1) => ({ authority: score(a), methodology: score(m), objectivity: score(o), date: score(d), position: score(p), relevance: score(r) });
const TABLE = { aliases: { "config:guard": "config:hook-guard" }, class: { "config:hook-guard": "known", "config:readme-claim": "evidence" }, default: "new" };
const MAPPING = { A: { "tdd gate": "tdd-gate" }, B: {} };
const ROWS = [
  { scores: scores(1, 1, 1, 1, 0.5), mechanisms: ["tdd gate"], decision: "eligible" },
  { scores: scores(1, 1, 1, 1, 0.5), mechanisms: ["guard"], decision: "eligible" },
  { scores: scores(1, 1, 0.5, 0.5, 0.5), mechanisms: ["guard"], decision: "eligible" },
  { scores: scores(1, 1, 1, 1, 1), mechanisms: ["readme-claim"], decision: "eligible" },
  { scores: scores(1, 1, 1, 1, 1, 0.5), mechanisms: [], decision: "excluded: irrelevant" },
  { scores: scores(1, 1, 1, 1, 1), mechanisms: ["tdd gate"], decision: "excluded: copy (of o/a)" },
  { scores: scores(0, 0, 0, 0, 0), mechanisms: [], decision: "excluded: dead" },
];

function python(table, mapping) {
  const code = "import json,sys;from study_screening_core import MechanismTable,derive;a=json.loads(sys.argv[1]);t=MechanismTable(a['table']);"
    + "print(json.dumps([{**d,'mechs':sorted(d['mechs'])} for d in (derive(t,'config',a['mapping'],'A',r) for r in a['rows'])]))";
  const run = spawnSync("python3", ["-B", "-c", code, JSON.stringify({ table, mapping, rows: ROWS })], { cwd: STUDY, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test("the gate's derive gives the study toolchain's decision, novelty, relevance and total for every row", () => {
  for (const [table, mapping] of [[TABLE, MAPPING], [EMPTY_TABLE, { A: {}, B: {} }]]) {
    const ours = ROWS.map((row) => {
      const d = derive(table, "config", mapping, "A", row);
      return { ...d, mechs: [...d.mechs].sort() };
    });
    assert.deepEqual(ours, python(table, mapping));
  }
  assert.equal(derive(TABLE, "config", MAPPING, "A", ROWS[0]).decision, "eligible");
  assert.equal(derive(TABLE, "config", MAPPING, "A", ROWS[2]).decision, "excluded: below-threshold");
  assert.equal(derive(TABLE, "config", MAPPING, "A", ROWS[5]).decision, "excluded: copy");
});
