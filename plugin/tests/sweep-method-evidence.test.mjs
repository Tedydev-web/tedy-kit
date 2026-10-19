import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSweepFolder } from "../lib/sweep-record.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../evals/probes/study/study_method_fixture.py", import.meta.url));
const evidence = await import("../lib/sweep-method-evidence.mjs").catch(() => ({}));

function methodSweep(...flags) {
  const repo = tempDir("method-sweep-");
  const run = spawnSync("python3", ["-B", FIXTURE, repo, ...flags], { encoding: "utf8", env: { ...process.env, STUDY_NO_NETWORK: "1" } });
  assert.equal(run.status, 0, run.stderr);
  const folder = join(repo, "docs", "prior-art", "sweeps", "261001-demo");
  const record = join(repo, "docs", "prior-art", "sweeps", "261001-demo.md");
  const meta = () => JSON.parse(readFileSync(join(folder, "meta.json"), "utf8"));
  const writeMeta = (value) => writeFileSync(join(folder, "meta.json"), JSON.stringify(value));
  return { repo, folder, meta, writeMeta, text: readFileSync(record, "utf8"), errors: (text = readFileSync(record, "utf8")) => evidence.sweepMethodErrors(repo, "261001-demo.md", text) };
}

test("the sweep-record gate checks the method evidence of every sweep after the dev sweep", () => {
  assert.equal(typeof evidence.sweepMethodErrors, "function");
  const sweep = methodSweep();
  copyFileSync(join(REPO, "docs", "prior-art", "claude-code-surfaces.md"), join(sweep.repo, "docs", "prior-art", "claude-code-surfaces.md"));
  mkdirSync(join(sweep.repo, "docs", "adr"));
  const meta = sweep.meta();
  delete meta.sessions["product-B"].effort;
  sweep.writeMeta(meta);
  assert.ok(checkSweepFolder(sweep.repo).includes("sweeps/261001-demo.md: product-B: meta.json session lacks effort"));
});

test("a sweep run through the toolchain, exported and rendered passes the gate", () => {
  assert.deepEqual(methodSweep().errors(), []);
  assert.deepEqual(methodSweep("--same-family", "--rated").errors(), []);
});

