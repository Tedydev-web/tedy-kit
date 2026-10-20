import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sweepMethodErrors } from "../lib/sweep-method-evidence.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const STUDY = fileURLToPath(new URL("../evals/probes/study/", import.meta.url));
const SWEEP = "261020-demo";

function build(...flags) {
  const repo = tempDir("v4-sweep-");
  const run = spawnSync("python3", ["-B", join(STUDY, "study_v4_fixture.py"), repo, ...flags], { encoding: "utf8", env: { ...process.env, STUDY_NO_NETWORK: "1" } });
  assert.equal(run.status, 0, run.stderr);
  return repo;
}

const built = build();
const pending = build("--no-audit");

function sweep(source = built) {
  const repo = tempDir("v4-copy-");
  cpSync(source, repo, { recursive: true });
  const folder = join(repo, "docs", "prior-art", "sweeps", SWEEP);
  const text = readFileSync(join(repo, "docs", "prior-art", "sweeps", `${SWEEP}.md`), "utf8");
  const json = (name) => JSON.parse(readFileSync(join(folder, name), "utf8"));
  const write = (name, value) => writeFileSync(join(folder, name), typeof value === "string" ? value : JSON.stringify(value));
  const topicFile = join(repo, "docs", "prior-art", "topics", "demo.json");
  return { repo, folder, text, json, write, topicFile, errors: (body = text) => sweepMethodErrors(repo, `${SWEEP}.md`, body).join("\n") };
}

const without = (text, pattern) => text.replace(new RegExp(`^${pattern}.*\\n`, "gm"), "");

test("a v4 sweep run end to end through the toolchain passes the gate, with the audit run or pending", () => {
  assert.equal(sweep().errors(), "");
  assert.equal(sweep(pending).errors(), "");
  assert.match(sweep(pending).text, /^- cross-family audit pending: config: /m);
});

test("the gate requires pooled recall with its interval, every facet's recall, and the config-pool channel count", () => {
  const s = sweep();
  assert.match(s.errors(without(s.text, "- config: pooled recall")), /config: no pooled recall at the stop with its 95% interval/);
  assert.match(s.errors(s.text.replace(/95% CI ([\d.]+)-([\d.]+)\) of the deduplicated product/, "of the deduplicated product")), /product: no pooled recall at the stop with its 95% interval/);
  assert.match(s.errors(without(s.text, "- product facet beta: ")), /product: no recall line for facet beta/);
  assert.match(s.errors(without(s.text, "- product channel from the config pool: ")), /no count of the repositories the config-pool channel joined/);
  const below = s.text.replace("of the deduplicated config standard, counting rows both sessions screened within a facet's depth; meets the 0.80 target", "of the deduplicated config standard, counting rows both sessions screened within a facet's depth; below the 0.80 target; missed: o/x");
  assert.match(s.errors(below), /config: pooled recall is below the target and the record names no recall target threat/);
});

test("the gate requires one screen per repository and each facet's own stop row and ranking", () => {
  const s = sweep();
  assert.match(s.errors(without(s.text, "- config: \\d+ repositories screened once")), /config: no facet overlap line counting each repository once/);
  assert.match(s.errors(without(s.text, "- beta ranking: ")), /facet beta: the record does not state the code-search queries its ranking counted/);
  assert.match(s.errors(s.text.replace(/; facet stop rows .*/g, "")), /config: no stop line stating each facet's stop row/);
  const topic = JSON.parse(readFileSync(s.topicFile, "utf8"));
  topic.facets.alpha.strata.config.stop_row = 30;
  writeFileSync(s.topicFile, JSON.stringify(topic));
  assert.match(s.errors(), /config: facet alpha's stop_row is 30, the record stops it at row 40; write it with facet-depth\.py --write-stop/);
});

test("the gate requires the calibration set, the user's complete labels and every judge qualified in two runs on it", () => {
  const s = sweep();
  assert.match(s.errors(without(s.text, "- product: calibration set of 60 rows")), /product: no calibration set of 60 rows drawn per facet/);
  assert.match(s.errors(without(s.text, "- qgs-B claude claude-sonnet-5-5, config: ")), /qgs-B claude-sonnet-5-5 config: no validation on the calibration set that qualifies it/);
  assert.match(s.errors(s.text.replace(/(- reader claude claude-opus-5-5, product: .*); qualified$/m, "$1; NOT qualified")), /reader claude-opus-5-5 product: no validation on the calibration set that qualifies it/);
  const meta = s.json("meta.json");
  const block = meta.sessions["judge-config-screening-B-claude-sonnet-5-5-run2"].blocks[0];
  block.row_sha256[String(block.ranks[0])] = "0".repeat(64);
  delete meta.sessions["judge-product-qgs-A-claude-opus-5-5-run1"];
  s.write("meta.json", meta);
  const errors = s.errors();
  assert.match(errors, /judge-config-screening-B-claude-sonnet-5-5-run2: the run judged other inputs than the calibration set holds/);
  assert.match(errors, /judge-product-qgs-A-claude-opus-5-5-run1: meta\.json records no judge run on the calibration set/);
  const labels = s.json("calibration-labels.json");
  s.write("calibration-labels.json", { ...labels, complete: labels.complete - 1 });
  assert.match(s.errors(), /the user labelled 119 of 120 calibration rows/);
  s.write("calibration-set.json", `${JSON.stringify(s.json("calibration-set.json"))}\n`);
  assert.match(s.errors(), /calibration-labels\.json was imported for another calibration set/);
});

test("the gate requires the cross-family check, the audit result or its threat, and the roster's family threats", () => {
  const s = sweep();
  assert.match(s.errors(without(s.text, "- product cross-family QGS judge ")), /product: no agreement of the cross-family QGS judge gemini-3\.8-flash-high/);
  assert.match(s.errors(without(s.text, "- config audit: ")), /config: no cross-family audit result and no pending audit threat/);
  const p = sweep(pending);
  assert.match(p.errors(without(p.text, "- cross-family audit pending: product: ")), /product: no cross-family audit result and no pending audit threat/);
  assert.match(s.errors(without(s.text, "- reader shares the QGS judges' model family: ")), /the reader shares the QGS judges' model family and the record names no threat/);
  assert.match(s.errors(without(s.text, "- recall is an upper estimate: ")), /no threat stating that recall is an upper estimate/);
  assert.match(s.errors(without(s.text, "- same model family: ")), /config: sessions A and B are both claude models and the record names no same model family threat/);
});

test("a record pinning criteria before v4 may not screen a facet that clusters several problems", () => {
  const s = sweep();
  const v3 = s.text.replace("docs/prior-art/quality-criteria-v4.md", "docs/prior-art/quality-criteria-v3.md");
  assert.match(s.errors(v3), /the record pins quality criteria v3, but its topic holds a facet of more than one problem, a cluster that quality criteria v4 introduced/);
});
