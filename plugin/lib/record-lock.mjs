import { createHash } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readlinkSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { logGate, logRefusal } from "./hook-io.mjs";
import { STATE_DIR } from "./state-dir.mjs";

const FOREIGN_LOCK_MS = 30 * 60 * 1000;

const digest = (key) => createHash("sha256").update(key).digest("hex").slice(0, 16);

export const lockPath = (key, state = STATE_DIR) => join(state, "locks", `${digest(key)}.lock`);

export const ledgerPath = (key, state = STATE_DIR) => join(state, "records", `${digest(key)}.jsonl`);

function fromProc(read) {
  try {
    return read();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES") return null;
    throw error;
  }
}

const startOf = (pid) =>
  fromProc(() => {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  });

const OWN_NS = fromProc(() => readlinkSync("/proc/self/ns/pid"));
const OWN_START = startOf(process.pid);
const COMMAND = [basename(process.argv[1] ?? "") || "node", process.argv[2]].filter(Boolean).join(" ");

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function readLock(path) {
  let text;
  let mtimeMs;
  try {
    text = readFileSync(path, "utf8");
    mtimeMs = statSync(path).mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let lock = null;
  try {
    const parsed = JSON.parse(text);
    if (Number.isInteger(parsed?.pid) && parsed.pid > 0) lock = parsed;
  } catch {
    lock = null;
  }
  return { text, mtimeMs, lock };
}

function stale({ lock, mtimeMs }, now) {
  if (!lock || lock.ns !== OWN_NS) return now - mtimeMs > FOREIGN_LOCK_MS;
  if (!alive(lock.pid)) return true;
  const live = typeof lock.start === "string" ? startOf(lock.pid) : null;
  return live !== null && live !== lock.start;
}

function create(path, content) {
  let fd;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

function unlinkIfSame(path, text) {
  if (readLock(path)?.text !== text) return false;
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return true;
}

const heldRefusal = (key, held) =>
  `refused: ${key} is being written by pid ${held?.lock?.pid ?? "unknown"} (${held?.lock?.command ?? "unknown command"}) since ${held?.lock?.at ?? (held ? new Date(held.mtimeMs).toISOString() : "a moment ago")}; nothing was written. Run this command again when it finishes.`;

function tryAcquire(key) {
  const path = lockPath(key);
  mkdirSync(dirname(path), { recursive: true });
  const content = JSON.stringify({ key, pid: process.pid, ns: OWN_NS, start: OWN_START, at: new Date().toISOString(), command: COMMAND });
  if (create(path, content)) return { path, content };
  const held = readLock(path);
  if ((held === null || (stale(held, Date.now()) && unlinkIfSame(path, held.text))) && create(path, content)) return { path, content };
  return { held: readLock(path) ?? held };
}

function acquire(key) {
  const got = tryAcquire(key);
  if (got.path) return got;
  const reason = heldRefusal(key, got.held);
  logRefusal("lock", reason);
  throw new Error(reason);
}

export async function withRecords(keys, fn) {
  const sorted = [...new Set(keys)].sort();
  const held = [];
  try {
    for (const key of sorted) held.push({ key, ...acquire(key) });
    let done = false;
    const recorded = () => {
      if (done) return;
      done = true;
      const at = new Date().toISOString();
      for (const key of sorted) {
        try {
          mkdirSync(dirname(ledgerPath(key)), { recursive: true });
          appendFileSync(ledgerPath(key), `${JSON.stringify({ at, key, command: COMMAND, pid: process.pid })}\n`);
        } catch (error) {
          process.stderr.write(`warning: written, but the ledger line for ${key} could not be appended (${error.message})\n`);
          logGate({ hook: "record-lock", decision: "ledger-append-failed", key, command: COMMAND, error: error.message });
        }
      }
    };
    return await fn(recorded);
  } finally {
    const stuck = held.flatMap(({ key, path, content }) => {
      try {
        unlinkIfSame(path, content);
        return [];
      } catch (error) {
        return [{ key, path, error }];
      }
    });
    for (const { key, path, error } of stuck) {
      process.stderr.write(`warning: the lock for ${key} could not be released (${error.message}); remove ${path} if the next write on ${key} refuses\n`);
      logGate({ hook: "record-lock", decision: "lock-release-failed", key, path, command: COMMAND, error: error.message });
    }
  }
}
