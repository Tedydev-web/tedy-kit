import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCardsStudied, checkCoverageMatrix, checkMeasuredAdrs, checkMechanismTable, checkSweepFolder, checkSweepRecord, checkTopicRegistries } from "../lib/sweep-record.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const CRITERIA = "x criteria\n";
const HASH = createHash("sha256").update(CRITERIA).digest("hex").slice(0, 16);
const DIGEST = "2e7feb769e350232";
const SURFACES = ["PreToolUse", "Stop", "skill"];
const ctx = { criteriaText: () => CRITERIA, inventoryDigest: DIGEST, surfaces: SURFACES, latest: true };

const record = ({ criteria = HASH, inventory = DIGEST, stop = "stop: effort bound at row 70", rows, surfaces } = {}) => [
  "# Sweep 261018-dev",
  "",
  "- Role: dev",
  `- Criteria: docs/prior-art/quality-criteria-v2.md sha256[:16] \`${criteria}\``,
  `- Inventory: llms.txt sha256[:16] \`${inventory}\``,
  "",
  "## Stratum: config",
  "",
  stop,
  "",
  "### Screened rows",
  "",
  "| rank | repo | commit | scores | decision | mechanisms | reason |",
  "|---|---|---|---|---|---|---|",
  ...(rows ?? [
    "| 1 | o/a | https://github.com/o/a/commit/x | A1 M1 O1 D1 P1 N1 R1 | study | red-green-ledger | covers ledger and freeze |",
    "| 2 | o/b | https://github.com/o/b/commit/y | A0 M0 O0 D0 P0 N0 R0 | excluded: irrelevant | - | no mechanism |",
  ]),
  "",
  "## Surfaces",
  "",
  ...(surfaces ?? ["- considered: PreToolUse: llm-judge-write-gate", "- considered: Stop: stop-block-on-red", "- not relevant: skill: instructions only"]),
  "",
].join("\n");

test("a complete record passes", () => {
  assert.deepEqual(checkSweepRecord(record(), ctx), []);
});

test("a changed criteria file or a missing pin fails", () => {
  assert.match(checkSweepRecord(record({ criteria: "0".repeat(16) }), ctx).join("\n"), /criteria hash/);
  assert.match(checkSweepRecord(record().replace(/- Criteria:.*\n/, ""), ctx).join("\n"), /no Criteria line/);
});

test("a stratum without a stop line or a no-candidates line fails", () => {
  assert.match(checkSweepRecord(record({ stop: "" }), ctx).join("\n"), /config: no stop/);
  assert.deepEqual(checkSweepRecord(record({ stop: "no candidates: code search, npm", rows: [] }), ctx), []);
});

test("a row without a reason or with an unknown decision fails", () => {
  const noReason = record({ rows: ["| 2 | o/b | c | A0 | excluded: irrelevant | - |  |"] });
  assert.match(checkSweepRecord(noReason, ctx).join("\n"), /o\/b: no reason/);
  const unknown = record({ rows: ["| 2 | o/b | c | A0 | maybe | - | r |"] });
  assert.match(checkSweepRecord(unknown, ctx).join("\n"), /o\/b: unknown decision "maybe"/);
  assert.deepEqual(checkSweepRecord(record({ rows: ["| 3 | o/c | c | A1 | study (below-threshold: 4) | m | forced card source |"] }), ctx), []);
});

test("the latest record must list every inventory surface; older records are frozen", () => {
  const missing = record({ surfaces: ["- considered: PreToolUse: x"] });
  assert.match(checkSweepRecord(missing, ctx).join("\n"), /surface "Stop" not listed/);
  assert.deepEqual(checkSweepRecord(missing, { ...ctx, latest: false }), []);
  assert.match(checkSweepRecord(record({ inventory: "1".repeat(16) }), ctx).join("\n"), /pins inventory 1{16}, current is 2e7f/);
  assert.match(checkSweepRecord(record({ surfaces: [...SURFACES.map((s) => `- considered: ${s}: m`), "- considered: Nope: m"] }), ctx).join("\n"), /"Nope" is not in the inventory/);
  assert.deepEqual(checkSweepRecord(record({ surfaces: [...SURFACES.map((s) => `- not relevant: ${s}: r`), "- outside the inventory: git pre-commit: precommit-test-gate"] }), ctx), []);
});

test("every card must be the source of a study row", () => {
  const dir = tempDir("cards");
  writeFileSync(join(dir, "superpowers.md"), "---\nname: obra/superpowers\n---\n# x\n");
  writeFileSync(join(dir, "procedure.md"), "# not a card\n\n```md\n---\nname: <owner/repo>\n---\n```\n");
  assert.deepEqual(checkCardsStudied(dir, [record({ rows: ["| 1 | obra/superpowers | c | A1 | study | m | r |"] })]), []);
  assert.match(checkCardsStudied(dir, [record()]).join("\n"), /card superpowers \(obra\/superpowers\) has no study row/);
});

test("an ADR with measured: yes needs a Variants table with two numeric arms", () => {
  const dir = tempDir("adr");
  writeFileSync(join(dir, "0010-a.md"), "# a\n\nmeasured: yes\n\n## Variants\n\n| arm | pass |\n|---|---|\n| hook | 7/8 |\n| prose | 3/8 |\n");
  writeFileSync(join(dir, "0011-b.md"), "# b\n\nmeasured: yes\n\n## Variants\n\n| arm | pass |\n|---|---|\n| hook | 7/8 |\n");
  writeFileSync(join(dir, "0012-c.md"), "# c\n\nmeasured: no\n");
  assert.deepEqual(checkMeasuredAdrs(dir), ["0011-b.md: measured: yes needs ## Variants with at least 2 arms holding numbers"]);
});

