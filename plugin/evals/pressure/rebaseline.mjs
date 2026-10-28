import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ablationPlan, rebaseline } from "../../lib/eval-baseline.mjs";

const KIT = fileURLToPath(new URL("../../../", import.meta.url));
const BASELINE = join(KIT, "plugin/evals/pressure/baseline.json");
const args = process.argv.slice(2);
const folder = args.find((arg) => !arg.startsWith("--"));
if (!folder) {
  console.error("usage: rebaseline.mjs <results folder> [--accept-model-change] [--write]");
  process.exit(2);
}

const results = readdirSync(folder).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(readFileSync(join(folder, file), "utf8")));
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
const outcome = rebaseline({ baseline, results, acceptModelChange: args.includes("--accept-model-change"), date: new Date().toISOString().slice(0, 10) });
console.log(`spend: USD ${outcome.spend?.usd.toFixed(2) ?? "0.00"} measured, ${outcome.spend?.unmeasured ?? 0} runs unmeasured`);
for (const error of outcome.errors) console.error(`refused: ${error}`);
const ledger = JSON.parse(readFileSync(join(KIT, "docs/canon/standard.json"), "utf8"));
const models = [...new Set(results.map((result) => result.model).filter(Boolean))];
for (const row of ablationPlan({ ledger, baseline: outcome.baseline, model: models.length === 1 ? models[0] : undefined })) console.log(`ablation ${row.rule}: ${row.verdict} (${row.detail})`);
if (outcome.errors.length) process.exit(1);
if (args.includes("--write")) {
  writeFileSync(BASELINE, `${JSON.stringify(outcome.baseline, null, 2)}\n`);
  console.log(`baseline written: ${Object.keys(outcome.baseline.cells).length} cells`);
}
