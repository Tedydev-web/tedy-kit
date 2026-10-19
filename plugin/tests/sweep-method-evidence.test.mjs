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
  return { repo, folder, text: readFileSync(record, "utf8"), errors: (text = readFileSync(record, "utf8")) => evidence.sweepMethodErrors(repo, "261001-demo.md", text) };
}

test("the sweep-record gate checks the method evidence of every sweep after the dev sweep", () => {
  assert.equal(typeof evidence.sweepMethodErrors, "function");
  const sweep = methodSweep();
  copyFileSync(join(REPO, "docs", "prior-art", "claude-code-surfaces.md"), join(sweep.repo, "docs", "prior-art", "claude-code-surfaces.md"));
  mkdirSync(join(sweep.repo, "docs", "adr"));
  const metaFile = join(sweep.folder, "meta.json");
  const meta = JSON.parse(readFileSync(metaFile, "utf8"));
  delete meta.sessions["product-B"].effort;
  writeFileSync(metaFile, JSON.stringify(meta));
  assert.ok(checkSweepFolder(sweep.repo).includes("sweeps/261001-demo.md: product-B: meta.json session lacks effort"));
});

test("a record rendered by the toolchain carries all of its method evidence", () => {
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

test("every screening session needs its model, effort, packet sha256 and date", () => {
  const sweep = methodSweep();
  const metaFile = join(sweep.folder, "meta.json");
  const meta = JSON.parse(readFileSync(metaFile, "utf8"));
  delete meta.sessions["product-B"].effort;
  meta.sessions["config-A"].packet_sha256 = "0".repeat(64);
  delete meta.sessions["config-B"];
  writeFileSync(metaFile, JSON.stringify(meta));
  const errors = sweep.errors().join("\n");
  assert.match(errors, /product-B: meta\.json session lacks effort/);
  assert.match(errors, /config-A: packet_sha256 does not match screening-packet-config\.md/);
  assert.match(errors, /config-B: meta\.json records no session/);
});

test("a Chapman figure must be labelled a lower bound", () => {
  const sweep = methodSweep();
  assert.match(sweep.errors(sweep.text.replace("is a lower bound, not an estimate", "estimates the total")).join("\n"), /Chapman figure is not labelled a lower bound/);
});

test("sessions of one model family need the same model family threat", () => {
  const sweep = methodSweep("--same-family");
  assert.match(sweep.errors(sweep.text.replace(/^- same model family: .*\n/gm, "")).join("\n"), /config: sessions A and B are both claude models/);
});

test("the topic config's stop row must be the one the data give", () => {
  const sweep = methodSweep();
  const topicFile = join(sweep.repo, "docs", "prior-art", "topics", "demo.json");
  const topic = JSON.parse(readFileSync(topicFile, "utf8"));
  topic.strata.config.stop_row = 60;
  writeFileSync(topicFile, JSON.stringify(topic));
  assert.match(sweep.errors().join("\n"), /config: the topic config's stop_row is 60, the record stops at row 3/);
});

test("an unrated calibration sample needs the LLM-only screening threat", () => {
  const sweep = methodSweep();
  assert.match(sweep.text, /^- LLM-only screening: /m);
  assert.match(sweep.errors(sweep.text.replace(/^- LLM-only screening: .*\n/m, "")).join("\n"), /no user calibration agreement and no LLM-only screening threat/);
});

test("the dev sweep is grandfathered by name with its reason, and its text fails under any other name", () => {
  const dev = readFileSync(join(REPO, "docs", "prior-art", "sweeps", "261018-dev.md"), "utf8");
  assert.match(evidence.GRANDFATHERED.get("261018-dev"), /before the 2026-10-19 method fixes: it has no frozen protocol/);
  assert.deepEqual(evidence.sweepMethodErrors(REPO, "261018-dev.md", dev), []);
  const errors = evidence.sweepMethodErrors(REPO, "261020-dev.md", dev).join("\n");
  assert.match(errors, /no ## Protocol section/);
  assert.match(errors, /Chapman figure is not labelled a lower bound/);
  assert.match(errors, /no user calibration agreement/);
});
