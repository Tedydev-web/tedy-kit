import { existsSync, linkSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { HANDOFF_KEYS, parse } from "./handoff.mjs";

const temporary = (file) => join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);

export function writeAtomic(file, text) {
  const tmp = temporary(file);
  writeFileSync(tmp, text);
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

export const JOB_KEYS = Object.freeze([...HANDOFF_KEYS, "cwd", "permission_mode", "session_id"]);
export const JOB_ROLES = Object.freeze(["pm", "dev", "review", "devops"]);
const HEADER = new RegExp(`^(${JOB_KEYS.join("|")}): `);

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
  const found = parse(text, JOB_KEYS);
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

export function listJobs(map) {
  const dir = jobsDir(map);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && statSync(join(dir, name)).isFile())
    .sort()
    .flatMap((name) => {
      const job = fields(readFileSync(join(dir, name), "utf8"));
      return job && job.status !== "closed" ? [{ path: join(dir, name), ...job }] : [];
    });
}

export function age(created, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(created)) / 60_000);
  if (!Number.isFinite(minutes)) return "unknown age";
  if (minutes < 60) return `${Math.max(minutes, 0)}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}