const DEV = { topic: "dev", idPrefix: "P", frame: { label: "Dev steps", steps: ["One", "Two"] } };
const COORDINATION = { topic: "coordination", idPrefix: "C", frame: { label: "Session lifecycle steps", steps: ["Open or start", "Pick up work (hand-off, pending list)"] } };
const registry = ({ label = "Dev steps", steps = "1 One; 2 Two", id = "P1", topic = "dev", cell = id } = {}) => ["## Frame", "", "- SWEBOK Guide V4 knowledge areas (x): Alpha; Beta.", `- ${label} (y): ${steps}.`, "", "## Problems", "", "| problem |", "|---|", `| ${id} | a |`, "", "## Coverage matrix (z)", "", `- Alpha: 1 ${id}; 2 ${cell}`, `- Beta: 1 none for ${topic}: r; 2 ${id}`, ""].join("\n");

test("the coverage matrix needs every knowledge area and step, naming only known problems", () => {
  const text = (cell) => registry({ cell });
  assert.deepEqual(checkCoverageMatrix(text("P1"), DEV), []);
  assert.match(checkCoverageMatrix(text("P9"), DEV).join("\n"), /Alpha step 2 names unknown P9/);
  assert.match(checkCoverageMatrix(text(""), DEV).join("\n"), /Alpha step 2 is empty/);
  assert.match(checkCoverageMatrix(text("P1").replace("- Beta: 1 none for dev: r; 2 P1\n", ""), DEV).join("\n"), /Beta has no row/);
});

test("the coverage matrix reads its id prefix, steps label and none phrase from the topic", () => {
  const coordination = registry({ label: "Session lifecycle steps", steps: "1 Open or start; 2 Pick up work (hand-off, pending list)", id: "C1", topic: "coordination" });
  assert.deepEqual(checkCoverageMatrix(coordination, COORDINATION), []);
  assert.match(checkCoverageMatrix(coordination, DEV).join("\n"), /no knowledge areas or no Dev steps/);
  assert.match(checkCoverageMatrix(registry({ topic: "dev", id: "C1" }), COORDINATION).join("\n"), /no knowledge areas or no Session lifecycle steps/);
  const devPhrase = registry({ label: "Session lifecycle steps", steps: "1 Open or start; 2 Pick up work (hand-off, pending list)", id: "C1", topic: "dev" });
  assert.match(checkCoverageMatrix(devPhrase, COORDINATION).join("\n"), /Beta step 1 names unknown none for dev: r/);
  assert.match(checkCoverageMatrix(registry({ id: "P1" }), { ...DEV, idPrefix: "C" }).join("\n"), /Alpha step 1 names unknown P1/);
});

test("the registry's frame steps must match the topic config", () => {
  assert.match(checkCoverageMatrix(registry({ steps: "1 One; 2 Deux" }), DEV).join("\n"), /Dev steps in the Frame are "One; Deux", the topic config says "One; Two"/);
});

test("every topic config names a registry that passes its coverage matrix", () => {
  const repo = tempDir("topics");
  const topics = join(repo, "docs", "prior-art", "topics");
  mkdirSync(topics, { recursive: true });
  const coordination = registry({ label: "Session lifecycle steps", steps: "1 Open or start; 2 Pick up work (hand-off, pending list)", id: "C1", topic: "coordination" });
  writeFileSync(join(repo, "docs", "prior-art", "problems-coordination.md"), coordination);
  writeFileSync(join(topics, "coordination.json"), JSON.stringify({ registry: "docs/prior-art/problems-coordination.md", id_prefix: "C", frame: COORDINATION.frame }));
  assert.deepEqual(checkTopicRegistries(repo), []);
  writeFileSync(join(repo, "docs", "prior-art", "problems-coordination.md"), coordination.replace("2 C1\n", "2 C7\n"));
  assert.deepEqual(checkTopicRegistries(repo), ["topics/coordination.json: coverage matrix: Alpha step 2 names unknown C7"]);
  writeFileSync(join(topics, "coordination.json"), JSON.stringify({ registry: "docs/prior-art/problems-coordination.md", frame: COORDINATION.frame }));
  assert.deepEqual(checkTopicRegistries(repo), ["topics/coordination.json: id_prefix must be capital letters"]);
  writeFileSync(join(topics, "coordination.json"), JSON.stringify({ registry: "docs/prior-art/problems-none.md", id_prefix: "C", frame: COORDINATION.frame }));
  assert.deepEqual(checkTopicRegistries(repo), ["topics/coordination.json: registry docs/prior-art/problems-none.md does not exist"]);
  writeFileSync(join(topics, "coordination.json"), "{");
  assert.match(checkTopicRegistries(repo).join("\n"), /topics\/coordination\.json: not JSON/);
  assert.deepEqual(checkTopicRegistries(tempDir("no-topics")), ["docs/prior-art/topics: no topic config"]);
});

test("mechanism table aliases point at classified or reconciled names", () => {
  const table = { aliases: { "config:a": "product:b", "config:c": "product:zz" }, class: { "product:b": "K1" }, default: "new" };
  assert.deepEqual(checkMechanismTable(table, new Set(["config:a", "config:c", "product:b"])), ["alias config:c points at product:zz, which no session coded and the table does not classify"]);
});

test("the kit's own sweep records, cards, ADRs, coverage matrix and mechanism tables pass", () => {
  assert.deepEqual(checkSweepFolder(REPO), []);
});
