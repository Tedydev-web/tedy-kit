import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { snapshotPath } from "./draft-lint.mjs";
import { STATE_DIR } from "./hook-io.mjs";

export const EDIT_LOG = join(STATE_DIR, "edit-log.jsonl");
const normalise = (text) => text.replace(/\s+/g, " ").trim();

export function labelText(drafted, posted) {
  if (normalise(posted) === normalise(drafted)) return "unchanged";
  const draftLines = new Set(drafted.split("\n").map(normalise).filter(Boolean));
  return posted.split("\n").map(normalise).filter(Boolean).every((line) => draftLines.has(line)) ? "trimmed" : "edited";
}

export function frozenOriginal(file) {
  return existsSync(snapshotPath(file)) ? readFileSync(snapshotPath(file), "utf8") : null;
}

export function appendEditLog(entries, path = EDIT_LOG) {
  mkdirSync(dirname(path), { recursive: true });
  for (const entry of entries) appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

export function logPostedText(channel, file, key, posted) {
  const original = frozenOriginal(file);
  appendEditLog([{ channel, key: String(key), label: original === null ? "no-original" : labelText(original.trim(), posted), draft: original, posted }]);
}
