import { createHash } from "node:crypto";
import { closeSync, existsSync, fchmodSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { HANDOFF_KEYS, parse } from "./handoff.mjs";
import { withLockSync } from "./record-lock.mjs";
import { STATE_DIR } from "./state-dir.mjs";

const temporary = (file) => join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);

export function writeAtomic(file, text, mode) {
  const tmp = temporary(file);
  if (mode === undefined) writeFileSync(tmp, text);
  else {
    const fd = openSync(tmp, "w", mode);
    try {
      fchmodSync(fd, mode);
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
  }
  renameSync(tmp, file);
}

export function createAtomic(file, text) {
  const tmp = temporary(file);
  writeFileSync(tmp, text);
  try {
    linkSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export const launchRecordPath = (file, dir = STATE_DIR) => join(dir, "jobs", `${createHash("sha256").update(realpathSync(file)).digest("hex").slice(0, 32)}.json`);

export function recordLaunch(file, launch, dir = STATE_DIR) {
  mkdirSync(join(dir, "jobs"), { recursive: true });
  writeAtomic(launchRecordPath(file, dir), `${JSON.stringify({ file: realpathSync(file), ...launch })}\n`);
}

export const writeRecord = (path, record) => writeAtomic(path, `${JSON.stringify(record)}\n`);

export function readRecord(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`the launch record ${path} cannot be read (${error.message})`);
  }
}

const lockedRecord = (path, fn) => withLockSync(`launch-record:${path}`, fn, { state: dirname(dirname(path)) });

export function updateRecord(path, change) {
  return lockedRecord(path, () => {
    const next = change(readRecord(path));
    if (next === null) rmSync(path, { force: true });
    else if (next !== undefined) writeRecord(path, next);
    return next;
  });
}

export const JOB_KEYS = Object.freeze([...HANDOFF_KEYS, "cwd", "repo", "branch", "base", "worktree", "worktree_owner"]);
export const JOB_ROLES = Object.freeze(["pm", "dev", "review", "devops"]);
const HEADER_KEYS = [...JOB_KEYS, "permission_mode", "session_id"];
const HEADER = new RegExp(`^(${HEADER_KEYS.join("|")}): `);

export const jobsDir = (map) => join(map.paths[0], "plans", "jobs");

export function setKey(text, key, value) {
  const lines = text.split("\n");
  const end = lines.findIndex((line) => !HEADER.test(line));
  const at = lines.slice(0, end).findIndex((line) => line.startsWith(`${key}: `));
  if (at === -1) lines.splice(end, 0, `${key}: ${value}`);
  else lines[at] = `${key}: ${value}`;
  return lines.join("\n");
}

export function withoutKey(text, key) {
  const lines = text.split("\n");
  const end = lines.findIndex((line) => !HEADER.test(line));
  return lines.filter((line, index) => index >= end || !line.startsWith(`${key}: `)).join("\n");
}

export const withSection = (text, heading, body) => `${text.replace(/\s+$/, "")}\n\n## ${heading}\n\n${body.trim()}\n`;

function fields(text) {
  const found = parse(text, HEADER_KEYS);
  const role = found.to?.startsWith("tedy:") ? found.to.slice("tedy:".length) : null;
  return JOB_ROLES.includes(role) && found.from === "cockpit" && found.status ? { ...found, role } : null;
}

export function readJob(file) {
  const path = resolve(file);
  const text = readFileSync(path, "utf8");
  const job = fields(text);
  if (!job) throw new Error(`${file} is not a job file: it needs to: tedy:<role>, from: cockpit and status: lines`);
  return { path, text, ...job };
}

export function listJobs(map, { closed = false } = {}) {
  const dir = jobsDir(map);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && statSync(join(dir, name)).isFile())
    .sort()
    .flatMap((name) => {
      const job = fields(readFileSync(join(dir, name), "utf8"));
      return job && (closed || job.status !== "closed") ? [{ path: join(dir, name), ...job }] : [];
    });
}

export function age(created, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(created)) / 60_000);
  if (!Number.isFinite(minutes)) return "unknown age";
  if (minutes < 60) return `${Math.max(minutes, 0)}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}
