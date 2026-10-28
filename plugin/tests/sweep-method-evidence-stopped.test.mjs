import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sweepMethodErrors } from "../lib/sweep-method-evidence.mjs";
import { deepPicks } from "../lib/sweep-method-evidence-stopped.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const RENDERER = fileURLToPath(new URL("../evals/probes/prior-art-sweep-record.py", import.meta.url));
const SWEEP = "261001-demo";
const CRITERIA = "docs/prior-art/quality-criteria-v4.md";
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const label = (n, stratum, repo, problems, [a, m, o, p], decision = "eligible") => ({
  id: `calibration-${stratum}-${n}`, stratum, order_rank: n, repo,
  user: { Authority: a, Methodology: m, Objectivity: o, Position: p, Relevance: problems.length ? 1 : 0, problems, decision },
});
const ROWS = [
  label(1, "config", "o/known", ["S1", "S2"], [1, 1, 0.5, 0.5]),
  label(2, "config", "o/kitchen", ["S1", "S2", "S3", "S4"], [1, 1, 1, 0.5]),
  label(3, "product", "o/small", ["S3"], [1, 1, 1, 1]),
  label(4, "product", "o/weak", ["S4"], [0.5, 0.5, 0.5, 0.5]),
  label(5, "config", "o/none", [], [0, 0, 0, 0], "excluded: irrelevant"),
];
const STARS = { 1: 5000, 2: 3, 3: 10, 4: 900, 5: 1 };

function stoppedSweep() {
  const repo = tempDir("stopped-sweep-");
  const folder = join(repo, "docs/prior-art/sweeps", SWEEP);
  mkdirSync(join(repo, "docs/prior-art/topics"), { recursive: true });
  mkdirSync(folder, { recursive: true });
  const put = (path, value) => writeFileSync(path, JSON.stringify(value, null, 1) + "\n");
  writeFileSync(join(repo, CRITERIA), "criteria v4: a topic sweep may stop at the scale checkpoint\n");
  put(join(repo, "docs/prior-art/topics/demo.json"), { sweep: SWEEP, terms: ["x"], strata: { config: { stop_row: null, forced_repos: [] } } });
  put(join(folder, "meta.json"), { title: "Sweep demo", role: "demo", date: "2026-10-01", criteria: CRITERIA, inventory_digest: "0".repeat(16), problems: ["S1", "S2", "S3", "S4"] });
  put(join(folder, "calibration-set.json"), { batch: "calibration", rows: ROWS.map(({ id, stratum, order_rank, repo }) => ({ id, stratum, order_rank, repo })) });
  put(join(folder, "calibration-labels.json"), { batch: "calibration", rows: ROWS });
  put(join(folder, "reference-freeze-calibration.json"), { batch: "calibration", set_sha256: sha(join(folder, "calibration-set.json")), labels_sha256: sha(join(folder, "calibration-labels.json")) });
  put(join(folder, "deep-study.json"), {
    rows: ROWS.map((r) => ({ batch: "calibration", stratum: r.stratum, rank: r.order_rank, repo: r.repo, commit: `https://github.com/${r.repo}/commit/${"c".repeat(40)}`, stars: STARS[r.order_rank] })),
    supplement: [{ repo: "o/extra", stratum: "product", commit: `https://github.com/o/extra/commit/${"d".repeat(40)}`, problems: ["S4"], reason: "known guard outside the drawn rows" }],
  });
  put(join(folder, "stop.json"), { date: "2026-10-28", decision: "the user chose deep reading", threats: ["stage 1 uncertified at every rung"] });
  put(join(folder, "surface-map.json"), { considered: { PreToolUse: ["o/known guard"] }, "not relevant": { Stop: "no picked mechanism acts there" } });
  const run = spawnSync("python3", ["-B", RENDERER, repo, SWEEP, "--stdout"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return { repo, folder, text: run.stdout };
}

test("the deep-study picks match the Python rule: known and sound sources first, then coverage from strong ones", () => {
  const eligible = ROWS.filter((r) => r.user.decision === "eligible").map((r) => ({ repo: r.repo, stars: STARS[r.order_rank], ...r.user }));
  assert.deepEqual(deepPicks(eligible).map((p) => [p.repo, p.pass, p.adds]), [["o/known", 1, ["S1", "S2"]], ["o/kitchen", 2, ["S1", "S2", "S3", "S4"]], ["o/small", 2, ["S3"]]]);
});

test("a stopped sweep's record passes the gate when it is the one its frozen labels give", () => {
  const { repo, text } = stoppedSweep();
  assert.deepEqual(sweepMethodErrors(repo, `${SWEEP}.md`, text), []);
});

test("a studied row that is no pick, a dropped pick, or labels changed after their freeze fail the gate", () => {
  const { repo, folder, text } = stoppedSweep();
  const swapped = text.replace("| eligible | S4 | reference-eligible", "| study | S4 | reference-eligible").replace(/\| study \| S3 \| pass 2: adds S3 \|/, "| eligible | S3 | pass 2: adds S3 |");
  const errors = sweepMethodErrors(repo, `${SWEEP}.md`, swapped);
  assert.ok(errors.includes("o/weak is studied, but it is neither a pick of the deep-study rule nor a named supplement"), errors.join("\n"));
  assert.ok(errors.includes("o/small is a pick of the deep-study rule but has no study row"), errors.join("\n"));
  const labels = JSON.parse(readFileSync(join(folder, "calibration-labels.json"), "utf8"));
  labels.rows[3].user.Authority = 1;
  writeFileSync(join(folder, "calibration-labels.json"), JSON.stringify(labels, null, 1) + "\n");
  assert.ok(sweepMethodErrors(repo, `${SWEEP}.md`, text).includes("calibration-labels.json is not the file reference-freeze-calibration.json froze"));
});
