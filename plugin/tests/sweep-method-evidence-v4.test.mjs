import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  assert.match(s.errors(s.text.replace(/^- pooled topic recall \d+\//m, "- pooled topic recall 1/")), /pooled topic recall: the record says 1\/47, the files give \d+\/47/);
  assert.match(s.errors(s.text.replace(/^- facet beta: recall \d+\//m, "- facet beta: recall 1/")), /facet beta recall: the record says 1\/\d+, the files give/);
  const plan = s.json("config-stage2.json");
  const excluded = s.jsonl("stage1-config-brief-claude-sonnet-5-5.jsonl").find((r) => r.verdict === "no").order_rank;
  s.write("config-stage2.json", { ...plan, passes: [...plan.passes, excluded] });
  assert.match(s.errors(), /config-stage2\.json does not list the stage-1 passes the stage-1 files give/);
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
});

test("item 8: a facet ranking made with other terms than the facet's own fails the gate", () => {
  const s = sweep();
  const ranked = s.json("facets/alpha/product-ranked.json");
  s.write("facets/alpha/product-ranked.json", { ...ranked, terms: ["tdd", "test", "guard"] });
  assert.match(s.errors(), /facets\/alpha\/product-ranked\.json was ranked with the terms \["tdd","test","guard"\], not the facet's own \["tdd","test"\]/);
});

test("the stage-1 audit draws only stage-1 excludes, read by the stage-2 screener and checked by the user", () => {
  const s = sweep();
  const audit = s.json("product-stage1-audit.json");
  const passed = s.json("product-stage2.json").passes[0];
  s.write("product-stage1-audit.json", { ...audit, far: [...audit.far, passed] });
  const errors = s.errors();
  assert.match(errors, new RegExp(`product-stage1-audit\\.json draws ranks ${passed} that stage 1 did not exclude`));
  assert.match(errors, new RegExp(`product: the stage-2 screener has not read stage-1 audit ranks ${passed}`));
  const t = sweep();
  rmSync(join(t.folder, "config-stage1-audit-checks.json"));
  assert.match(t.errors(), /no config-stage1-audit-checks\.json: the user checks every row the screener flagged/);
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
