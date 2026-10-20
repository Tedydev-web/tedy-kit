import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const GRANDFATHERED = new Map([
  [
    "261018-dev",
    {
      sha256: "78017595bbf005285b23eb2302c3f647f0b87c46940c86549a4c6a71538d1b47",
      reason:
        "screened on 2026-10-18 under quality-criteria-v2, before the 2026-10-19 method fixes: it has no frozen protocol, no per-session model record, no recall at the cut, kappa or calibration sample, and no stop row written by the toolchain; its rows stay unchanged because ADR 0010 and problems-canon.md cite them, and on 2026-10-19 only its two 'screened beyond the stop' counts were corrected (config 118 to 0, product 140 to 70) after an operator-precedence bug in the renderer",
    },
  ],
]);

const HEADER_FIELDS = ["model", "effort"];
const BLOCK_FIELDS = ["packet_sha256", "criteria_sha256", "prompt_sha256", "inputs_sha256", "cli_version", "date"];
const HASH_FIELDS = ["packet_sha256", "criteria_sha256", "prompt_sha256", "inputs_sha256"];
const HEX64 = /^[0-9a-f]{64}$/;
const AGY_THREAT = "agy MCP servers, hooks and user settings not excluded";
const SAMPLE_SIZE = 10;
const CALIBRATED = new Set(["config", "product"]);
const SESSION_FILE = /^([a-z0-9]+)-(?:screen-[AB]|pilot-.+)\.jsonl$/;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const family = (model) => model.toLowerCase().split(/[-.]/, 1)[0];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const screenedRule = (rule) => typeof rule?.channels === "object" && rule.channels !== null && !Array.isArray(rule.channels);

