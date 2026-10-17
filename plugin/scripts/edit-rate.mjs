import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { EDIT_LOG } from "./edit-log.mjs";

const KEPT = new Set(["unchanged", "trimmed"]);

export function isoWeek(timestamp) {
  const date = new Date(timestamp);
  const day = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 3));
  const week = Math.ceil(((thursday - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function computeRates(entries) {
  const rows = new Map();
  for (const entry of entries) {
    if (!["unchanged", "trimmed", "edited", "cut", "added"].includes(entry.label)) continue;
    const channel = entry.channel ?? (entry.pr ? "pr-comment" : "unknown");
    const key = `${channel} ${isoWeek(entry.ts)}`;
    const row = rows.get(key) ?? { channel, week: isoWeek(entry.ts), kept: 0, edited: 0, cut: 0, added: 0 };
    if (KEPT.has(entry.label)) row.kept += 1;
    else row[entry.label] += 1;
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((row) => ({ ...row, rate: row.kept + row.edited + row.cut ? row.kept / (row.kept + row.edited + row.cut) : null }))
    .sort((a, b) => a.channel.localeCompare(b.channel) || a.week.localeCompare(b.week));
}

function main([path = EDIT_LOG]) {
  if (!existsSync(path)) {
    console.log(`no edit log yet at ${path}; it starts with the first draft posted through a tedy write path`);
    return 0;
  }
  const entries = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  console.log("channel | week | kept (unchanged or trimmed) | edited | cut | added | kept rate");
  for (const row of computeRates(entries)) console.log(`${row.channel} | ${row.week} | ${row.kept} | ${row.edited} | ${row.cut} | ${row.added} | ${row.rate === null ? "-" : `${Math.round(row.rate * 100)}%`}`);
  return 0;
}

export function run() {
  process.exit(main(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
