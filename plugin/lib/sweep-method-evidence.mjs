import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const GRANDFATHERED = new Map([
  [
    "261018-dev",
    "screened on 2026-10-18 under quality-criteria-v2, before the 2026-10-19 method fixes: it has no frozen protocol, no per-session model record, no recall at the cut, kappa or calibration sample, and no stop row written by the toolchain; its record stays byte-identical because ADR 0010 and problems-canon.md cite its rows",
  ],
]);

const SESSION_FIELDS = ["model", "effort", "packet_sha256", "date"];
const CALIBRATED = new Set(["config", "product"]);
const SESSION_FILE = /^([a-z0-9]+)-(?:screen-[AB]|pilot-.+)\.jsonl$/;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const family = (model) => model.toLowerCase().split(/[-.]/, 1)[0];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function part(text, heading) {
  return text.split(/^(?=## )/m).find((chunk) => chunk.startsWith(`## ${heading}\n`)) ?? "";
}

function protocolErrors(text, strata, { read, criteriaText }) {
  const protocol = part(text, "Protocol");
  if (!protocol) return ["no ## Protocol section: freeze the protocol after the pilot block with freeze-protocol.py"];
  const criteria = text.match(/^- Criteria: (\S+) sha256/m)?.[1];
  return strata.flatMap((stratum) => {
    const line = protocol.match(new RegExp(`^- ${escape(stratum)}: frozen after row \\d+ \\(pilot block of \\d+ unforced rows?\\), protocol sha256\\[:16\\] \`([0-9a-f]{16})\` over the criteria and (\\S+), \\d{4}-\\d{2}-\\d{2}$`, "m"));
    if (!line) return [`${stratum}: no protocol freeze line`];
    const packet = read(line[2]);
    if (packet === undefined) return [`${stratum}: ${line[2]} is not in the sweep folder`];
    if (!criteria || sha256(criteriaText(criteria) + packet).slice(0, 16) !== line[1]) return [`${stratum}: the criteria or ${line[2]} changed after the freeze`];
    return [];
  });
}

function sessionErrors(files, sessions, read) {
  return files.flatMap((file) => {
    const stratum = file.match(SESSION_FILE)?.[1];
    if (!stratum) return [];
    const key = file.slice(0, -6).replace("-screen-", "-");
    const entry = sessions[key];
    if (!entry) return [`${key}: meta.json records no session`];
    const missing = SESSION_FIELDS.filter((field) => typeof entry[field] !== "string" || !entry[field]).map((field) => `${key}: meta.json session lacks ${field}`);
    if (key.includes("-pilot-")) return missing;
    const packet = read(`screening-packet-${stratum}.md`);
    if (packet === undefined) return [...missing, `${key}: screening-packet-${stratum}.md is not in the sweep folder`];
    return entry.packet_sha256 && sha256(packet) !== entry.packet_sha256 ? [...missing, `${key}: packet_sha256 does not match screening-packet-${stratum}.md`] : missing;
  });
}

export function checkMethodEvidence(text, { files, read, criteriaText, topic }) {
  const strata = [...text.matchAll(/^## Stratum: (\S+)$/gm)].map((m) => m[1]);
  const agreement = part(text, "Agreement and capture-recapture");
  const threats = part(text, "Threats");
  const sessions = JSON.parse(read("meta.json") ?? "{}").sessions ?? {};
  const errors = [...protocolErrors(text, strata, { read, criteriaText }), ...sessionErrors(files, sessions, read)];
  if (!topic) errors.push("no topic config names this sweep, so its stop rows cannot be checked");
  for (const stratum of strata) {
    const s = escape(stratum);
    if (!new RegExp(`^- ${s}: post-freeze rows \\d+ `, "m").test(agreement)) errors.push(`${stratum}: agreement is not measured on post-freeze rows`);
    if (!new RegExp(`^- ${s} kappa: .*; eligibility kappa `, "m").test(agreement)) errors.push(`${stratum}: no kappa per judged criterion with eligibility kappa`);
    if (CALIBRATED.has(stratum) && !new RegExp(`^- ${s}: recall at the cut \\d+/\\d+ `, "m").test(part(text, "Recall"))) errors.push(`${stratum}: no recall at the cut`);
    const a = sessions[`${stratum}-A`]?.model;
    const b = sessions[`${stratum}-B`]?.model;
    if (a && b && family(a) === family(b) && !/^- same model family: /m.test(threats)) errors.push(`${stratum}: sessions A and B are both ${family(a)} models and the record names no same model family threat`);
    const stop = part(text, `Stratum: ${stratum}`).match(/^stop: (?:effort bound|pool exhausted) at row (\d+)$/m);
    const written = topic?.strata?.[stratum]?.stop_row;
    if (!stop) errors.push(`${stratum}: no stop line derived from the screening data`);
    else if (topic && Number(stop[1]) !== written) errors.push(`${stratum}: the topic config's stop_row is ${written}, the record stops at row ${stop[1]}; write it with compare-screening-sessions.py --write-stop`);
  }
  for (const line of text.split("\n")) if (/chapman/i.test(line) && !/lower bound/.test(line)) errors.push(`a Chapman figure is not labelled a lower bound: "${line.slice(0, 80)}"`);
  if (!/^- user vs session A: /m.test(part(text, "Calibration")) && !/^- LLM-only screening: /m.test(threats)) errors.push("no user calibration agreement and no LLM-only screening threat");
  return errors;
}

function topicFor(repo, sweep) {
  const dir = join(repo, "docs", "prior-art", "topics");
  const configs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))) : [];
  return configs.find((config) => config.sweep === sweep);
}

export function sweepMethodErrors(repo, file, text) {
  const sweep = file.slice(0, -3);
  if (GRANDFATHERED.has(sweep)) return [];
  const folder = join(repo, "docs", "prior-art", "sweeps", sweep);
  const files = existsSync(folder) ? readdirSync(folder).sort() : [];
  const read = (name) => (files.includes(name) ? readFileSync(join(folder, name), "utf8") : undefined);
  const criteriaText = (path) => (existsSync(join(repo, path)) ? readFileSync(join(repo, path), "utf8") : "");
  return checkMethodEvidence(text, { files, read, criteriaText, topic: topicFor(repo, sweep) });
}