function part(text, heading) {
  return text.split(/^(?=## )/m).find((chunk) => chunk.startsWith(`## ${heading}\n`)) ?? "";
}

function protocolDigests(text, strata, { read, criteriaText }) {
  const protocol = part(text, "Protocol");
  if (!protocol) return { errors: ["no ## Protocol section: freeze the protocol after the pilot block with freeze-protocol.py"], digests: {} };
  const criteria = text.match(/^- Criteria: (\S+) sha256/m)?.[1];
  const errors = [];
  const digests = {};
  for (const stratum of strata) {
    const line = protocol.match(new RegExp(`^- ${escape(stratum)}: frozen after row \\d+ \\(pilot block of \\d+ unforced rows?\\), criteria sha256 \`([0-9a-f]{64})\`, packet sha256 \`([0-9a-f]{64})\` \\((\\S+)\\), \\d{4}-\\d{2}-\\d{2}$`, "m"));
    if (!line) {
      errors.push(`${stratum}: no protocol freeze line`);
      continue;
    }
    digests[stratum] = { criteria: line[1], packet: line[2] };
    const packet = read(line[3]);
    if (packet === undefined) errors.push(`${stratum}: ${line[3]} is not in the sweep folder`);
    else if (!criteria || sha256(criteriaText(criteria)) !== line[1] || sha256(packet) !== line[2]) errors.push(`${stratum}: the criteria or ${line[3]} changed after the freeze`);
  }
  return { errors, digests };
}

function sessionErrors(files, sessions, strata, digests) {
  const errors = strata.flatMap((stratum) => ["A", "B"].flatMap((side) => (files.includes(`${stratum}-screen-${side}.jsonl`) ? [] : [`${stratum}: no ${stratum}-screen-${side}.jsonl in the sweep folder`])));
  for (const file of files) {
    const stratum = file.match(SESSION_FILE)?.[1];
    if (!stratum) continue;
    const key = file.slice(0, -6).replace("-screen-", "-");
    const entry = sessions[key];
    if (!entry?.blocks?.length) {
      errors.push(`${key}: meta.json records no session blocks`);
      continue;
    }
    errors.push(...HEADER_FIELDS.filter((f) => typeof entry[f] !== "string" || !entry[f]).map((f) => `${key}: meta.json session lacks ${f}`));
    for (const block of entry.blocks) {
      errors.push(...BLOCK_FIELDS.filter((f) => typeof block[f] !== "string" || !block[f]).map((f) => `${key}: a session block lacks ${f}`));
      const hashes = block.row_sha256;
      if (!Array.isArray(block.ranks) || !block.ranks.length || typeof hashes !== "object" || hashes === null || block.ranks.some((r) => typeof hashes[String(r)] !== "string")) {
        errors.push(`${key}: a session block lacks ranks with a row_sha256 each`);
      }
      const malformed = HASH_FIELDS.filter((f) => typeof block[f] === "string" && block[f] && !HEX64.test(block[f]));
      if (Object.values(hashes ?? {}).some((h) => !HEX64.test(String(h)))) malformed.push("row_sha256");
      if (malformed.length) errors.push(`${key}: a session block has ${malformed.join(", ")} that are not 64 lowercase hex characters`);
      const frozen = key.includes("-pilot-") ? undefined : digests[stratum];
      if (frozen && (block.packet_sha256 !== frozen.packet || block.criteria_sha256 !== frozen.criteria)) errors.push(`${key}: a block ran under a packet or criteria other than the frozen ones`);
    }
  }
  for (const stratum of strata) {
    const a = rowHashes(sessions[`${stratum}-A`]);
    const b = rowHashes(sessions[`${stratum}-B`]);
    const differ = Object.keys(a).filter((rank) => rank in b && a[rank] !== b[rank]);
    if (differ.length) errors.push(`${stratum}: sessions A and B scored different inputs for ranks ${differ.join(", ")}`);
  }
  return errors;
}

const rowHashes = (entry) => Object.assign({}, ...(entry?.blocks ?? []).map((b) => b.row_sha256 ?? {}));

function frozenModelErrors(freeze, sessions, strata) {
  if (!freeze) return ["no protocol-freeze.json in the sweep folder"];
  return strata.flatMap((stratum) =>
    [["A", freeze.session_a], ["B", freeze.session_b?.chosen]].flatMap(([side, frozen]) => {
      const entry = sessions[`${stratum}-${side}`];
      return entry && (entry.cli !== frozen?.cli || entry.model !== frozen?.model) ? [`${stratum}-${side} ran ${entry.cli} ${entry.model}, the freeze names ${frozen?.cli} ${frozen?.model}`] : [];
    }),
  );
}

function calibrationErrors(sample, sessions, strata) {
  if (!sample) return [];
  const rows = Array.isArray(sample.rows) ? sample.rows : [];
  const want = strata.filter((s) => CALIBRATED.has(s)).sort();
  const got = [...new Set(rows.map((r) => r.stratum))].sort();
  const errors = rows.length === SAMPLE_SIZE && got.join() === want.join() ? [] : [`the calibration sample holds ${rows.length} rows over ${got.join(", ") || "no stratum"}; it needs ${SAMPLE_SIZE} over ${want.join(", ")}`];
  for (const row of rows) {
    for (const side of ["A", "B"]) {
      if (rowHashes(sessions[`${row.stratum}-${side}`])[String(row.order_rank)] !== row.inputs_sha256) errors.push(`calibration row ${row.stratum} #${row.order_rank}: its inputs_sha256 is not the row_sha256 session ${side} scored`);
    }
    if (Object.values(row.user ?? {}).some((v) => typeof v === "boolean")) errors.push(`calibration row ${row.stratum} #${row.order_rank}: a rating is a JSON boolean`);
  }
  return errors;
}

export function checkMethodEvidence(text, { files, read, criteriaText, topic }) {
  const strata = [...text.matchAll(/^## Stratum: (\S+)$/gm)].map((m) => m[1]);
  const agreement = part(text, "Agreement and capture-recapture");
  const threats = part(text, "Threats");
  const sessions = JSON.parse(read("meta.json") ?? "{}").sessions ?? {};
  const { errors, digests } = protocolDigests(text, strata, { read, criteriaText });
  errors.push(...sessionErrors(files, sessions, strata, digests));
  if (!topic) errors.push("no topic config names this sweep, so its stop rows cannot be checked");
  const hookThreat = /^- plugin hooks not excluded \(no --bare\): /m.test(threats);
  const agyThreat = threats.includes(`\n- ${AGY_THREAT}: `);
  const versionThreat = /^- CLI version changed within a session: /m.test(threats);
  for (const [key, entry] of Object.entries(sessions)) {
    if (entry?.cli === "claude" && !String(entry.isolation ?? "").includes("--bare") && !hookThreat) errors.push(`${key} ran claude without --bare and the record names no plugin hooks threat`);
    if (entry?.cli === "agy" && !agyThreat) errors.push(`${key} ran through agy and the record names no "${AGY_THREAT}" threat`);
    if (new Set((entry?.blocks ?? []).map((b) => b.cli_version)).size > 1 && !versionThreat) errors.push(`${key}: its blocks ran under different CLI versions and the record names no CLI version threat`);
  }
  errors.push(...frozenModelErrors(JSON.parse(read("protocol-freeze.json") ?? "null"), sessions, strata));
  errors.push(...calibrationErrors(JSON.parse(read("calibration-sample.json") ?? "null"), sessions, strata));
  const tagOnly = part(text, "Tag-only strata");
  for (const [stratum, rule] of Object.entries(topic?.strata ?? {})) {
    if (!screenedRule(rule) && !new RegExp(`^- ${escape(stratum)}: tag-only `, "m").test(tagOnly)) errors.push(`${stratum}: a stratum without channels is not stated as tag-only`);
    if (screenedRule(rule) && !strata.includes(stratum)) errors.push(`${stratum}: the topic screens this stratum but the record has no ## Stratum: ${stratum}`);
    if (screenedRule(rule) && rule.channels.academic && !/^- academic papers logged, not screened: /m.test(threats)) errors.push(`${stratum}: the academic channel ran and the record names no "academic papers logged, not screened" threat`);
  }
  for (const stratum of strata) {
    const s = escape(stratum);
    if (!new RegExp(`^- ${s}: post-freeze rows \\d+ `, "m").test(agreement)) errors.push(`${stratum}: agreement is not measured on post-freeze rows`);
    if (!new RegExp(`^- ${s} kappa: .*; eligibility kappa `, "m").test(agreement)) errors.push(`${stratum}: no kappa per judged criterion with eligibility kappa`);
    if (!new RegExp(`^- ${s} capture-recapture.*Chapman [\\d.]+ is a lower bound`, "m").test(agreement)) errors.push(`${stratum}: no capture-recapture line with Chapman as a lower bound`);
    if (CALIBRATED.has(stratum) && !new RegExp(`^- ${s}: recall at the cut \\d+/\\d+ \\([\\d.]+\\) of the ${s} standard, counting rows both sessions screened; `, "m").test(part(text, "Recall"))) {
      errors.push(`${stratum}: no recall at the cut counting rows both sessions screened`);
    }
    const a = sessions[`${stratum}-A`]?.model ?? "";
    const b = sessions[`${stratum}-B`]?.model ?? "";
    if (family(a) === family(b) && !/^- same model family: /m.test(threats)) errors.push(`${stratum}: sessions A and B are both ${family(a)} models and the record names no same model family threat`);
    const stop = part(text, `Stratum: ${stratum}`).match(/^stop: (?:effort bound|pool exhausted) at row (\d+)$/m);
    const written = topic?.strata?.[stratum]?.stop_row;
    if (!stop) errors.push(`${stratum}: no stop line derived from the screening data`);
    else if (topic && Number(stop[1]) !== written) errors.push(`${stratum}: the topic config's stop_row is ${written}, the record stops at row ${stop[1]}; write it with compare-screening-sessions.py --write-stop`);
  }
  if (!/^- user vs session A: /m.test(part(text, "Calibration")) && !/^- LLM-only screening: /m.test(threats)) errors.push("no user calibration agreement and no LLM-only screening threat");
  return errors;
}

export function topicForSweep(repo, sweep) {
  const dir = join(repo, "docs", "prior-art", "topics");
  const configs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => [f.slice(0, -5), JSON.parse(readFileSync(join(dir, f), "utf8"))]) : [];
  const whole = configs.find(([, config]) => config.sweep === sweep);
  if (whole) return { ...whole[1], name: whole[0] };
  for (const [stem, config] of configs) {
    const found = Object.entries(config.facets ?? {}).find(([, facet]) => facet?.sweep === sweep);
    if (!found) continue;
    const [name, facet] = found;
    const strata = Object.fromEntries(Object.entries(config.strata ?? {}).map(([s, rule]) => [s, { ...rule, stop_row: facet.strata?.[s]?.stop_row ?? null, forced_repos: facet.strata?.[s]?.forced_repos ?? [] }]));
    return { ...config, name: `${stem}:${name}`, sweep, strata };
  }
  return undefined;
}

export function sweepMethodErrors(repo, file, text) {
  const sweep = file.slice(0, -3);
  if (GRANDFATHERED.get(sweep)?.sha256 === sha256(text)) return [];
  const folder = join(repo, "docs", "prior-art", "sweeps", sweep);
  const files = existsSync(folder) ? readdirSync(folder).sort() : [];
  const read = (name) => (files.includes(name) ? readFileSync(join(folder, name), "utf8") : undefined);
  const criteriaText = (path) => (existsSync(join(repo, path)) ? readFileSync(join(repo, path), "utf8") : "");
  const topic = topicForSweep(repo, sweep);
  const role = text.match(/^- Role: (\S+)$/m)?.[1];
  const roleErrors = topic && role !== topic.name ? [`the record's role is ${role}, but its sweep belongs to ${topic.name}; set meta.json role to ${topic.name}`] : [];
  return [...roleErrors, ...checkMethodEvidence(text, { files, read, criteriaText, topic })];
}
