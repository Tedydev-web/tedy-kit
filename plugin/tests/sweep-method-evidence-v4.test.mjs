import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sweepMethodErrors } from "../lib/sweep-method-evidence.mjs";
import { kappa, lowerBound } from "../lib/sweep-method-evidence-v4.mjs";
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
  return { repo, folder, text, json, jsonl, write, writeRows, errors: (body = text) => sweepMethodErrors(repo, `${SWEEP}.md`, body).join("\n") };
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
  const w = sweep();
  const sessions = w.json("meta.json");
  sessions.sessions["product-B"].model = "claude-haiku-5-5";
  w.write("meta.json", sessions);
  assert.match(w.errors(), /product-B did not run the validated screening-B claude-sonnet-5-5 on the full inputs it was validated on/);
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
  }), new RegExp(`${key}\\.jsonl has no claude-sonnet-5-5 session in meta\\.json`));
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
