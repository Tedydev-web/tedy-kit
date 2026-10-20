import { createHash } from "node:crypto";

export const RECALL_TARGET = 0.8;
export const SENSITIVITY_FLOOR = 0.9;
export const KAPPA_FLOOR = 0.6;
export const STAGE1_BOUND = 0.95;
export const POSITIVES_NEEDED = 59;
export const HELD_OUT_POSITIVES = 10;
export const EXCLUDE_CODES = ["irrelevant", "below-threshold", "copy", "dead", "aggregator"];
export const NEAR_ROWS = 200;
export const FAR_ROWS = 100;
export const AUDIT_ROWS = 20;
export const CALIBRATED = ["config", "product"];

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const lower = (name) => String(name ?? "").toLowerCase();

function logChoose(n, k) {
  let total = 0;
  for (let i = 1; i <= k; i += 1) total += Math.log(n - k + i) - Math.log(i);
  return total;
}

function tailAtLeast(k, n, p) {
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return 1;
  let total = 0;
  for (let i = k; i <= n; i += 1) total += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return total;
}

export function lowerBound(k, n, alpha = 0.05) {
  if (k === 0) return 0;
  let [lo, hi] = [0, 1];
  for (let step = 0; step < 100; step += 1) {
    const mid = (lo + hi) / 2;
    if (tailAtLeast(k, n, mid) < alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function kappa(pairs) {
  if (!pairs.length) return null;
  const n = pairs.length;
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  const yesA = pairs.filter(([a]) => a).length / n;
  const yesB = pairs.filter(([, b]) => b).length / n;
  const expected = yesA * yesB + (1 - yesA) * (1 - yesB);
  return expected < 1 ? (observed - expected) / (1 - expected) : null;
}

export function reader(read) {
  const json = (name) => {
    const text = read(name);
    return text === undefined ? undefined : JSON.parse(text);
  };
  const jsonl = (name) => (read(name) ?? "").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  return { json, jsonl };
}

export const LADDER = [
  { rung: 1, models: ["claude-sonnet-5-5"], shape: "brief" },
  { rung: 2, models: ["claude-opus-5-5", "claude-sonnet-5-5"], shape: "brief" },
  { rung: 3, models: ["claude-opus-5-5", "claude-sonnet-5-5"], shape: "paths" },
  { rung: 4, models: ["claude-opus-5-5", "claude-sonnet-5-5"], shape: "readme" },
];

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

export const covered = (entry) => new Set((entry?.blocks ?? []).flatMap((b) => b.ranks ?? []));
export const blockHashes = (entry) => Object.assign({}, ...(entry?.blocks ?? []).map((b) => b.row_sha256 ?? {}));
export const autoPass = (row) => !(row.description || row.asset_paths?.length || row.readme_lead || row.readme_lead_sha256);

export function labelledRows({ json }, read, batches) {
  const errors = [];
  const rows = [];
  const freeze = read("stage1-freeze.json");
  for (const batch of batches) {
    const set = read(`${batch}-set.json`);
    const labels = json(`${batch}-labels.json`);
    if (!set || !labels) {
      errors.push(`no ${batch}-set.json and ${batch}-labels.json in the sweep folder`);
      continue;
    }
    if (labels.set_sha256 !== sha256(set)) errors.push(`${batch}-labels.json was imported for another ${batch} set`);
    if (!freeze || labels.stage1_freeze_sha256 !== sha256(freeze)) errors.push(`${batch}-labels.json was not imported under stage1-freeze.json: the ladder is frozen before any label is read`);
    const bound = (r) => ["id", "stratum", "order_rank", "repo", "inputs_sha256", "qgs_sha256"].map((k) => r?.[k]);
    if (canonical((labels.rows ?? []).map(bound)) !== canonical((JSON.parse(set).rows ?? []).map(bound))) {
      errors.push(`${batch}-labels.json does not hold exactly the rows of ${batch}-set.json`);
    }
    if (labels.complete !== labels.rows?.length) errors.push(`the user labelled ${labels.complete} of ${labels.rows?.length} ${batch} rows`);
    for (const row of labels.rows ?? []) {
      const decision = row?.user?.decision;
      if (decision !== "eligible" && !EXCLUDE_CODES.some((code) => decision === `excluded: ${code}`)) {
        errors.push(`${batch}-labels.json row ${row?.id} holds the decision ${JSON.stringify(decision)}, not eligible or excluded: <code>`);
      }
    }
    rows.push(...(labels.rows ?? []).map((r) => ({ ...r, batch })));
  }
  return { errors, rows };
}

export const interval = (k, n) => [lowerBound(k, n, 0.025), 1 - lowerBound(n - k, n, 0.025)];

export const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function figureLine(text, parts, prefix = false) {
  const values = parts.filter(Array.isArray);
  const pattern = parts.map((p) => (Array.isArray(p) ? "(-?\\d+\\.\\d+)" : escapeRegex(p))).join("");
  const found = text.match(new RegExp(`^${pattern}${prefix ? "" : "$"}`, "m"));
  return Boolean(found) && values.every(([value, digits], i) => Math.abs(Number(found[i + 1]) - value) <= 0.5 * 10 ** -digits + 1e-9);
}

export const upperBound = (k, n) => 1 - lowerBound(n - k, n);
export const hashedSample = (pool, size, seed) => pool.map((r) => [sha256(`${seed}:${r}`), r]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, size).map(([, r]) => r).sort((a, b) => a - b);
