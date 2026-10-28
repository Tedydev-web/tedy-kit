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

test("a facet sweep is checked against its facet's own stop rows and role", () => {
  const repo = tempDir("facet-topic-");
  mkdirSync(join(repo, "docs", "prior-art", "topics"), { recursive: true });
  writeFileSync(join(repo, "docs", "prior-art", "topics", "demo.json"), JSON.stringify({ sweep: "261001-demo", strata: { config: { stop_row: 60, forced_repos: ["o/forced"], channels: {} }, product: { stop_row: 61 } },
    facets: { beta: { sweep: "261002-demo-beta", strata: { config: { stop_row: 70, channels: { x: ["q"] } } } } } }));
  assert.equal(typeof evidence.topicForSweep, "function");
  const beta = evidence.topicForSweep(repo, "261002-demo-beta");
  assert.deepEqual([beta.name, beta.strata], ["demo:beta", { config: { stop_row: 70, forced_repos: [], channels: {} }, product: { stop_row: null, forced_repos: [] } }]);
  assert.deepEqual([evidence.topicForSweep(repo, "261001-demo").name, evidence.topicForSweep(repo, "261001-demo").strata.config.stop_row], ["demo", 60]);
  assert.equal(evidence.topicForSweep(repo, "261003-none"), undefined);
});

test("a record's role must be the topic or facet that names its sweep", () => {
  const sweep = methodSweep();
  assert.deepEqual(sweep.errors(), []);
  assert.match(sweep.errors(sweep.text.replace(/^- Topic: demo$/m, "- Topic: demo:beta")).join("\n"), /the record's role is demo:beta, but its sweep belongs to demo/);
});

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
  assert.match(sweep.errors(sweep.text.replace(", counting rows both sessions screened", "")).join("\n"), /config: no recall at the cut counting rows both sessions screened/);
  assert.match(sweep.errors(sweep.text.replace(/^- config kappa: .*\n/m, "")).join("\n"), /config: no kappa per judged criterion/);
});

test("every screening session needs its header, and every block its packet, criteria, prompt and input hashes, CLI version and date", () => {
  const sweep = methodSweep();
  const meta = sweep.meta();
  delete meta.sessions["product-B"].effort;
  delete meta.sessions["config-A"].blocks[0].inputs_sha256;
  meta.sessions["config-A"].blocks[0].packet_sha256 = "0".repeat(64);
  delete meta.sessions["config-pilot-A"].blocks[0].cli_version;
  delete meta.sessions["product-A"].blocks[0].prompt_sha256;
  delete meta.sessions["product-pilot-A"].blocks[0].row_sha256["1"];
  delete meta.sessions["config-pilot-B-gemini-3.8-flash-high"].blocks[0].ranks;
  sweep.writeMeta(meta);
  const errors = sweep.errors().join("\n");
  assert.match(errors, /product-B: meta\.json session lacks effort/);
  assert.match(errors, /config-A: a session block lacks inputs_sha256/);
  assert.match(errors, /config-A: a block ran under a packet or criteria other than the frozen ones/);
  assert.match(errors, /config-pilot-A: a session block lacks cli_version/);
  assert.match(errors, /product-A: a session block lacks prompt_sha256/);
  assert.match(errors, /product-pilot-A: a session block lacks ranks with a row_sha256 each/);
  assert.match(errors, /config-pilot-B-gemini-3\.8-flash-high: a session block lacks ranks with a row_sha256 each/);
});

test("every block digest must be 64 lowercase hex characters", () => {
  const sweep = methodSweep();
  const meta = sweep.meta();
  meta.sessions["config-A"].blocks[0].prompt_sha256 = "x";
  meta.sessions["config-A"].blocks[0].inputs_sha256 = "A".repeat(64);
  meta.sessions["product-B"].blocks[0].row_sha256["2"] = "short";
  sweep.writeMeta(meta);
  const errors = sweep.errors().join("\n");
  assert.match(errors, /config-A: a session block has prompt_sha256, inputs_sha256 that are not 64 lowercase hex characters/);
  assert.match(errors, /product-B: a session block has row_sha256 that are not 64 lowercase hex characters/);
});

test("recorded session models must be the frozen ones, and a CLI version change needs its threat", () => {
  const sweep = methodSweep();
  const meta = sweep.meta();
  meta.sessions["product-A"].model = "claude-haiku-4-5";
  const block = meta.sessions["config-B"].blocks.pop();
  meta.sessions["config-B"].blocks.push({ ...block, ranks: block.ranks.slice(0, 2) }, { ...block, ranks: block.ranks.slice(2), cli_version: "1.4.3" });
  sweep.writeMeta(meta);
  const errors = sweep.errors().join("\n");
  assert.match(errors, /product-A ran claude claude-haiku-4-5, the freeze names claude claude-opus-5-5/);
  assert.match(errors, /config-B: its blocks ran under different CLI versions and the record names no CLI version threat/);
});

test("agy sessions need the agy isolation threat", () => {
  const sweep = methodSweep();
  assert.match(sweep.errors(sweep.text.replace(/^- agy MCP servers, hooks and user settings not excluded: .*\n/m, "")).join("\n"), /config-B ran through agy and the record names no "agy MCP servers/);
});

test("a rated calibration sample must hold ten rows over both strata, score the inputs both sessions scored, and hold no booleans", () => {
  const sweep = methodSweep("--rated");
  assert.deepEqual(sweep.errors(), []);
  const file = join(sweep.folder, "calibration-sample.json");
  const sample = JSON.parse(readFileSync(file, "utf8"));
  sample.rows[0].inputs_sha256 = "0".repeat(64);
  sample.rows[1].user.Position = true;
  writeFileSync(file, JSON.stringify({ ...sample, rows: sample.rows.slice(0, 9) }));
  const errors = sweep.errors().join("\n");
  assert.match(errors, new RegExp(`calibration row ${sample.rows[0].stratum} #${sample.rows[0].order_rank}: its inputs_sha256 is not the row_sha256 session A scored`));
  assert.match(errors, /a rating is a JSON boolean/);
  assert.match(errors, /the calibration sample holds 9 rows over config, product; it needs 10 over config, product/);
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

test("only a session whose recorded threats hold the plugin hook threat needs its line", () => {
  const sweep = methodSweep("--no-bare");
  assert.doesNotMatch(sweep.text, /plugin hooks not excluded/);
  assert.deepEqual(sweep.errors(), []);
  const meta = sweep.meta();
  meta.sessions["config-A"].threats = ["plugin hooks not excluded (no --bare)"];
  sweep.writeMeta(meta);
  assert.match(sweep.errors().join("\n"), /config-A recorded the threat "plugin hooks not excluded \(no --bare\)" and the record does not name it/);
  const named = sweep.text.replace("\n## Threats\n\n", "\n## Threats\n\n- plugin hooks not excluded (no --bare): config-A ran without --bare\n");
  assert.doesNotMatch(sweep.errors(named).join("\n"), /plugin hooks/);
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
  assert.match(sweep.errors().join("\n"), /config: the topic config's stop_row is 60, the record stops at row 6/);
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