test("a missing freeze, or a protocol changed after it, fails", () => {
  const sweep = methodSweep();
  assert.match(sweep.errors(sweep.text.replace(/## Protocol\n[\s\S]*?\n(?=## )/, "")).join("\n"), /no ## Protocol section/);
  writeFileSync(join(sweep.folder, "screening-packet-config.md"), "packet config, edited after the freeze\n");
  assert.match(sweep.errors().join("\n"), /config: the criteria or screening-packet-config\.md changed after the freeze/);
  assert.match(sweep.errors(sweep.text.replace(/^- product: post-freeze rows/m, "- product: rows")).join("\n"), /product: agreement is not measured on post-freeze rows/);
});

test("recall at the cut and kappa are required per stratum", () => {
  const sweep = methodSweep();
  assert.match(sweep.errors(sweep.text.replace(/^- product: recall at the cut.*\n/m, "")).join("\n"), /product: no recall at the cut/);
  assert.match(sweep.errors(sweep.text.replace(/^- config kappa: .*\n/m, "")).join("\n"), /config: no kappa per judged criterion/);
});

test("every screening session needs its header, and every block its packet, criteria and input hashes and date", () => {
  const sweep = methodSweep();
  const meta = sweep.meta();
  delete meta.sessions["product-B"].effort;
  delete meta.sessions["config-A"].blocks[0].inputs_sha256;
  meta.sessions["config-A"].blocks[0].packet_sha256 = "0".repeat(64);
  delete meta.sessions["config-pilot-A"].cli_version;
  sweep.writeMeta(meta);
  const errors = sweep.errors().join("\n");
  assert.match(errors, /product-B: meta\.json session lacks effort/);
  assert.match(errors, /config-A: a session block lacks inputs_sha256/);
  assert.match(errors, /config-A: a block ran under a packet or criteria other than the frozen ones/);
  assert.match(errors, /config-pilot-A: meta\.json session lacks cli_version/);
});

test("both session files and both entries are required for every screened stratum, and A and B must score the same inputs", () => {
  const sweep = methodSweep();
  const meta = sweep.meta();
  meta.sessions["config-B"].blocks[0].row_sha256["3"] = "0".repeat(64);
  delete meta.sessions["product-B"];
  sweep.writeMeta(meta);
  const errors = sweep.errors().join("\n");
  assert.match(errors, /config: sessions A and B scored different inputs for ranks 3/);
  assert.match(errors, /product-B: meta\.json records no session blocks/);
});

test("the capture-recapture line must state Chapman as a lower bound", () => {
  const sweep = methodSweep();
  assert.match(sweep.errors(sweep.text.replace(/is a lower bound, not an estimate/g, "estimates the total")).join("\n"), /config: no capture-recapture line with Chapman as a lower bound/);
});

test("sessions of one model family need the same model family threat", () => {
  const sweep = methodSweep("--same-family");
  assert.match(sweep.errors(sweep.text.replace(/^- same model family: .*\n/gm, "")).join("\n"), /config: sessions A and B are both claude models/);
});

test("the academic channel needs the papers-not-screened threat", () => {
  const sweep = methodSweep();
  assert.match(sweep.errors(sweep.text.replace(/^- academic papers logged, not screened: .*\n/m, "")).join("\n"), /academic papers logged, not screened/);
});

test("the topic config's stop row must be the one the data give", () => {
  const sweep = methodSweep();
  const topicFile = join(sweep.repo, "docs", "prior-art", "topics", "demo.json");
  const topic = JSON.parse(readFileSync(topicFile, "utf8"));
  topic.strata.config.stop_row = 60;
  writeFileSync(topicFile, JSON.stringify(topic));
  assert.match(sweep.errors().join("\n"), /config: the topic config's stop_row is 60, the record stops at row 3/);
});

test("a tag-only stratum must be stated as not screened, an array of channels is not channels, and a screened one needs its section", () => {
  const sweep = methodSweep();
  assert.match(sweep.text, /^- local: tag-only inventory, not screened by two sessions/m);
  assert.match(sweep.errors(sweep.text.replace(/^- local: tag-only .*\n/m, "")).join("\n"), /local: a stratum without channels is not stated as tag-only/);
  assert.match(sweep.errors(sweep.text.replace("## Stratum: product\n", "## Stratum: gone\n")).join("\n"), /product: the topic screens this stratum but the record has no ## Stratum: product/);
  const topicFile = join(sweep.repo, "docs", "prior-art", "topics", "demo.json");
  const topic = JSON.parse(readFileSync(topicFile, "utf8"));
  topic.strata.product.channels = [];
  writeFileSync(topicFile, JSON.stringify(topic));
  assert.match(sweep.errors().join("\n"), /product: a stratum without channels is not stated as tag-only/);
});

test("an unrated calibration sample needs the LLM-only screening threat", () => {
  const sweep = methodSweep();
  assert.match(sweep.text, /^- LLM-only screening: /m);
  assert.match(sweep.errors(sweep.text.replace(/^- LLM-only screening: .*\n/m, "")).join("\n"), /no user calibration agreement and no LLM-only screening threat/);
});

test("the dev sweep is grandfathered by name and record hash with its reason; an edited text or another name loses the exemption", () => {
  const dev = readFileSync(join(REPO, "docs", "prior-art", "sweeps", "261018-dev.md"), "utf8");
  const exemption = evidence.GRANDFATHERED.get("261018-dev");
  assert.match(exemption.reason, /before the 2026-10-19 method fixes: it has no frozen protocol/);
  assert.match(exemption.reason, /on 2026-10-19 only its two .screened beyond the stop. counts were corrected/);
  assert.match(exemption.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(evidence.sweepMethodErrors(REPO, "261018-dev.md", dev), []);
  assert.match(evidence.sweepMethodErrors(REPO, "261018-dev.md", dev.replace("target 0.90", "target 0.85")).join("\n"), /no ## Protocol section/);
  const errors = evidence.sweepMethodErrors(REPO, "261020-dev.md", dev).join("\n");
  assert.match(errors, /no ## Protocol section/);
  assert.match(errors, /no capture-recapture line with Chapman as a lower bound/);
  assert.match(errors, /no user calibration agreement/);
});
