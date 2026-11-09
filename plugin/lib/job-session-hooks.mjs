import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { herdr, HerdrError } from "./job-adapters.mjs";
import { launchRecordPath, writeRecord } from "./job-files.mjs";
import { isUserPrompt, logGate, readHookInput } from "./hook-io.mjs";
import { STATE_DIR } from "./state-dir.mjs";

const JOB_PATH = /\/[^\s"'\\]*?\/plans\/jobs\/\d{6}-\d{4}-(pm|dev|review|devops)-[a-z0-9-]+\.md/g;
const JOB_AGENT = /^tedy:(pm|dev|review|devops)$/;
const TRANSCRIPT_HEAD = 1 << 20;
const WAITING = { permission_prompt: "waiting: permission", idle_prompt: "waiting: input" };
const GONE = new Set(["ENOENT", "ESRCH"]);

function linuxProcess(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return null;
    const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
    const argv0 = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0];
    return { ppid: Number(fields[1]), start: fields[19], claude: comm === "claude" || basename(argv0) === "claude" };
  } catch (error) {
    if (GONE.has(error.code)) return null;
    throw error;
  }
}

function ps(pid, field) {
  const result = spawnSync("ps", ["-o", field.split(",").map((name) => `${name}=`).join(","), "-p", String(pid)], { encoding: "utf8" });
  if (result.error) throw new Error(`ps -o ${field}= -p ${pid}: ${result.error.message}`);
  return result.status === 0 ? result.stdout.trim() : "";
}

function psProcess(pid) {
  const [, ppid, comm] = ps(pid, "ppid,comm").match(/^(\d+)\s+(.*)$/) ?? [];
  if (!ppid) return null;
  return { ppid: Number(ppid), start: ps(pid, "lstart"), claude: basename(comm) === "claude" };
}

export const processInfo = (pid) => (process.platform === "linux" ? linuxProcess(pid) : psProcess(pid));

export function claudeProcess(from = process.ppid) {
  for (let pid = from, steps = 0; pid > 1 && steps < 64; steps += 1) {
    const info = processInfo(pid);
    if (!info) return null;
    if (info.claude) return { pid, start: info.start };
    pid = info.ppid;
  }
  return null;
}

export function alive(record) {
  if (!Number.isInteger(record?.pid) || record.pid <= 1) return false;
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code !== "EPERM") throw error;
  }
  return processInfo(record.pid)?.start === record.pid_start;
}

function readRecord(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`the launch record ${path} cannot be read (${error.message})`);
  }
}

export function recordOfSession(dir, session) {
  const jobs = join(dir, "jobs");
  if (!session || !existsSync(jobs)) return null;
  for (const entry of readdirSync(jobs, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(jobs, entry.name);
    try {
      const record = readRecord(path);
      if (record?.session_id === session) return { path, record };
    } catch (error) {
      logGate({ hook: "job-session", decision: "record-skipped", error: error.message });
    }
  }
  return null;
}

function promptedJobFiles(transcript) {
  if (!transcript || !existsSync(transcript)) return [];
  let descriptor;
  try {
    descriptor = openSync(transcript, "r");
    const buffer = Buffer.alloc(TRANSCRIPT_HEAD);
    const length = readSync(descriptor, buffer, 0, TRANSCRIPT_HEAD, 0);
    return buffer
      .toString("utf8", 0, length)
      .split("\n")
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line);
          return isUserPrompt(entry) ? [...JSON.stringify(entry.message.content).matchAll(JOB_PATH)] : [];
        } catch {
          return [];
        }
      });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function bind(input, dir, now, claude, warnings) {
  const role = input.agent_type?.match(JOB_AGENT)?.[1];
  if (!role || input.agent_id || recordOfSession(dir, input.session_id)) return;
  for (const [file, named] of promptedJobFiles(input.transcript_path)) {
    if (named !== role || !existsSync(file)) continue;
    const path = launchRecordPath(file, dir);
    const record = readRecord(path);
    if (!record) continue;
    if (record.session_id) {
      if (record.session_id !== input.session_id) warnings.push(`${file} is already bound to session ${record.session_id}; this session is not tracked as that job`);
      return;
    }
    const found = claude();
    writeRecord(path, { ...record, session_id: input.session_id, transcript_path: input.transcript_path, ...(found && { pid: found.pid, pid_start: found.start }), bound_at: now });
    return;
  }
}

function nextState({ hook_event_name: event, notification_type: type, tool_name: tool }) {
  if (event === "Notification") return WAITING[type];
  if (event === "PreToolUse") return tool === "AskUserQuestion" ? "waiting: question" : undefined;
  if (event === "PostToolUse" || event === "SessionStart") return "running";
  if (event === "Stop") return "idle";
  return undefined;
}

function notifyHerdr(record, state, env, warnings) {
  if (env.HERDR_ENV !== "1" || !state?.startsWith("waiting") || state === record.state) return;
  try {
    herdr(["notification", "show", `tedy ${record.role} job: ${state}`, "--body", basename(record.file ?? ""), "--sound", "request"], env);
  } catch (error) {
    if (!(error instanceof HerdrError)) throw error;
    warnings.push(`${error.message}; the job is ${state}`);
  }
}

export function handle(input, { dir = STATE_DIR, now = new Date().toISOString(), claude = claudeProcess, env = process.env } = {}) {
  const warnings = [];
  bind(input, dir, now, claude, warnings);
  const found = recordOfSession(dir, input.session_id);
  if (!found) return warnings;
  const state = nextState(input);
  const started = input.hook_event_name === "SessionStart" ? claude() : null;
  writeRecord(found.path, { ...found.record, ...(started && { pid: started.pid, pid_start: started.start }), ...(state && { state }), last_event_at: now });
  notifyHerdr(found.record, state, env, warnings);
  return warnings;
}

export function run() {
  const input = readHookInput();
  try {
    for (const warning of handle(input)) process.stderr.write(`tedy: ${warning}\n`);
  } catch (error) {
    logGate({ hook: "job-session", decision: "skip-on-error", event: input.hook_event_name, error: error.message });
    process.stderr.write(`tedy job status: ${error.message}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
