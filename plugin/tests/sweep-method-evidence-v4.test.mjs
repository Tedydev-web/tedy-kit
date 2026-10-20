import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sweepMethodErrors } from "../lib/sweep-method-evidence.mjs";
import { canonical, kappa, lowerBound } from "../lib/sweep-method-evidence-v4.mjs";
import { regenerationErrors } from "../lib/sweep-method-evidence-v4-regeneration.mjs";
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
const escalated = build("--escalate");

function sweep(source = built) {
  const repo = tempDir("v4-copy-");
  cpSync(source, repo, { recursive: true });
  const folder = join(repo, "docs", "prior-art", "sweeps", SWEEP);
  const text = readFileSync(join(repo, "docs", "prior-art", "sweeps", `${SWEEP}.md`), "utf8");
  const raw = (name) => readFileSync(join(folder, name), "utf8");
  const json = (name) => JSON.parse(raw(name));
  const jsonl = (name) => raw(name).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const write = (name, value) => writeFileSync(join(folder, name), typeof value === "string" ? value : JSON.stringify(value));
  const writeRows = (name, rows) => write(name, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  const topicPath = join(repo, "docs", "prior-art", "topics", "demo.json");
  const topic = (edit) => writeFileSync(topicPath, JSON.stringify(edit(JSON.parse(readFileSync(topicPath, "utf8")))));
  const rendered = () => {
    const run = spawnSync("python3", ["-B", join(STUDY, "..", "prior-art-sweep-record.py"), repo, SWEEP, "--stdout"], { encoding: "utf8", env: { ...process.env, STUDY_NO_NETWORK: "1" } });
    return run.status === 0 ? run.stdout : text;
  };
  return { repo, folder, text, json, jsonl, write, writeRows, topic, rendered, errors: (body = text) => sweepMethodErrors(repo, `${SWEEP}.md`, body).join("\n") };
}

function failsBothLayers(s, python, gate, name) {
  const errors = s.errors(s.rendered());
  assert.ok(errors.split("\n").some((l) => l.startsWith("the record renderer refused the sweep files: ") && python.test(l)), `${name}: renderer\n${errors}`);
  assert.ok(errors.split("\n").some((l) => !l.startsWith("the record renderer refused") && gate.test(l)), `${name}: gate\n${errors}`);
}

test("the Clopper-Pearson lower bound and kappa match the study toolchain", () => {
  assert.equal(lowerBound(59, 59).toFixed(4), "0.9505");
  assert.ok(lowerBound(58, 58) < 0.95);
  assert.equal(kappa([[true, true], [false, false]]), 1);
  assert.ok(kappa([...Array(6).fill([true, true]), ...Array(7).fill([false, true]), ...Array(90).fill([false, false])]) < 0.6);
});

test("a v4 sweep run end to end through the toolchain passes the gate, with the cross-family audit run or pending", () => {
  assert.equal(sweep().errors(), "");
  assert.equal(sweep(pending).errors(), "");
  assert.match(sweep(pending).text, /^- cross-family audit pending: config: /m);
});

test("a v4 record with any added line fails the gate at that line, because the gate rebuilds the record with the Python renderer", () => {
  const s = sweep();
  const lines = s.text.split("\n");
  const audit = "- cross-family audit pending: config: 0 of 20 audit rows screened by gemini-3.8-flash-high; the same-family screening has no cross-family check until it runs";
  const probes = [
    ["judges: a qgs-A line for agy gemini", "- qgs-A claude claude-opus-5-5, config", (l) => l.replace("claude claude-opus-5-5", "agy gemini-3.8-flash-high")],
    ["judges: a screening-B line for claude-haiku-4-5", "- screening-B claude claude-sonnet-5-5, config", (l) => l.replace("claude-sonnet-5-5", "claude-haiku-4-5")],
    ["judges: a standard of 60 members", "- standard: ", (l) => l.replace("47 members", "60 members")],
    ["judges: a second QGS reader line", "- QGS reader: ", (l) => l.replace("judged 2", "judged 3")],
    ["judges: a product audit line with A 10/19", "- product audit: ", (l) => l.replace("with A 19/19 (kappa 1.000)", "with A 10/19 (kappa 0.100)")],
    ["stage 1: rung 2 meets the rule", "- rung 1: ", (l) => l.replace("- rung 1:", "- rung 2:")],
    ["stage 1: rung 2 chosen", "- chosen: ", (l) => l.replace("rung 1 after 1", "rung 2 after 2")],
    ["stage 1: a held-out confirmation on a rung-1 sweep", "- config stage-1 audit: ", () => "- held-out confirmation: rung 2 passed 10/10 held-out positives, missed none; the batch's own one-sided lower bound 0.7411; the pooled bound above was measured on the set the rung was chosen on"],
    ["stage 1: an audit line with bound 0.0100", "- config stage-1 audit: ", (l) => l.replace("0.1707", "0.0100")],
    ["stage 1: a ladder line naming claude-haiku-4-5", "- ladder frozen ", (l) => l.replace("rung 1 claude-sonnet-5-5", "rung 1 claude-haiku-4-5")],
    ["calibration: a top-up line without a top-up", "- positives pooled ", () => "- top-up product: 15 rows (fewer than 59 positives pooled (40): the rows join the pooled bound), drawn per facet alpha 8, beta 7; likely positives 15; the user labelled 9 eligible"],
    ["calibration: positives pooled 99", "- positives pooled ", (l) => l.replace(": 66", ": 99")],
    ["calibration: a 59-row config line", "- calibration config: ", (l) => l.replace("60 rows", "59 rows")],
    ["recall: a facet gamma", "- facet beta: ", (l) => l.replace("facet beta", "facet gamma")],
    ["recall: pooled recall 47/47", "- pooled topic recall ", (l) => l.replace("38/47", "47/47")],
    ["recall: facet alpha 26/26", "- facet alpha: ", (l) => l.replace("20/26", "26/26")],
    ["recall: the config pool recovers 23 of 23", "- product channel from the config pool: ", (l) => l.replace("recover 4 of", "recover 23 of")],
    ["recall: QGS recall is exact", "- QGS recall is an upper estimate", () => "- QGS recall is exact: the standard holds every relevant repository"],
    ["PRISMA: identified fake", "| product | identified: repo |", () => "| product | identified: fake | 5 |"],
    ["PRISMA: a duplicate stage-2 eligible row", "| product | stage 2: eligible |", (l) => l.replace("| 16 |", "| 20 |")],
    ["stratum table: an invented row", /^\| \d+ \| /, () => `| 999 | o/fake | https://github.com/o/fake/commit/${"a".repeat(40)} | A1 M1 O1 D1 P1 N1 | eligible | - | - | alpha |`],
    ["threats: a second discovery gap", "- discovery gap: ", (l) => l.replace("o/outside1", "o/outside2")],
    ["threats: no cross-family audit while it ran", "- discovery gap: ", () => "- no cross-family audit: the topic config names no cross_family model, so no model of another family checks the screening"],
    ["threats: a pending audit beside the audit", "- discovery gap: ", () => audit],
    ["threats: a second stage 2 stopped line", "- stage 2 stopped before every stage-1 pass: product", (l) => l.replace("20 of 85", "85 of 85")],
    ["facets: alpha with other terms", "- alpha: problems ", (l) => l.replace("terms tdd, test", "terms tdd")],
    ["facets: config 30 repositories included", "- config: 16 repositories included", (l) => l.replace("16 repositories", "30 repositories")],
    ["other: an extra stop line", "stop: stage 2 ranked", (l) => l.replace("depth 42", "depth 183")],
    ["other: an extra kappa line", "- config kappa: ", (l) => l.replace("eligibility kappa 1.000", "eligibility kappa 0.400")],
    ["other: a snowball line with a cut", "- snowball: ", (l) => l.replace(/\(cut: .*\)/, "(cut: row 5)")],
    ["other: a Notes section claiming rung 2", "## Threats", () => "## Notes"],
  ];
  assert.equal(probes.length, 31);
  for (const [name, anchor, make] of probes) {
    const at = lines.findIndex((l) => (typeof anchor === "string" ? l.startsWith(anchor) : anchor.test(l)));
    assert.ok(at >= 0, name);
    const added = make(lines[at]);
    assert.notEqual(added, lines[at], name);
    const body = [...lines.slice(0, at), added, ...lines.slice(at)].join("\n");
    assert.ok(s.errors(body).includes(`the record is not the one the renderer rebuilds from the sweep files: line ${at + 1} reads ${JSON.stringify(added)}, the renderer writes ${JSON.stringify(lines[at])}`), name);
  }
  assert.match(s.errors(`${s.text}\n`), /line \d+ reads "", the renderer writes the end of the file/);
});

test("the gate fails when the Python renderer refuses the sweep files, as for QGS labels that are not the standard the judge files give", () => {
  const s = sweep();
  s.writeRows("qgs-judge-A.jsonl", s.jsonl("qgs-judge-A.jsonl").map((r) => (r.repo === "o/a2" ? { ...r, problems: ["X1", "X3"] } : r)));
  assert.match(s.errors(), /^the record renderer refused the sweep files: .*qgs-adjudicated\.json is not the standard its judge files give/m);
});

test("the gate fails when python3 cannot run the record renderer", () => {
  const s = sweep();
  const path = process.env.PATH;
  process.env.PATH = tempDir("no-python-");
  try {
    assert.match(s.errors(), /^python3 could not run the record renderer \(ENOENT\): the v4 gate rebuilds the record with plugin\/evals\/probes\/prior-art-sweep-record\.py and needs python3 on PATH/m);
  } finally {
    process.env.PATH = path;
  }
});

test("the gate stops a hung record renderer at its timeout and fails", () => {
  const s = sweep();
  const bin = tempDir("hung-python-");
  writeFileSync(join(bin, "python3"), `#!${process.execPath}\nsetTimeout(() => {}, 30000);\n`);
  chmodSync(join(bin, "python3"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = bin;
  try {
    const started = Date.now();
    assert.deepEqual(regenerationErrors(s.repo, SWEEP, s.text, { timeout: 300 }), [
      "the record renderer ran longer than 300 ms and was stopped; the v4 gate fails rather than wait on a hung renderer",
    ]);
    assert.ok(Date.now() - started < 10000);
  } finally {
    process.env.PATH = path;
  }
});

test("item 2: a QGS candidate judged by one judge and not dropped with a reason fails the gate", () => {
  const s = sweep();
  const rows = s.jsonl("qgs-judge-B.jsonl");
  s.writeRows("qgs-judge-B.jsonl", rows.slice(1));
  const meta = s.json("meta.json");
  for (const block of meta.sessions["qgs-judge-B"].blocks) block.ranks = block.ranks.filter((r) => r !== rows[0].id);
  s.write("meta.json", meta);
  assert.match(s.errors(), new RegExp(`QGS gap: candidate ${rows[0].id} ${rows[0].repo} is not judged by both judges and not dropped with a reason`));
  const dropped = s.json("qgs-dropped.json");
  s.write("qgs-dropped.json", { ...dropped, [rows[0].id]: { repo: rows[0].repo, reason: " ", date: "2026-10-20" } });
  assert.match(s.errors(), new RegExp(`QGS candidate ${rows[0].id} is dropped without a reason`));
  const r = sweep();
  const judged = r.jsonl("qgs-judge-A.jsonl");
  const yes = judged.find((row) => row.verdict === "yes");
  r.writeRows("qgs-judge-A.jsonl", judged.map((row) => (row === yes ? { ...row, strata: [] } : row)));
  assert.match(r.errors(), new RegExp(`qgs-judge-A\\.jsonl id ${yes.id}: a yes names its strata \\(config, product or both\\), any other verdict none`));
  const adjudicated = r.json("qgs-adjudicated.json");
  r.write("qgs-adjudicated.json", { ...adjudicated, strata: { ...adjudicated.strata, [yes.repo]: ["config", "product"] } });
  assert.match(r.errors(), /qgs-adjudicated\.json does not hold the member strata the judges labelled/);
  const t = sweep();
  const final = t.json("qgs-adjudicated.json");
  t.write("qgs-adjudicated.json", { ...final, final: final.final.slice(1) });
  assert.match(t.errors(), /qgs-adjudicated\.json is not the standard the judge, reader and cross-family files give/);
});

test("item 7: judgments from an unvalidated judge, input shape or packet fail the gate", () => {
  const s = sweep();
  const meta = s.json("meta.json");
  meta.sessions["qgs-judge-A"].blocks[0].shape = "full";
  meta.sessions["qgs-reader"].model = "claude-sonnet-5-5";
  s.write("meta.json", meta);
  const errors = s.errors();
  assert.match(errors, /qgs-judge-A\.jsonl: its judgments come from outside the validated workflow/);
  assert.match(errors, /qgs-reader\.jsonl: its judgments come from outside the validated workflow/);
  const t = sweep();
  const runs = t.json("meta.json");
  const block = runs.sessions["judge-config-qgs-B-claude-sonnet-5-5-run1"].blocks[0];
  const set = t.json("calibration-labels.json").rows.find((r) => r.stratum === "config" && String(r.order_rank) === String(block.ranks[0]));
  block.row_sha256[String(block.ranks[0])] = set.inputs_sha256;
  t.write("meta.json", runs);
  assert.match(t.errors(), /judge-config-qgs-B-claude-sonnet-5-5-run1: the run judged other inputs than the calibration rows hold in the thin shape/);
  const u = sweep();
  const flipped = u.jsonl("judge-product-qgs-A-claude-opus-5-5-run2.jsonl").map((r, i) => (i < 8 ? { ...r, verdict: r.verdict === "yes" ? "no" : "yes" } : r));
  u.writeRows("judge-product-qgs-A-claude-opus-5-5-run2.jsonl", flipped);
  assert.match(u.errors(), /judge-product-qgs-A-claude-opus-5-5-run2: qgs-A claude-opus-5-5 does not qualify on the product calibration rows/);
  const v = sweep();
  v.write("stage1-rung.json", { ...v.json("stage1-rung.json"), rung: 2 });
  assert.match(v.errors(), /stage1-rung\.json chose rung 2, but the first rung the calibration files certify is rung 1/);
});

test("H-judges: the gate recomputes screening judge qualification and every judge metric line from the validation runs", () => {
  const key = (run) => `judge-config-screening-A-claude-opus-5-5-run${run}`;
  const s = sweep();
  for (const run of [1, 2]) s.write(`${key(run)}.jsonl`, "");
  assert.match(s.errors(), new RegExp(`${key(1)}\\.jsonl covers ranks .* that the config calibration rows do not, or the reverse`));
  const t = sweep();
  for (const run of [1, 2]) {
    const zero = Object.fromEntries(["Authority", "Methodology", "Objectivity", "Date", "Position", "Novelty", "Relevance"].map((c) => [c, { v: 0, why: "w" }]));
    t.writeRows(`${key(run)}.jsonl`, t.jsonl(`${key(run)}.jsonl`).map((r) => ({ ...r, scores: zero, mechanisms: [], decision: "excluded: irrelevant" })));
  }
  assert.match(t.errors(), new RegExp(`${key(1)}: screening-A claude-opus-5-5 does not qualify on the config calibration rows \\(sensitivity 0, kappa `));
  const u = sweep();
  const meta = u.json("meta.json");
  meta.sessions[key(1)].blocks[0].packet_sha256 = "f".repeat(64);
  u.write("meta.json", meta);
  assert.match(u.errors(), new RegExp(`${key(1)}: a block ran under a packet or criteria other than the frozen ones`));
  const v = sweep();
  const line = /^- screening-A claude claude-opus-5-5, config, full inputs, batches calibration: run 1 sensitivity 1\.000/m;
  assert.match(v.text, line);
  assert.match(v.errors(v.text.replace(line, (m) => m.replace("sensitivity 1.000", "sensitivity 0.420"))),
    /screening-A claude claude-opus-5-5, config, full inputs, batches calibration: the record's judge metrics are not the ones the validation runs and the calibration labels give/);
  assert.match(v.errors(v.text.replace(/^(- qgs-B claude claude-sonnet-5-5, product, .*label agreement problems )(\d+)\//m, (_, head, n) => `${head}${Number(n) - 1}/`)),
    /qgs-B claude claude-sonnet-5-5, product, thin inputs, batches calibration: the record's judge metrics are not/);
  assert.match(v.errors(v.text.replace(/^(- reader claude claude-opus-5-5, config, .*runs differ on )0 /m, "$11 ")), /reader claude claude-opus-5-5, config, thin inputs, batches calibration: the record's judge metrics/);
  const metrics = /the record's judge metrics are not the ones the validation runs and the calibration labels give/;
  for (const [name, pattern, replacement] of [
    ["R7", /^(- qgs-A claude claude-opus-5-5, config, .*?run 1 sensitivity 1\.000 \(95% CI )0\.\d\d-1\.00/m, "$10.99-1.00"],
    ["R12", /^(- screening-A claude claude-opus-5-5, config, .*?Relevance \d+\/60 \(95% CI )0\.\d\d-0\.\d\d/m, "$10.99-1.00"],
    ["R13", /^(- qgs-A claude claude-opus-5-5, config, .*?problems (\d+)\/\2 \(95% CI )0\.\d\d-1\.00/m, "$10.10-1.00"],
  ]) {
    const body = v.text.replace(pattern, replacement);
    assert.notEqual(body, v.text, name);
    assert.match(v.errors(body), metrics, name);
  }
  const w = sweep();
  const sessions = w.json("meta.json");
  sessions.sessions["product-B"].model = "claude-haiku-5-5";
  w.write("meta.json", sessions);
  assert.match(w.errors(), /product-B did not run the validated screening-B claude-sonnet-5-5 on the full inputs it was validated on/);
});

test("every judge validation run must be the roster model for its role, in the renderer and in the gate", () => {
  const screeningA = ["config", "product"].flatMap((s) => [1, 2].map((n) => `judge-${s}-screening-A-claude-opus-5-5-run${n}`));
  const probes = [
    [["judge-config-screening-A-claude-opus-5-5-run1"], { model: "claude-haiku-4-5" }],
    [["judge-config-screening-B-claude-sonnet-5-5-run2"], { model: "claude-haiku-4-5" }],
    [["judge-product-qgs-A-claude-opus-5-5-run1"], { cli: "agy" }],
    [["judge-config-reader-claude-opus-5-5-run2"], { model: undefined }],
    [screeningA, { model: "claude-haiku-4-5" }],
  ];
  for (const [keys, change] of probes) {
    const s = sweep();
    const meta = s.json("meta.json");
    for (const key of keys) Object.assign(meta.sessions[key], change);
    s.write("meta.json", meta);
    const errors = s.errors();
    assert.match(errors, new RegExp(`^the record renderer refused the sweep files: prior-art-sweep-record: ${keys[0]}: the run was \\S+ \\S+, not the roster's \\S+ \\S+ it validates`, "m"), keys[0]);
    for (const key of keys) assert.match(errors, new RegExp(`^${key}: the run was \\S+ \\S+, not the roster's \\S+ \\S+ it validates; a validation run counts only for its own judge$`, "m"), key);
  }
});

test("item 9: a cross-family row joined by another id, or an audit run before stage 2 ended, fails the gate", () => {
  const s = sweep();
  const cross = s.jsonl("qgs-cross-gemini-3.8-flash-high.jsonl");
  const candidates = s.jsonl("qgs-candidates.jsonl");
  const other = candidates.find((c) => c.repo !== cross[0].repo);
  s.writeRows("qgs-cross-gemini-3.8-flash-high.jsonl", [{ ...cross[0], id: other.id }, ...cross.slice(1)]);
  assert.match(s.errors(), /row id \d+ names .*, which is candidate \d+; the join is by repository name and the two disagree/);
  s.writeRows("qgs-cross-gemini-3.8-flash-high.jsonl", [{ ...cross[0], repo: "o/elsewhere" }, ...cross.slice(1)]);
  assert.match(s.errors(), /names o\/elsewhere, which is not a candidate; the cross-family judgments join by repository name/);
  const t = sweep();
  const meta = t.json("meta.json");
  meta.sessions["config-audit-gemini-3.8-flash-high"].blocks[0].date = "2026-10-19";
  t.write("meta.json", meta);
  assert.match(t.errors(), /config: the cross-family audit ran before stage 2 ended on 2026-10-20; the audit sample is drawn after stage 2 ends/);
});

test("item 10: a drop without its reason or copy, or a block removed by hand, fails the gate", () => {
  const s = sweep();
  const meta = s.json("meta.json");
  assert.equal(meta.drops.length, 1);
  meta.drops[0].reason = "";
  s.write("meta.json", meta);
  assert.match(s.errors(), /a drop of qgs-judge-B ranks 1,5 records no reason/);
  const t = sweep();
  const hand = t.json("meta.json");
  hand.drops[0].copy = "dropped/missing-copy";
  hand.sessions["judge-config-reader-claude-opus-5-5-run1"].blocks.pop();
  t.write("meta.json", hand);
  const errors = t.errors();
  assert.match(errors, /the drop of qgs-judge-B ranks 1,5 has no copy of its block in the sweep folder/);
  assert.match(errors, /judge-config-reader-claude-opus-5-5-run1\.jsonl holds rows .* that no recorded block covers; drop or rerun a block with the redo tools/);
});

test("every recorded session has its output file and every run file its session, so a completed cross-family audit never reads as pending or absent", () => {
  const unrecorded = /^meta\.json records sessions .* whose output files are not in the sweep folder; /;
  const foreign = /^the sweep folder holds cross-family runs of gemini-3\.8-flash-high, but the topic's cross_family is (none|gemini-9-pro); /;
  const probes = [
    ["AS2 audit rows deleted", built, (s) => rmSync(join(s.folder, "product-audit-gemini-3.8-flash-high.jsonl")), unrecorded],
    ["a judge validation run deleted", built, (s) => rmSync(join(s.folder, "judge-config-qgs-A-claude-opus-5-5-run1.jsonl")), unrecorded],
    ["a stage-1 pool run deleted", built, (s) => rmSync(join(s.folder, "stage1-config-brief-claude-sonnet-5-5.jsonl")), unrecorded, /prior-art-sweep-record: config: stage 1 has not screened ranks /],
    ["AS1 audit sample deleted", built, (s) => rmSync(join(s.folder, "audit-sample.json")), /^meta\.json records the cross-family audit sessions .*, but the sweep folder has no audit-sample\.json they screened$/],
    ["C7 cross_family removed", built, (s) => s.topic(({ cross_family: _, ...t }) => t), foreign],
    ["M7d cross_family renamed", built, (s) => s.topic((t) => ({ ...t, cross_family: { ...t.cross_family, model: "gemini-9-pro" } })), foreign],
    ["C7' cross_family removed, audit pending", pending, (s) => s.topic(({ cross_family: _, ...t }) => t), foreign],
    ["C7'' cross_family removed, escalated", escalated, (s) => s.topic(({ cross_family: _, ...t }) => t), foreign],
  ];
  for (const [name, source, edit, message, python] of probes) {
    const s = sweep(source);
    edit(s);
    failsBothLayers(s, python ?? new RegExp(`prior-art-sweep-record: ${message.source.slice(1)}`), message, name);
  }
  const t = sweep();
  writeFileSync(join(t.folder, "judge-config-qgs-A-claude-haiku-4-5-run1.jsonl"), "");
  assert.match(t.errors(), /^judge-config-qgs-A-claude-haiku-4-5-run1\.jsonl has no session in meta\.json: its rows count only when a recorded run produced them$/m);
  assert.match(t.errors(), /^the record renderer refused the sweep files: prior-art-sweep-record: judge-config-qgs-A-claude-haiku-4-5-run1\.jsonl has no session in meta\.json: /m);
});

test("the snowball rows equal the pool's snowballed rows and the stage-1 inputs, once each", () => {
  const snowball = /^snowball-screening-order\.jsonl holds (33 rows \(33|35 rows \(34|0 rows \(0) distinct\), but the config pool holds 34 and the stage-1 inputs 34 snowballed rows above rank 1000; /;
  const probes = [
    ["a row deleted", (s) => s.writeRows("snowball-screening-order.jsonl", s.jsonl("snowball-screening-order.jsonl").filter((_, i) => i !== 4))],
    ["a row duplicated", (s) => { const rows = s.jsonl("snowball-screening-order.jsonl"); s.writeRows("snowball-screening-order.jsonl", [...rows, rows[0]]); }],
    ["the file deleted", (s) => rmSync(join(s.folder, "snowball-screening-order.jsonl"))],
  ];
  for (const [name, edit] of probes) {
    const s = sweep();
    assert.equal(s.jsonl("snowball-screening-order.jsonl").length, 34);
    edit(s);
    failsBothLayers(s, new RegExp(`prior-art-sweep-record: ${snowball.source.slice(1)}`), snowball, name);
  }
});

test("a topic flag never drops the config-pool channel line while its evidence files exist", () => {
  const flag = /^the sweep folder holds the config-pool channel's evidence \(config-pool-channel\.json or product rows credited with config-pool\), but the topic config does not set strata\.product\.channels\.config_pool; /;
  const product = (edit) => (t) => ({ ...t, strata: { ...t.strata, product: { ...t.strata.product, channels: edit(t.strata.product.channels) } } });
  const probes = [
    ["C8 config_pool false", built, product((c) => ({ ...c, config_pool: false }))],
    ["config_pool deleted", built, product(({ config_pool: _, ...c }) => c)],
    ["channels emptied", built, product(() => ({}))],
    ["config_pool false, escalated", escalated, product((c) => ({ ...c, config_pool: false }))],
    ["config_pool false, audit pending", pending, product((c) => ({ ...c, config_pool: false }))],
  ];
  for (const [name, source, edit] of probes) {
    const s = sweep(source);
    s.topic(edit);
    failsBothLayers(s, new RegExp(`prior-art-sweep-record: ${flag.source.slice(1)}`), flag, name);
  }
});

test("meta.drops matches the copies under dropped/ in both directions", () => {
  const s = sweep();
  s.write("meta.json", { ...s.json("meta.json"), drops: [] });
  assert.match(s.errors(), /^the record renderer refused the sweep files: prior-art-sweep-record: dropped\/qgs-judge-B-1-5-1: a dropped copy without its meta\.json drops entry; /m);
  assert.match(s.errors(), /^dropped\/qgs-judge-B-1-5-1: a dropped copy without its meta\.json drops entry; /m);
  const t = sweep();
  writeFileSync(join(t.folder, "dropped", "qgs-judge-A-1-5-1.rows.jsonl"), "");
  assert.match(t.errors(), /^the record renderer refused the sweep files: prior-art-sweep-record: dropped\/qgs-judge-A-1-5-1: a dropped copy without its meta\.json drops entry; /m);
  assert.match(t.errors(), /^dropped\/qgs-judge-A-1-5-1: a dropped copy without its meta\.json drops entry; /m);
  const u = sweep();
  rmSync(join(u.folder, "dropped", "qgs-judge-B-1-5-1.block.json"));
  const errors = u.errors();
  assert.match(errors, /^the record renderer refused the sweep files: prior-art-sweep-record: the drop of qgs-judge-B ranks \[1, 5\] has no copy of its block in the sweep folder/m);
  assert.match(errors, /^the drop of qgs-judge-B ranks 1,5 has no copy of its block in the sweep folder$/m);
});

test("item 11: PRISMA and recall are recomputed from the files, so an edited count fails the gate", () => {
  const s = sweep();
  assert.match(s.errors(s.text.replace("| config | stage-1 screened | 133 |", "| config | stage-1 screened | 132 |")), /PRISMA config "stage-1 screened": the record says 132, the files give 133/);
  assert.match(s.errors(s.text.replace("| product | identified: config-pool | 23 |", "")), /PRISMA product "identified: config-pool": the record says nothing, the files give 23/);
  assert.match(s.errors(s.text.replace(/^- pooled topic recall \d+\//m, "- pooled topic recall 1/")), /pooled topic recall: the record says 1\/47, in-pool .*, the files give \d+\/47/);
  assert.match(s.errors(s.text.replace("in-pool rate 46/47", "in-pool rate 47/47")), /pooled topic recall: the record says 38\/47, in-pool 47\/47, stage-1 pass 46\/46, the files give 38\/47, in-pool 46\/47/);
  assert.match(s.errors(s.text.replace(/^- facet beta: recall \d+\//m, "- facet beta: recall 1/")), /facet beta recall: the record says 1\/\d+ \(in-pool and stage-1 pass rates included\), the files give/);
  assert.match(s.errors(s.text.replace(/^(- facet alpha: .*?; stage-1 pass rate )\d+\//m, "$10/")), /facet alpha recall: the record says 20\/26 \(in-pool and stage-1 pass rates included\)/);
  const q = sweep();
  const extra = Array.from({ length: 40 }, (_, i) => ({ id: 9000 + i, repo: `x/absent${i}` }));
  q.writeRows("qgs-candidates.jsonl", [...q.jsonl("qgs-candidates.jsonl"), ...extra]);
  for (const side of ["A", "B"]) q.writeRows(`qgs-judge-${side}.jsonl`, [...q.jsonl(`qgs-judge-${side}.jsonl`), ...extra.map((c) => ({ ...c, verdict: "yes", problems: ["X1"], strata: ["config"], why: "w" }))]);
  assert.match(q.errors(), /pooled topic recall is below the target and the record does not name the recall target threat with the losses the files give/);
  const plan = s.json("config-stage2.json");
  const excluded = s.jsonl("stage1-config-brief-claude-sonnet-5-5.jsonl").find((r) => r.verdict === "no").order_rank;
  s.write("config-stage2.json", { ...plan, passes: [...plan.passes, excluded] });
  assert.match(s.errors(), /config-stage2\.json does not list the stage-1 passes the stage-1 files give/);
});

test("PRISMA stage-2 decisions, the per-row decisions and the facet inclusion are recomputed from the screening files", () => {
  const s = sweep();
  const counts = Object.fromEntries([...s.text.matchAll(/^\| config \| stage 2: ([^|]+?) \| (\d+) \|$/gm)].map((m) => [m[1], m[2]]));
  const [first, second] = Object.keys(counts);
  assert.ok(first && second && counts[first] !== counts[second]);
  const swapped = s.text.replace(`| config | stage 2: ${first} | ${counts[first]} |`, `| config | stage 2: ${first} | ${counts[second]} |`)
    .replace(`| config | stage 2: ${second} | ${counts[second]} |`, `| config | stage 2: ${second} | ${counts[first]} |`);
  assert.match(s.errors(swapped), /PRISMA config stage 2: the record says/);
  const facet = s.text.match(/^- product: (\d+) repositories included once each;.*$/m);
  assert.match(s.errors(s.text.replace(facet[0], facet[0].replace(/counted per facet alpha (\d+)/, (_, n) => `counted per facet alpha ${Number(n) + 1}`))),
    /product: the record's facet line is not the inclusion the files give/);
  const row = s.text.match(/^\| (\d+) \| o\/\S+ \| [^|]+ \| [^|]+ \| eligible \| .*$/m);
  assert.match(s.errors(s.text.replace(row[0], row[0].replace("| eligible |", "| excluded: irrelevant |"))),
    new RegExp(`config: the record's stage-2 rows ${row[1]} do not hold the commit, scores, decision, reason and facets the screening files give`));
  const t = sweep();
  const b = t.jsonl("config-screen-B.jsonl");
  const eligible = b.find((r) => r.decision === "eligible");
  t.writeRows("config-screen-B.jsonl", b.map((r) => (r === eligible ? { ...r, mechanisms: [], decision: "excluded: irrelevant" } : r)));
  assert.match(t.errors(), new RegExp(`config: stage-2 rank ${eligible.order_rank} needs an adjudication row in config-adjudication\\.json: one session says eligible`));
  const u = sweep();
  u.write("study.json", { ...u.json("study.json"), study: { [eligible.repo]: "kept for study" } });
  assert.match(u.errors(), /PRISMA config stage 2: the record says/);
  assert.match(s.text, /^- config: .*; facets come from the problem ids the stage-2 sessions name, at least one per included row$/m);
  const v = sweep();
  for (const side of ["A", "B"]) v.writeRows(`config-screen-${side}.jsonl`, v.jsonl(`config-screen-${side}.jsonl`).map((r) => (r.order_rank === eligible.order_rank ? { ...r, problems: [] } : r)));
  assert.match(v.errors(), new RegExp(`config: included rank ${eligible.order_rank} names no registry problem at stage 2; eligibility means addressing a registry problem`));
  const w = sweep();
  for (const side of ["A", "B"]) {
    w.writeRows(`config-screen-${side}.jsonl`, w.jsonl(`config-screen-${side}.jsonl`).map((r) => (r.order_rank === eligible.order_rank ? { ...r, problems: ["X3"] } : r)));
  }
  assert.match(w.errors(), new RegExp(`config: the record's stage-2 rows ${eligible.order_rank} do not hold the commit, scores, decision, reason and facets`));
});

test("the config-pool channel must have run on the final config pool, and its recover and outside counts are recomputed", () => {
  const s = sweep();
  const line = s.text.match(/^- product channel from the config pool: .*$/m)[0];
  assert.match(s.errors(s.text.replace(line, line.replace(/they recover (\d+)/, (_, n) => `they recover ${Number(n) + 7}`))), /the record's config-pool channel line is not the one the files give/);
  assert.match(s.errors(s.text.replace(line, line.replace(/; (\d+) of those members remain/, "; 0 of those members remain"))), /the record's config-pool channel line is not the one the files give/);
  assert.match(s.errors(s.text.replace("are in no pool: o/outside1", "are in no pool: o/elsewhere")), /the record's discovery gap does not name the 1 product members the files leave outside every pool/);
  const t = sweep();
  const channel = t.json("config-pool-channel.json");
  t.write("config-pool-channel.json", { ...channel, joined: [] });
  const empty = t.text.replace(line, line.replace(/: \d+ repositories joined/, ": 0 repositories joined").replace(/they recover \d+/, "they recover 0"));
  const errors = t.errors(empty);
  assert.match(errors, /the config-pool channel did not run on the final config pool: .* pass the product filter but did not join the product pool before stage 1/);
  assert.match(errors, /product-screening-order\.jsonl credits the config-pool channel with .*, which config-pool-channel\.json does not list/);
});

test("the config-pool joined count counts only repositories that stay in the product pool after aggregator removal, as the PRISMA config-pool line does", () => {
  const s = sweep();
  const joined = s.json("config-pool-channel.json").joined.map((r) => r.toLowerCase());
  const credited = s.jsonl("product-screening-order.jsonl").filter((r) => r.channels?.includes("config-pool")).map((r) => r.repo.toLowerCase());
  assert.deepEqual(joined.filter((r) => !credited.includes(r)), ["l/awesome-claude"]);
  assert.match(s.text, /^\| product \| identified: config-pool \| 23 \|$/m);
  const line = s.text.match(/^- product channel from the config pool: .*$/m)[0];
  assert.match(line, /: 23 repositories joined the product pool before stage 1;/);
  const errors = s.errors(s.text.replace(line, line.replace(": 23 repositories joined", ": 24 repositories joined")));
  assert.match(errors, /^the record is not the one the renderer rebuilds from the sweep files: line \d+ reads "- product channel from the config pool: 24 repositories joined/m);
  assert.match(errors, /^the record's config-pool channel line is not the one the files give \("- product channel from the config pool: 23 repositories joined/m);
});

test("the standard, snowball and calibration batch lines are recomputed from the files", () => {
  const s = sweep();
  assert.match(s.errors(s.text.replace("- standard: 47 members from 67 candidates", "- standard: 47 members from 70 candidates")), /the record's standard line is not the one the QGS files give/);
  assert.match(s.errors(s.text.replace("reader queue 1 disputed or unsure", "reader queue 0 disputed or unsure")), /the record's standard line is not the one the QGS files give/);
  assert.match(s.errors(s.text.replace("- snowball: 34 repositories", "- snowball: 40 repositories")), /the record's snowball line does not state the 34 snowballed repositories/);
  assert.match(s.errors(s.text.replace("the user labelled 31 eligible", "the user labelled 45 eligible")), /the record's calibration config batch line is not the one the label and draw files give/);
  assert.match(s.errors(s.text.replace("drawn per facet alpha 30, beta 30; likely positives 30; the user labelled 35", "drawn per facet alpha 40, beta 20; likely positives 30; the user labelled 35")),
    /the record's calibration product batch line is not the one/);
  assert.match(s.errors(s.text.replace("batches the rung was chosen on: 66", "batches the rung was chosen on: 90")), /the record's pooled positives are not the 66 the label files give/);
});

test("the cross-family audit sample is redrawn and the cross-family and QGS judge lines are recomputed", () => {
  const s = sweep();
  const sample = s.json("audit-sample.json");
  const pilot = Math.min(...s.jsonl("config-screen-A.jsonl").map((r) => r.order_rank));
  s.write("audit-sample.json", { ...sample, config: [...sample.config.slice(1), pilot].sort((a, b) => a - b) });
  assert.match(s.errors(), /config: audit-sample\.json is not the sample the stage-2 files give: the 20 rows both sessions screened after the pilot with the lowest sha256/);
  const t = sweep();
  assert.match(t.errors(t.text.replace("eligibility agreement with A 20/20 (kappa 1.000)", "eligibility agreement with A 20/20 (kappa 0.900)")),
    /config: the record's cross-family audit line is not the agreement the audit and screening files give/);
  assert.match(t.errors(t.text.replace("agreement with qgs-A 11/12", "agreement with qgs-A 12/12")), /the record's cross-family QGS line is not the agreement the QGS judge files give/);
  assert.match(t.errors(t.text.replace("(kappa 0.571)", "(kappa 0.900)")), /the record's cross-family QGS line is not the agreement/);
  assert.match(t.errors(t.text.replace("- QGS qgs-B: claude-sonnet-5-5 judged 66 candidates", "- QGS qgs-B: claude-sonnet-5-5 judged 70 candidates")),
    /the record's QGS qgs-B line is not the one qgs-judge-B\.jsonl gives/);
});

test("every figure in the stop, agreement, row, ladder, facet and drop lines is recomputed from the files", () => {
  const s = sweep();
  const probes = [
    [/(stopped at pooled depth 42 \(limit 150\); .*pooled recall at the stop 38\/47 \()0\.809/, "$10.900", /config: the record's stage-2 stop line is not the whole stop the plan gives/],
    [/^(- config: post-freeze rows \d+ .*?: )(\d+)\//m, (_, h, n) => `${h}${Number(n) - 1}/`, /config: the record's session agreement lines are not the ones the screening files give/],
    [/^(- product kappa: Authority )1\.000/m, "$10.500", /product: the record's session agreement lines are not/],
    [/^(- config capture-recapture .*?: A )(\d+)/m, (_, h, n) => `${h}${Number(n) + 2}`, /config: the record's session agreement lines are not/],
    [/^(\| 1 \| o\/a1 \| [^|]+ \| )A1 M1/m, "$1A0 M1", /config: the record's stage-2 rows 1 do not hold the commit, scores/],
    [/^(\| 1 \| o\/a1 \| [^|]+ \| [^|]+ \| eligible \| [^|]+ \| )both sessions eligible/m, "$1adjudicated", /config: the record's stage-2 rows 1 do not hold/],
    [/^(Screened beyond the stop or outside both sessions: )0 rows/m, "$15 rows", /config: the record does not state the 0 rows screened beyond the stop/],
    [/^- stage 2 stopped before every stage-1 pass: config screened 22 of 98 passes$/m, "- stage 2 stopped before every stage-1 pass: config screened 98 of 98 passes",
      /config: the record's stage-2 stop threat is not the one the plan gives \(22 of 98 passes screened\)/],
    [/rung 2 claude-opus-5-5 \+ claude-sonnet-5-5 on brief/, "rung 2 claude-opus-5-5 on brief", /the record's ladder line is not the one stage1-freeze\.json gives/],
    [/^- alpha: problems X1, X2;/m, "- alpha: problems X1;", /the record's facet alpha line is not the topic config's/],
    [/dropped 63 o\/missing7 \(the repository is gone/, "dropped 63 o/missing7 (it moved", /the record's standard line is not the one the QGS files give/],
    [/(- facet alpha: recall 20\/26 \()0\.769/, "$10.900", /the record's facet alpha recall line is not the one the files give/],
    [/(in-pool rate 46\/47 \(0\.979, 95% CI )0\.89/, "$10.50", /the record's pooled recall line is not the one the files give/],
  ];
  for (const [pattern, replacement, error] of probes) {
    const body = s.text.replace(pattern, replacement);
    assert.notEqual(body, s.text, String(pattern));
    assert.match(s.errors(body), error);
  }
});

test("stage 1 and stage 2 are checked against the files: unscreened pool rows and stage-2 rows that passed no model fail", () => {
  const s = sweep();
  const rows = s.jsonl("stage1-product-brief-claude-sonnet-5-5.jsonl");
  s.writeRows("stage1-product-brief-claude-sonnet-5-5.jsonl", rows.slice(1));
  assert.match(s.errors(), new RegExp(`product: stage 1 has not screened ranks ${rows[0].order_rank}`));
  const t = sweep();
  const excluded = t.jsonl("stage1-config-brief-claude-sonnet-5-5.jsonl").find((r) => r.verdict === "no");
  const a = t.jsonl("config-screen-A.jsonl");
  t.writeRows("config-screen-A.jsonl", [...a, { ...a[0], order_rank: excluded.order_rank, repo: excluded.repo }]);
  assert.match(t.errors(), new RegExp(`config: stage 2 screened ranks ${excluded.order_rank} that passed no stage-1 model`));
  const u = sweep();
  u.writeRows("snowball-screening-order.jsonl", [{ order_rank: 1001, repo: "s/elsewhere" }]);
  assert.match(u.errors(), /snowballed repositories s\/elsewhere are not in the config stage-1 pool/);
  const n4 = sweep();
  rmSync(join(n4.folder, "snowball-cut.json"));
  assert.match(n4.errors(), /no snowball-cut\.json in the sweep folder; under quality criteria v4 snowball-above-cut\.py --all records cut_row null/);
  const malformed = sweep();
  const screened = malformed.jsonl("config-screen-A.jsonl");
  delete screened[0].scores.Position;
  malformed.writeRows("config-screen-A.jsonl", screened);
  const lacks = `config rank ${screened[0].order_rank} (session A) lacks the judged score Position`;
  assert.equal(malformed.errors(), `the record renderer refused the sweep files: prior-art-sweep-record: ${lacks}\n${lacks}`);
  const v = sweep();
  v.write("snowball-cut.json", { ...v.json("snowball-cut.json"), cut_row: 200 });
  assert.match(v.errors(), /snowball-cut\.json cuts the snowball at row 200; quality criteria v4 refuses a snowball cut/);
});

test("the pooled stage-2 plan and its stop line are recomputed from the files, so a hand-edited stop fails the gate", () => {
  const s = sweep();
  const plan = s.json("config-stage2.json");
  s.write("config-stage2.json", { ...plan, stop: null, limit: 1 });
  assert.match(s.errors(), /the stage-2 plans hold different limits 1, 150; plan-stage2\.py plans every stratum together/);
  const t = sweep();
  for (const stratum of ["config", "product"]) t.write(`${stratum}-stage2.json`, { ...t.json(`${stratum}-stage2.json`), stop: null, limit: null });
  assert.match(t.errors(), /config-stage2\.json is not the pooled plan the stage-1 files, the facet rankings and the QGS standard give/);
  const u = sweep();
  const product = u.json("product-stage2.json");
  u.write("product-stage2.json", { ...product, stop: { ...product.stop, found: 40 } });
  assert.match(u.errors(), /product-stage2\.json is not the pooled plan/);
  const v = sweep();
  assert.match(v.errors(v.text.replace("stopped at pooled depth 42 (limit 150)", "stopped at pooled depth 40 (limit 150)")),
    /config: the record's stage-2 stop line is not the plan the files give \("stopped at pooled depth 42 \(limit 150\); this stratum screens 22 of its 98 passes; pooled recall at the stop 38\/47"\)/);
});

test("a later calibration batch counts only when its trigger held at the draw, so an untriggered top-up fails the renderer and the gate", () => {
  const s = sweep();
  const labels = createHash("sha256").update(readFileSync(join(s.folder, "calibration-labels.json"))).digest("hex");
  s.write("top-up-set.json", {
    sweep: SWEEP, batch: "top-up", purpose: "fewer than 59 positives pooled (41): the rows join the pooled bound",
    rows_per_stratum: { config: 15, product: 15 }, rows: [], trigger: { positives: 41, labels_sha256: { calibration: labels } },
  });
  const errors = s.errors();
  assert.match(errors, /^the record renderer refused the sweep files: /m);
  assert.match(errors, /^top-up-set\.json was drawn when no trigger held, or records another trigger than the labelled batches before it give; /m);
  const held = sweep(escalated);
  assert.equal(held.errors(), "");
  const set = held.json("held-out-set.json");
  assert.deepEqual(Object.keys(set.trigger.labels_sha256), ["calibration"]);
  held.write("held-out-set.json", `${JSON.stringify({ ...set, trigger: { ...set.trigger, rung: 3 } }, null, 1)}\n`);
  assert.match(held.errors(), /^held-out-set\.json was drawn when no trigger held, or records another trigger than the labelled batches before it give; /m);
});

test("H-calibration: the gate redraws every calibration batch, binds the labels to its rows and keeps worked examples out", () => {
  const redrawn = /calibration-set\.json is not the set its seed, the pools and the recorded unreadable rows give/;
  const s = sweep();
  const labels = s.json("calibration-labels.json");
  const dropped = labels.rows.find((r) => r.user.decision === "eligible" && r.stratum === "config");
  s.write("calibration-labels.json", { ...labels, rows: labels.rows.filter((r) => r !== dropped), complete: labels.complete - 1 });
  for (const run of [1, 2]) {
    const key = `judge-config-stage1-brief-claude-sonnet-5-5-run${run}`;
    s.writeRows(`${key}.jsonl`, s.jsonl(`${key}.jsonl`).filter((r) => r.order_rank !== dropped.order_rank));
  }
  assert.match(s.errors(), /calibration-labels\.json does not hold exactly the rows of calibration-set\.json/);
  const t = sweep();
  const sample = t.json("calibration-set.json");
  const drawn = new Set(sample.rows.filter((r) => r.stratum === "config").map((r) => r.order_rank));
  const other = t.jsonl("config-screening-order.jsonl").find((r) => !drawn.has(r.order_rank));
  const first = sample.rows.findIndex((r) => r.stratum === "config");
  sample.rows[first] = { ...sample.rows[first], order_rank: other.order_rank, repo: other.repo };
  const text = `${JSON.stringify(sample, null, 1)}\n`;
  t.write("calibration-set.json", text);
  const sha = createHash("sha256").update(text).digest("hex");
  const rewritten = t.json("calibration-labels.json");
  rewritten.rows[first] = { ...rewritten.rows[first], order_rank: other.order_rank, repo: other.repo };
  t.write("calibration-labels.json", { ...rewritten, set_sha256: sha });
  t.write("calibration-draw.json", { ...t.json("calibration-draw.json"), set_sha256: sha });
  assert.match(t.errors(), redrawn);
  const u = sweep();
  u.write("calibration-draw.json", { ...u.json("calibration-draw.json"), set_sha256: "0".repeat(64) });
  assert.match(u.errors(), /calibration-draw\.json was written for another calibration set/);
  const v = sweep();
  const small = { ...v.json("calibration-set.json"), rows_per_stratum: { config: 59, product: 60 } };
  const smallText = `${JSON.stringify(small, null, 1)}\n`;
  v.write("calibration-set.json", smallText);
  const smallSha = createHash("sha256").update(smallText).digest("hex");
  for (const name of ["calibration-labels.json", "calibration-draw.json"]) v.write(name, { ...v.json(name), set_sha256: smallSha });
  assert.match(v.errors(), /calibration-set\.json holds \{"config":59,"product":60\} rows per stratum; the calibration set holds 60 per stratum/);
  const w = sweep();
  const path = join(w.repo, "docs", "prior-art", "topics", "demo.json");
  const topic = JSON.parse(readFileSync(path, "utf8"));
  const inSet = w.json("calibration-set.json").rows[0].repo;
  writeFileSync(path, JSON.stringify({ ...topic, stage1_examples: topic.stage1_examples.map((e, i) => (i ? e : { ...e, repo: inSet })) }));
  const errors = w.errors();
  assert.match(errors, /stage1-freeze\.json froze other worked examples than the topic config's stage1_examples hold now/);
  assert.match(errors, new RegExp(`calibration-set\\.json holds stage-1 worked-example repositories ${inSet}`));
  writeFileSync(path, JSON.stringify({ ...topic, stage1_examples: topic.stage1_examples.map((e) => ({ ...e, why: "rewritten after the freeze" })) }));
  assert.match(w.errors(), /stage1-freeze\.json froze other worked examples than the topic config's stage1_examples hold now/);
  const x = sweep(escalated);
  x.write("stage1-rung.json", { ...x.json("stage1-rung.json"), date: "2026-10-21" });
  assert.match(x.errors(), /held-out-set\.json was not drawn after the current stage1-rung\.json/);
});

test("H-audit-reading: the stage-1 audit reading counts only from the screener on the frozen packet, full shape and the rows it was given", () => {
  const key = "config-stage1-audit-claude-opus-5-5";
  const reading = new RegExp(`${key}: the stage-1 audit reading is not the stage-2 screener claude-opus-5-5 on the full inputs under the frozen packet and criteria`);
  const probe = (edit) => {
    const s = sweep();
    const meta = s.json("meta.json");
    edit(meta.sessions[key]);
    s.write("meta.json", meta);
    return s.errors();
  };
  assert.match(probe((e) => Object.assign(e, { model: "gemini-3.8-flash-high", cli: "agy" })), reading);
  assert.match(probe((e) => Object.assign(e.blocks[0], { packet_sha256: "0".repeat(64), criteria_sha256: "0".repeat(64), shape: "thin" })), reading);
  assert.match(probe((e) => { delete e.blocks[0].row_sha256[String(e.blocks[0].ranks[0])]; }), reading);
  const s = sweep();
  const calibration = new Set(s.json("calibration-set.json").rows.filter((r) => r.stratum === "config").map((r) => String(r.order_rank)));
  assert.match(probe((e) => {
    const shared = Object.keys(e.blocks[0].row_sha256).find((r) => calibration.has(r));
    e.blocks[0].row_sha256[shared] = "a".repeat(64);
  }), new RegExp(`${key}: ranks \\d+ were read on other inputs than the calibration rows of the same ranks hold`));
});

test("H-cross-audit: the audit is the topic's non-Claude cross_family model, or the record states it pending", () => {
  const state = /config: the record's cross-family audit state is not the one the audit files give/;
  const x3 = sweep();
  const meta = x3.json("meta.json");
  Object.assign(meta.sessions["config-audit-gemini-3.8-flash-high"], { cli: "claude", model: "claude-opus-5-5" });
  x3.write("meta.json", meta);
  assert.match(x3.errors(), /config-audit-gemini-3\.8-flash-high: the audit session ran claude claude-opus-5-5, not the topic's cross_family agy gemini-3\.8-flash-high/);
  const x2 = sweep();
  rmSync(join(x2.folder, "audit-sample.json"));
  assert.match(x2.errors(), state);
  const z2 = sweep();
  rmSync(join(z2.folder, "audit-sample.json"));
  for (const stratum of ["config", "product"]) rmSync(join(z2.folder, `${stratum}-audit-gemini-3.8-flash-high.jsonl`));
  const trimmed = z2.text.split("\n").filter((l) => !/^- (config|product) audit: /.test(l)).join("\n");
  const sessions = z2.json("meta.json");
  for (const stratum of ["config", "product"]) delete sessions.sessions[`${stratum}-audit-gemini-3.8-flash-high`];
  z2.write("meta.json", sessions);
  assert.match(z2.errors(trimmed), state);
  const z3 = sweep(pending);
  assert.equal(z3.errors(), "");
  assert.match(z3.errors(z3.text.split("\n").filter((l) => !l.startsWith("- cross-family audit pending: config")).join("\n")), state);
  const claude = sweep();
  const path = join(claude.repo, "docs", "prior-art", "topics", "demo.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), cross_family: { cli: "claude", model: "claude-haiku-5-5" } }));
  assert.match(claude.errors(), /the cross_family model claude-haiku-5-5 is a Claude model; the audit needs a model outside the Claude family/);
});

test("every session names the roster cli as well as the model: production QGS, stage-1 validation and pool runs, and the screening sessions", () => {
  const probes = [
    ["qgs-judge-A", /qgs-judge-A\.jsonl: its .*judgments .*not all claude claude-opus-5-5 runs/],
    ["judge-config-stage1-brief-claude-sonnet-5-5-run2", /judge-config-stage1-brief-claude-sonnet-5-5-run2\.jsonl has no claude claude-sonnet-5-5 session in meta\.json/],
    ["stage1-config-brief-claude-sonnet-5-5", /stage1-config-brief-claude-sonnet-5-5(\.jsonl has no claude claude-sonnet-5-5 session|: the stage-1 pool run is not claude claude-sonnet-5-5)/],
    ["config-A", /config-A (did not run the validated screening-A claude claude-opus-5-5|ran claudex claude-opus-5-5)/],
  ];
  for (const [key, message] of probes) {
    const s = sweep();
    const meta = s.json("meta.json");
    meta.sessions[key].cli = "claudex";
    s.write("meta.json", meta);
    failsBothLayers(s, message, message, key);
  }
});

test("the cross-family QGS judgments carry provenance: a recorded run of the topic's cross_family on the thin inputs under the QGS packet", () => {
  const key = "qgs-cross-gemini-3.8-flash-high";
  const entry = sweep().json("meta.json").sessions[key];
  assert.deepEqual([entry?.cli, entry?.model, entry?.blocks?.[0]?.shape], ["agy", "gemini-3.8-flash-high", "thin"]);
  const outside = /^qgs-cross-gemini-3\.8-flash-high\.jsonl: its judgments are not all agy gemini-3\.8-flash-high runs on the thin inputs under qgs-packet\.md, covering exactly its rows$/;
  const block = (edit) => (s) => { const meta = s.json("meta.json"); edit(meta.sessions[key].blocks[0]); s.write("meta.json", meta); };
  const probes = [
    ["QX1 file deleted", (s) => rmSync(join(s.folder, `${key}.jsonl`)), /^meta\.json records sessions qgs-cross-gemini-3\.8-flash-high whose output files are not in the sweep folder; /],
    ["session deleted", (s) => { const meta = s.json("meta.json"); delete meta.sessions[key]; s.write("meta.json", meta); }, /^qgs-cross-gemini-3\.8-flash-high\.jsonl has no session in meta\.json: /],
    ["a row deleted", (s) => s.writeRows(`${key}.jsonl`, s.jsonl(`${key}.jsonl`).slice(1)), outside],
    ["packet changed", block((b) => { b.packet_sha256 = "0".repeat(64); }), outside],
    ["shape changed", block((b) => { b.shape = "full"; }), outside],
    ["a row hash changed", block((b) => { b.row_sha256[String(b.ranks[0])] = "0".repeat(64); }), /^the QGS sessions judged candidates \d+ on different thin inputs, /],
  ];
  for (const [name, edit, message] of probes) {
    const s = sweep();
    edit(s);
    failsBothLayers(s, new RegExp(`prior-art-sweep-record: ${message.source.slice(1)}`), message, name);
  }
});

test("held-out labels are bound to the stage-1 pool runs made after them, and every label decision is one the import accepts", () => {
  const bound = /^stage1-(config|product)-brief-claude-(opus|sonnet)-5-5: the stage-1 pool run was not made after the current held-out labels \(held-out-labels\.json\); /;
  const s = sweep(escalated);
  const labels = s.json("held-out-labels.json");
  const row = labels.rows.find((r) => r.user.decision === "eligible");
  row.user = { ...row.user, decision: "excluded: below-threshold" };
  s.write("held-out-labels.json", labels);
  failsBothLayers(s, new RegExp(`prior-art-sweep-record: ${bound.source.slice(1)}`), bound, "L5 held-out positive flipped");
  const t = sweep(escalated);
  const odd = t.json("held-out-labels.json");
  odd.rows[0].user = { ...odd.rows[0].user, decision: "eligiblex" };
  t.write("held-out-labels.json", odd);
  assert.match(t.errors(), new RegExp(`^held-out-labels\\.json row ${odd.rows[0].id} holds the decision "eligiblex", not eligible or excluded: <code>$`, "m"));
});

test("the production QGS sessions record the same thin-input hash for every candidate they share, and one for each candidate they judged", () => {
  const split = /^the QGS sessions judged candidates 1 on different thin inputs, or recorded no input hash for them; every QGS judge reads the same candidate inputs$/;
  const probes = [
    ["qgs-judge-A hash changed", "qgs-judge-A", (h) => { h["1"] = "0".repeat(64); }],
    ["qgs-judge-B hash deleted", "qgs-judge-B", (h) => { delete h["1"]; }],
    ["qgs-reader hash changed", "qgs-reader", (h) => { h["1"] = "f".repeat(64); }],
  ];
  for (const [name, key, edit] of probes) {
    const s = sweep();
    const meta = s.json("meta.json");
    edit(meta.sessions[key].blocks.find((b) => b.ranks.includes(1)).row_sha256);
    s.write("meta.json", meta);
    failsBothLayers(s, new RegExp(`prior-art-sweep-record: ${split.source.slice(1)}`), split, name);
  }
});

test("the agy threat lists every session that ran through agy, whatever the session's threats field holds", () => {
  const s = sweep();
  const meta = s.json("meta.json");
  delete meta.sessions["config-audit-gemini-3.8-flash-high"].threats;
  s.write("meta.json", meta);
  const both = "- agy MCP servers, hooks and user settings not excluded: config-audit-gemini-3.8-flash-high, product-audit-gemini-3.8-flash-high, qgs-cross-gemini-3.8-flash-high ran through agy";
  const text = s.rendered();
  assert.ok(text.includes(both), text.split("\n").find((l) => l.startsWith("- agy")));
  assert.equal(s.errors(text), "");
  const errors = s.errors(text.replace(both, both.replace("config-audit-gemini-3.8-flash-high, ", ""))).split("\n");
  assert.ok(errors.some((l) => l.startsWith("the record renderer refused") || l.startsWith("the record is not the one")));
  assert.ok(errors.some((l) => /threat/.test(l) && !l.startsWith("the record ")), errors.join("\n"));
});

test("the cross-family audit carries the frozen packet and criteria and the row hashes of the rows stage 2 screened", () => {
  const key = "config-audit-gemini-3.8-flash-high";
  const probes = [
    ["packet", (b) => { b.packet_sha256 = "0".repeat(64); }],
    ["criteria", (b) => { b.criteria_sha256 = "0".repeat(64); }],
    ["row hashes emptied", (b) => { b.row_sha256 = {}; }],
    ["a row hash changed", (b) => { b.row_sha256[String(b.ranks[0])] = "0".repeat(64); }],
    ["a rank dropped from the block", (b) => { b.ranks = b.ranks.slice(1); }],
  ];
  for (const [name, edit] of probes) {
    const s = sweep();
    const meta = s.json("meta.json");
    edit(meta.sessions[key].blocks[0]);
    s.write("meta.json", meta);
    const errors = s.errors();
    assert.match(errors, /^the record renderer refused the sweep files: /m, name);
    assert.match(errors, new RegExp(`^${key.replaceAll(".", "\\.")}: the audit blocks do not carry the frozen packet and criteria and the row hashes of exactly the rows stage 2 screened that it read$`, "m"), name);
  }
});

test("H-prose: the Protocol, screening session and threat lines and the four statement lines are rebuilt from meta.json, the freeze and the topic", () => {
  const s = sweep();
  const protocol = /the record's Protocol section is not the one meta\.json and protocol-freeze\.json give/;
  const sessions = /the record's Screening sessions section is not the one meta\.json and protocol-freeze\.json give/;
  const threat = (line) => new RegExp(`the record's Threats section lacks the threat "${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  const sameConfig = s.text.match(/^- same model family: config .*$/m)[0];
  const sameProduct = s.text.match(/^- same model family: product .*$/m)[0];
  const reader = s.text.match(/^- reader shares the QGS judges' model family: .*$/m)[0];
  const probes = [
    ["M1", s.text.replace("- session A: claude claude-opus-5-5;", "- session A: agy gemini-3.8-flash-high;"), protocol],
    ["M2", s.text.replace(/^- config-B: claude claude-sonnet-5-5,/m, "- config-B: agy gemini-3.8-flash-high,"), sessions],
    ["M3", s.text.replace(`${sameProduct}\n`, ""), threat(sameProduct)],
    ["M4", s.text.replace(`${reader}\n`, ""), threat(reader)],
    ["M5", s.text.replace("session B: claude claude-sonnet-5-5,", "session B: agy gemini-3.8-flash-high,").replace(`${sameProduct}\n`, ""), protocol],
    ["M8", s.text.replace(sameConfig, sameConfig.replace("B (claude-sonnet-5-5)", "B (claude-haiku-4)")), threat(sameConfig)],
    ["M9", s.text.replace(/^- isolation: agy --disable-slash-commands/m, "- isolation: agy --bare --disable-slash-commands"), protocol],
    ["M13", s.text.replace(/^(- prompt template sha256 `)[0-9a-f]{8}/m, "$100000000"), protocol],
    ["M14", s.text.replace("- session B pilot, information only: claude-sonnet-5-5", "- session B pilot, information only: claude-haiku-5-5"), protocol],
    ["upper estimate", s.text.replace(/^- QGS recall is an upper estimate: .*\n/m, ""), /the record's Recall section does not state that QGS recall is an upper estimate/],
    ["invented threat", s.text.replace(reader, `${reader}\n- nothing else threatens this sweep`), /the record's Threats section holds a threat the files do not give: "- nothing else threatens this sweep"/],
    ["recall threat when met", s.text.replace(reader, `${reader}\n- recall target not reached: pooled topic recall 1/47; outside every pool 0, excluded by stage 1 0, not screened in stage 2 0`),
      /the record names a recall target threat although pooled topic recall meets the target/],
    ["unreachable when reachable", s.text.replace(reader, `${reader}\n- pooled recall target unreachable at stage 2: 1 of the 47`), /the record names an unreachable pooled recall target the stage-2 plan does not give/],
  ];
  for (const [name, body, error] of probes) {
    assert.notEqual(body, s.text, name);
    assert.match(s.errors(body), error, name);
  }
  const e = sweep(escalated);
  assert.match(e.errors(e.text.replace("; the pooled bound above was measured on the set the rung was chosen on", "; nothing else to say")),
    /the record's held-out confirmation line is not the one the held-out runs give/);
  const m7 = sweep();
  const path = join(m7.repo, "docs", "prior-art", "topics", "demo.json");
  const topic = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...topic, sessions: { ...topic.sessions, B: { cli: "agy", model: "gemini-3.8-flash-high" } } }));
  assert.match(m7.errors(), /protocol-freeze\.json session B is claude claude-sonnet-5-5, but the topic config names agy gemini-3\.8-flash-high/);
});

test("the header, headings, rule and snowball lines are rebuilt, and a sample of the record's numbers fails the gate when changed", () => {
  const s = sweep();
  const header = /the record's header is not the one meta\.json, the freeze and the topic give/;
  for (const [name, body, error] of [
    ["criteria hash", s.text.replace(/^(- Criteria: \S+ sha256\[:16\] `)[0-9a-f]/m, "$1z"), header],
    ["problems", s.text.replace("- Problems: X1, X2, X3, X4;", "- Problems: X1, X2;"), header],
    ["heading", s.text.replace("\n## Stage 1\n", "\n## Stage 4\n"), /the record's v4 sections are not PRISMA, Recall/],
    ["rule", s.text.replace("lower bound >= 0.95 in both runs", "lower bound >= 0.90 in both runs"), /the record's stage-1 rung lines are not the ones the calibration runs give/],
    ["snowball cut", s.text.replace("(cut: none: ", "(cut: row 200: "), /the record's snowball line does not state/],
  ]) {
    assert.notEqual(body, s.text, name);
    assert.match(s.errors(body), error, name);
  }
  const m = sweep();
  const meta = m.json("meta.json");
  m.write("meta.json", { ...meta, date: "2026-10-21" });
  assert.match(m.errors(m.text.replace("- Date: 2026-10-20", "- Date: 2026-10-21")), /meta\.json dates the sweep 2026-10-21, but its name 261020-demo gives 2026-10-20/);
  const lines = s.text.split("\n");
  const numbers = lines.flatMap((line, i) => [...line.matchAll(/\d+(?:\.\d+)?/g)].map((found) => [i, found]));
  const silent = numbers.filter((_, k) => k % 25 === 0).filter(([i, found]) => {
    const changed = found[0].includes(".") ? (Number(found[0]) + 0.5).toFixed(found[0].split(".")[1].length) : String(Number(found[0]) + 3);
    const mutated = [...lines];
    mutated[i] = lines[i].slice(0, found.index) + changed + lines[i].slice(found.index + found[0].length);
    return s.errors(mutated.join("\n")) === "";
  }).map(([i, found]) => `${i + 1}: ${lines[i].slice(Math.max(0, found.index - 30), found.index + 10)}`);
  assert.deepEqual(silent, []);
});

test("every round-3 probe the gate already failed stays a failing negative fixture", () => {
  const rows = (s, name, edit) => s.writeRows(name, edit(s.jsonl(name)));
  const meta = (s, edit) => {
    const m = s.json("meta.json");
    edit(m.sessions);
    s.write("meta.json", m);
  };
  const cal = "judge-config-stage1-brief-claude-sonnet-5-5-run";
  const probes = [
    ["J2", built, (s) => rows(s, "judge-config-screening-B-claude-sonnet-5-5-run1.jsonl", (r) => r.slice(1))],
    ["J4", built, (s) => s.write("judge-config-qgs-A-claude-opus-5-5-run1.jsonl", "")],
    ["J5", built, (s) => s.write(`${cal}1.jsonl`, "")],
    ["J6", built, (s) => rows(s, `${cal}1.jsonl`, (r) => r.slice(0, r.length / 2))],
    ["J7", built, (s) => { s.write("judge-config-screening-A-claude-opus-5-5-run1.jsonl", ""); meta(s, (m) => { delete m["judge-config-screening-A-claude-opus-5-5-run1"]; }); }],
    ["V5", built, (s) => meta(s, (m) => { delete m["stage1-config-brief-claude-sonnet-5-5"]; })],
    ["V6", escalated, (s) => meta(s, (m) => { delete m["judge-config-stage1-brief-claude-opus-5-5-held-out"]; })],
    ["V7", built, (s) => meta(s, (m) => { m["stage1-product-brief-claude-sonnet-5-5"].model = "claude-haiku-5-5"; })],
    ["V8", built, (s) => rows(s, `${cal}1.jsonl`, (r) => r.map((x) => ({ ...x, verdict: "yes" })))],
    ["I1", built, (s) => rows(s, "stage1-inputs-config-brief.jsonl", (r) => r.slice(1))],
    ["I4", built, (s) => rows(s, "stage1-inputs-config-brief.jsonl", (r) => r.map((x, i) => {
      if (i) return x;
      const { row_sha256: _, ...rest } = { ...x, description: "rewritten and hashed again" };
      return { ...rest, row_sha256: createHash("sha256").update(canonical(rest)).digest("hex") };
    }))],
    ["A3", built, (s) => s.write("config-stage1-audit-claude-opus-5-5.jsonl", "")],
    ["P2", built, (s) => s.text.replace("| config | identified: github-code-search | 99 |", "| config | identified: github-code-search | 34 |")
      .replace("| config | identified: snowball | 34 |", "| config | identified: snowball | 99 |")],
    ["P4", built, (s) => s.text.replace(/^\| 1 \| o\/a1 \| .*\n/m, "")],
    ["P5", built, (s) => s.text.replace(/^(\| config \| stage 2: eligible \| \d+ \|)$/m, "$1\n| config | stage 2: excluded: copy | 3 |")],
    ["R9", built, (s) => s.text.replace("- rung 1 config: run 1 sensitivity 31/31 (95% CI 0.89-1.00)", "- rung 1 config: run 1 sensitivity 31/31 (95% CI 0.50-1.00)")],
    ["R11", escalated, (s) => s.text.replace(/lower bound 0\.\d{4}; the pooled/, "lower bound 0.9999; the pooled")],
    ["H1", escalated, (s) => {
      const labels = s.json("held-out-labels.json");
      let kept = 0;
      s.write("held-out-labels.json", { ...labels, rows: labels.rows.map((r) => (r.user.decision !== "eligible" || (kept += 1) <= 9 ? r
        : { ...r, user: { ...r.user, decision: "excluded: irrelevant", Relevance: 0, problems: [] } })) });
    }],
    ["H3", escalated, (s) => { rmSync(join(s.folder, "held-out-labels.json")); rmSync(join(s.folder, "held-out-set.json")); }],
    ["S2", built, (s) => rows(s, "qgs-judge-A.jsonl", (r) => r.map((x) => (x.verdict === "yes" && x === r.find((y) => y.verdict === "yes") ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== "strata")) : x)))],
    ["S4", built, (s) => rows(s, "qgs-reader.jsonl", (r) => r.map((x) => (x.verdict === "yes" ? { ...x, strata: [] } : x)))],
    ["N2", built, (s) => s.write("snowball-cut.json", { ...s.json("snowball-cut.json"), cut_row: 0 })],
    ["N3", built, (s) => s.write("snowball-cut.json", { ...s.json("snowball-cut.json"), cut_row: "5" })],
    ["M10", built, (s) => s.text.replace("- QGS reader: claude-opus-5-5 judged 2 candidates", "- QGS reader: claude-opus-5-5 judged 3 candidates")],
    ["M11", built, (s) => s.text.replace("- screening-A claude claude-opus-5-5, config,", "- screening-A agy gemini-3.8-flash-high, config,")],
    ["X6", built, (s) => s.write("stage1-rung.json", { ...s.json("stage1-rung.json"), rung: 2 })],
    ["X7", built, (s) => s.write("stage1-freeze.json", { ...s.json("stage1-freeze.json"), packets: { ...s.json("stage1-freeze.json").packets, config: "0".repeat(64) } })],
    ["Z5", built, (s) => { const l = s.json("calibration-labels.json"); l.rows[0] = { ...l.rows[0], inputs_sha256: "0".repeat(64) }; s.write("calibration-labels.json", l); }],
    ["CP-miss", built, (s) => {
      const described = new Set(s.jsonl("stage1-inputs-config-brief.jsonl").filter((r) => r.description).map((r) => r.order_rank));
      const positive = s.json("calibration-labels.json").rows.find((r) => r.stratum === "config" && r.user.decision === "eligible" && described.has(r.order_rank));
      for (const run of [1, 2]) rows(s, `${cal}${run}.jsonl`, (r) => r.map((x) => (x.order_rank === positive.order_rank ? { ...x, verdict: "no", problems: [] } : x)));
    }],
  ];
  for (const [name, source, edit] of probes) {
    const s = sweep(source);
    const body = edit(s);
    assert.notEqual(s.errors(typeof body === "string" ? body : s.text), "", name);
  }
});

test("a stage-2 limit never stops stage 2 while the pooled target is reachable: the plan runs past it to the target", () => {
  const s = sweep();
  const tool = (script, ...args) => {
    const run = spawnSync("python3", ["-B", join(STUDY, script), ...args], { encoding: "utf8", env: { ...process.env, STUDY_NO_NETWORK: "1" } });
    assert.equal(run.status, 0, run.stderr);
  };
  tool("plan-stage2.py", "--topic", "demo", "--repo", s.repo, "--work", s.folder, "--limit", "3");
  tool(join("..", "prior-art-sweep-record.py"), s.repo, SWEEP);
  const text = readFileSync(join(s.repo, "docs", "prior-art", "sweeps", `${SWEEP}.md`), "utf8");
  assert.match(text, /stopped at pooled depth 42 \(limit 3\)/);
  assert.equal(s.errors(text), "");
  const t = sweep();
  for (const stratum of ["config", "product"]) {
    const plan = t.json(`${stratum}-stage2.json`);
    t.write(`${stratum}-stage2.json`, { ...plan, limit: 3, order: plan.order.slice(0, 1), stop: { ...plan.stop, limit: 3, depth: 3, reached: false } });
  }
  assert.match(t.errors(), /config-stage2\.json is not the pooled plan the stage-1 files, the facet rankings and the QGS standard give/);
});

test("H-rung: stage-1 verdicts count only with their recorded session, frozen packet, examples, template and row hashes", () => {
  const key = "judge-config-stage1-brief-claude-sonnet-5-5-run1";
  const probe = (edit) => {
    const s = sweep();
    const meta = s.json("meta.json");
    edit(meta, s);
    s.write("meta.json", meta);
    return s.errors();
  };
  assert.match(probe((m, s) => {
    delete m.sessions[key];
    s.writeRows(`${key}.jsonl`, s.jsonl(`${key}.jsonl`).map((r) => ({ ...r, verdict: "yes" })));
  }), new RegExp(`${key}\\.jsonl has no claude claude-sonnet-5-5 session in meta\\.json`));
  assert.match(probe((m) => { m.sessions[key].blocks[0].packet_sha256 = "0".repeat(64); }), new RegExp(`${key}: a block ran on another shape, packet, worked examples or prompt template`));
  const pool = "stage1-product-brief-claude-sonnet-5-5";
  assert.match(probe((m) => { m.sessions[pool].blocks[0].examples_sha256 = "f".repeat(64); }), new RegExp(`${pool}: a block ran on another shape, packet, worked examples`));
  assert.match(probe((m) => { m.sessions[pool].blocks[0].template_sha256 = "f".repeat(64); }), new RegExp(`${pool}: a block ran on another shape, packet, worked examples`));
  assert.match(probe((m) => { const b = m.sessions[key].blocks[0]; b.row_sha256[String(b.ranks[0])] = "a".repeat(64); }), new RegExp(`${key}: ranks \\d+ were not judged on the rows the stage-1 inputs hold`));
  const t = sweep();
  const rows = t.jsonl("stage1-inputs-config-brief.jsonl");
  t.writeRows("stage1-inputs-config-brief.jsonl", rows.map((r, i) => (i === 0 ? { ...r, description: "rewritten" } : r)));
  assert.match(t.errors(), /stage1-inputs-config-brief\.jsonl: rows \d+ do not hash to their recorded row_sha256/);
  const u = sweep();
  u.writeRows("judge-config-stage1-brief-claude-opus-5-5-run9.jsonl", [{ order_rank: 1, repo: "x/y", verdict: "yes" }]);
  assert.match(u.errors(), /judge-config-stage1-brief-claude-opus-5-5-run9\.jsonl has no session in meta\.json/);
  const v = sweep();
  v.write("stage1-freeze.json", { ...v.json("stage1-freeze.json"), ladder: v.json("stage1-freeze.json").ladder.slice(0, 1) });
  assert.match(v.errors(), /stage1-freeze\.json froze another ladder than the toolchain's/);
});

test("H-inputs: stage-1 inputs must be the final pool after the config-pool channel and the snowball", () => {
  const s = sweep();
  const order = s.jsonl("product-screening-order.jsonl");
  s.writeRows("product-screening-order.jsonl", [...order, { ...order[0], order_rank: 9999, repo: "o/joined-late", channels: ["config-pool"] }]);
  const text = s.text.replace(/\| product \| identified: config-pool \| (\d+) \|/, (_, n) => `| product | identified: config-pool | ${Number(n) + 1} |`);
  assert.match(s.errors(text), /stage1-inputs-product-brief\.jsonl is not the final product pool of product-screening-order\.jsonl/);
});

test("the record's rung lines are recomputed from the stage-1 calibration and held-out runs", () => {
  const rungs = /the record's stage-1 rung lines are not the ones the calibration runs give/;
  const s = sweep();
  assert.match(s.errors(s.text.replace(/^- rung 1: run 1 \d+\/\d+ positives passed/m, "- rung 1: run 1 999/999 positives passed")), rungs);
  assert.match(s.errors(s.text.replace(/^(- rung 1: .*one-sided 95% lower bound )0\.\d{4}/m, "$10.9999")), rungs);
  assert.match(s.errors(s.text.replace(/^(- rung 1 product: run 1 sensitivity )\d+\//m, "$1999/")), rungs);
  assert.match(s.errors(s.text.replace("- chosen: rung 1 after 1 rungs tried", "- chosen: rung 1 after 3 rungs tried")), rungs);
  const t = sweep(escalated);
  assert.match(t.errors(t.text.replace(/^(- rung 1: .*the runs differ on )1 of/m, "$10 of")), rungs);
  assert.match(t.errors(t.text.replace(/^(- held-out confirmation: rung 2 passed )(\d+)\/(\d+)/m, "$1999/999")), /the record's held-out confirmation line is not the one the held-out runs give/);
});

test("a rung above the first passes the gate only with its held-out confirmation", () => {
  const s = sweep(escalated);
  assert.equal(s.errors(), "");
  assert.match(s.text, /^- held-out confirmation: rung 2 passed /m);
  const held = s.jsonl("judge-config-stage1-brief-claude-opus-5-5-held-out.jsonl");
  const labels = s.json("held-out-labels.json").rows;
  const described = new Set(s.jsonl("stage1-inputs-config-brief.jsonl").filter((r) => r.description).map((r) => r.order_rank));
  const positive = labels.find((r) => r.stratum === "config" && r.user.decision === "eligible" && described.has(r.order_rank));
  s.writeRows("judge-config-stage1-brief-claude-opus-5-5-held-out.jsonl", held.map((r) => (r.order_rank === positive.order_rank ? { ...r, verdict: "no" } : r)));
  s.writeRows("judge-config-stage1-brief-claude-sonnet-5-5-held-out.jsonl",
    s.jsonl("judge-config-stage1-brief-claude-sonnet-5-5-held-out.jsonl").map((r) => (r.order_rank === positive.order_rank ? { ...r, verdict: "no" } : r)));
  assert.match(s.errors(), new RegExp(`config: rung 2 misses held-out positives ${positive.repo}; it is not confirmed`));
  const z = sweep(escalated);
  const labelled = z.json("held-out-labels.json");
  const none = { ...labelled, rows: labelled.rows.map((r) => ({ ...r, user: { ...r.user, decision: "excluded: irrelevant", Relevance: 0 } })) };
  z.write("held-out-labels.json", none);
  assert.match(z.errors(), /rung 2 is confirmed on held-out batches holding 0 positives, fewer than 10/);
});

test("item 8: a facet ranking made with other terms than the facet's own fails the gate", () => {
  const s = sweep();
  const ranked = s.json("facets/alpha/product-ranked.json");
  s.write("facets/alpha/product-ranked.json", { ...ranked, terms: ["tdd", "test", "guard"] });
  assert.match(s.errors(), /facets\/alpha\/product-ranked\.json was ranked with the terms \["tdd","test","guard"\], not the facet's own \["tdd","test"\]/);
});

test("H-audit: the gate redraws the stage-1 audit, requires a check of every flagged row and recomputes the elusion bounds", () => {
  const sample = /is not the sample the stage-1 files give: 200 near and 100 far excludes ranked by their sha256 under the sweep's seed/;
  const s = sweep();
  const audit = s.json("product-stage1-audit.json");
  s.write("product-stage1-audit.json", { ...audit, far: [...audit.far, s.json("product-stage2.json").passes[0]] });
  assert.match(s.errors(), new RegExp(`product-stage1-audit\\.json ${sample.source}`));
  const t = sweep();
  const config = t.json("config-stage1-audit.json");
  t.write("config-stage1-audit.json", { ...config, near: config.near.slice(0, 1), far: config.far.slice(0, 1) });
  assert.match(t.errors(), new RegExp(`config-stage1-audit\\.json ${sample.source}`));
  const u = sweep();
  u.write("config-stage1-audit.json", { ...config, near: [], far: [], near_pool: 0, far_pool: 0 });
  assert.match(u.errors(), new RegExp(`config-stage1-audit\\.json ${sample.source}`));
  const v = sweep();
  const flagged = Object.keys(v.json("config-stage1-audit-checks.json"));
  assert.equal(flagged.length, 1);
  v.write("config-stage1-audit-checks.json", {});
  assert.match(v.errors(), new RegExp(`config: the user has not checked stage-1 audit ranks ${flagged[0]} that the screener flagged`));
  const w = sweep();
  rmSync(join(w.folder, "config-stage1-audit-checks.json"));
  assert.match(w.errors(), /no config-stage1-audit-checks\.json: the user checks every row the screener flagged/);
  const x = sweep();
  const bound = x.text.match(/^- config stage-1 audit: .*?upper elusion bound (0\.\d{4})/m)[1];
  assert.match(x.errors(x.text.replace(`upper elusion bound ${bound}`, "upper elusion bound 0.0001")), /config: the record's stage-1 audit line is not the elusion the audit files give/);
  assert.match(x.errors(x.text.replace(/^(- config stage-1 audit: .*?near excludes )\d+/m, "$1999")), /config: the record's stage-1 audit line is not the elusion the audit files give/);
  const y = sweep();
  y.write("config-stage1-audit-checks.json", { [flagged[0]]: "eligible" });
  assert.match(y.errors(), /config: the record's stage-1 audit line is not the elusion the audit files give/);
});

test("a v4 record whose labels were imported before the ladder was frozen fails the gate", () => {
  const s = sweep();
  const labels = s.json("calibration-labels.json");
  s.write("calibration-labels.json", { ...labels, stage1_freeze_sha256: "0".repeat(64) });
  assert.match(s.errors(), /calibration-labels\.json was not imported under stage1-freeze\.json: the ladder is frozen before any label is read/);
});

test("a record without a stratum heading fails the gate with an error, not a throw", () => {
  const s = sweep();
  const errors = s.errors(s.text.replace("## Stratum: product\n", "## Stratum product\n"));
  assert.match(errors, /product: the topic screens this stratum but the record has no ## Stratum: product/);
});

test("a record pinning criteria before v4 may not screen a facet that clusters several problems", () => {
  const s = sweep();
  const v3 = s.text.replace("docs/prior-art/quality-criteria-v4.md", "docs/prior-art/quality-criteria-v3.md");
  assert.match(s.errors(v3), /the record pins quality criteria v3, but its topic holds a facet of more than one problem, a cluster that quality criteria v4 introduced/);
});
