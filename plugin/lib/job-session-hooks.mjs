import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { herdr, HerdrError } from "./job-adapters.mjs";
import { launchRecordPath, readJob, readRecord, updateRecord } from "./job-files.mjs";
import { isUserPrompt, logGate, readHookInput } from "./hook-io.mjs";
import { STATE_DIR } from "./state-dir.mjs";

const LAUNCH_FORM = /^(?:<command-message>[^<]*<\/command-message>\s*<command-name>\/tedy:[a-z-]+<\/command-name>\s*<command-args>job |\/tedy:[a-z-]+ job |Job file )(?:("(?:[^"\\\n]|\\.)*")|(\/[^\s"'\\]*?\/plans\/jobs\/\d{6}-\d{4}-(?:pm|dev|review|devops)-[a-z0-9-]+\.md))/;
const JOB_PATH = /^\/(?:.*\/)?plans\/jobs\/\d{6}-\d{4}-(pm|dev|review|devops)-[a-z0-9-]+\.md$/;
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

export function ancestors(from = process.ppid) {
  const chain = [];
  for (let pid = from; pid > 1 && !chain.some((entry) => entry.pid === pid); ) {
    const info = processInfo(pid);
    if (!info) break;
    chain.push({ pid, start: info.start });
    pid = info.ppid;
  }
  return chain;
}

export function alive(record) {
  if (!Number.isInteger(record?.pid) || record.pid <= 1) return false;
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code !== "EPERM") throw error;
  }
  const info = processInfo(record.pid);
  return Boolean(info?.claude) && info.start === record.pid_start;
}

function findRecord(dir, matches) {
  const jobs = join(dir, "jobs");
  if (!existsSync(jobs)) return null;
  for (const entry of readdirSync(jobs, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(jobs, entry.name);
    try {
      const record = readRecord(path);
      if (record && matches(record)) return { path, record };
    } catch (error) {
      logGate({ hook: "job-session", decision: "record-skipped", error: error.message });
    }
  }
  return null;
}

export const recordOfSession = (dir, session) => (session ? findRecord(dir, (record) => record.session_id === session) : null);

export const recordOfProcesses = (dir, processes) => (processes.length ? findRecord(dir, (record) => processes.some(({ pid, start }) => record.pid === pid && record.pid_start === start)) : null);

function firstPrompt(transcript) {
  let descriptor;
  try {
    descriptor = openSync(transcript, "r");
    const buffer = Buffer.alloc(TRANSCRIPT_HEAD);
    const length = readSync(descriptor, buffer, 0, TRANSCRIPT_HEAD, 0);
    for (const line of buffer.toString("utf8", 0, length).split("\n")) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isUserPrompt(entry)) continue;
      const { content } = entry.message;
      return typeof content === "string" ? content : content.find((block) => block?.type === "text").text;
    }
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function unquoted(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function launchedJobFile(transcript) {
  if (!transcript || !existsSync(transcript)) return null;
  const [, quotedFile, bare] = firstPrompt(transcript)?.match(LAUNCH_FORM) ?? [];
  const file = quotedFile ? unquoted(quotedFile) : bare;
  const role = typeof file === "string" ? file.match(JOB_PATH)?.[1] : undefined;
  return role ? { file, role } : null;
}

function bind(input, dir, now, claude, warnings) {
  const role = input.agent_type?.match(JOB_AGENT)?.[1];
  if (!role || input.agent_id || recordOfSession(dir, input.session_id)) return;
  const launched = launchedJobFile(input.transcript_path);
  if (launched?.role !== role || !existsSync(launched.file)) return;
  const { file } = launched;
  const path = launchRecordPath(file, dir);
  if (!readRecord(path)) return;
  const found = claude();
  let bound = null;
  updateRecord(path, (record) => {
    bound = record?.session_id ?? null;
    if (!record || bound || readJob(file).status === "closed") return undefined;
    return { ...record, session_id: input.session_id, transcript_path: input.transcript_path, ...(found && { pid: found.pid, pid_start: found.start }), ...(typeof input.cwd === "string" && isAbsolute(input.cwd) && { session_cwd: input.cwd }), bound_at: now };
  });
  if (bound && bound !== input.session_id) warnings.push(`${file} is already bound to session ${bound}; this session is not tracked as that job`);
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
  const state = input.agent_id ? undefined : nextState(input);
  const started = input.hook_event_name === "SessionStart" ? claude() : null;
  let before = null;
  updateRecord(found.path, (record) => {
    if (record?.session_id !== input.session_id) return undefined;
    before = record;
    return { ...record, ...(started && { pid: started.pid, pid_start: started.start }), ...(state && { state }), last_event_at: now };
  });
  if (before) notifyHerdr(before, state, env, warnings);
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
