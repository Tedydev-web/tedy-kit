import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { launchRecordPath, readJob, readRecord, updateRecord } from "./job-files.mjs";
import { isUserPrompt, logGate, readHookInput } from "./hook-io.mjs";
import { STATE_DIR } from "./state-dir.mjs";

const LAUNCH_FORM = /^Job file ("(?:[^"\\\n]|\\.)*")/;
const JOB_PATH = /^\/(?:.*\/)?plans\/jobs\/\d{6}-\d{4}-(pm|dev|review|devops)-[a-z0-9-]+\.md$/;
const JOB_AGENT = /^tedy:(pm|dev|review|devops)$/;
const SAFE_ID = /^[\w-]+$/;
const TRANSCRIPT_HEAD = 1 << 20;
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
  const info = processInfo(record.pid);
  return Boolean(info?.claude) && info.start === record.pid_start;
}

export const cockpitAlive = (record) => alive({ pid: record?.cockpit_pid, pid_start: record?.cockpit_pid_start });

export const agentsOf = (record) => ({ ...record?.agents, ...(record?.agent_id && { [record.agent_id]: record.state }) });

const knows = (record, agent) => Object.hasOwn(agentsOf(record), agent);

export const withAgentState = (record, agent, state) => (agent === record.agent_id ? { ...record, state } : { ...record, agents: { ...record.agents, [agent]: state } });

export const busyAgents = (record) => Object.entries(agentsOf(record)).filter(([, state]) => state !== "idle" && state !== "stopped");

export const agentRunning = (record) => busyAgents(record).length > 0 && cockpitAlive(record);

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

const recordOfAgent = (dir, agent) => findRecord(dir, (record) => knows(record, agent));

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

function agentTranscript({ agent_transcript_path: given, transcript_path: main, session_id: session, agent_id: agent }) {
  if (typeof given === "string" && isAbsolute(given)) return given;
  if (typeof main !== "string" || !isAbsolute(main) || !SAFE_ID.test(agent)) return null;
  if (basename(main) === `agent-${agent}.jsonl`) return main;
  return SAFE_ID.test(session ?? "") ? join(dirname(main), session, "subagents", `agent-${agent}.jsonl`) : null;
}

function launchedJobFile(transcript) {
  if (!transcript || !existsSync(transcript)) return null;
  const [, quoted] = firstPrompt(transcript)?.match(LAUNCH_FORM) ?? [];
  const file = quoted ? unquoted(quoted) : null;
  const role = typeof file === "string" ? file.match(JOB_PATH)?.[1] : undefined;
  return role ? { file, role } : null;
}

export function jobOfAgent(input, dir = STATE_DIR) {
  const role = input.agent_type?.match(JOB_AGENT)?.[1];
  if (!role || !input.agent_id) return null;
  const bound = recordOfAgent(dir, input.agent_id);
  if (bound) return bound.record.role === role ? bound.record : null;
  const launched = launchedJobFile(agentTranscript(input));
  if (launched?.role !== role || !existsSync(launched.file)) return null;
  const record = readRecord(launchRecordPath(launched.file, dir));
  return record?.role === role ? record : null;
}

function bind(input, role, dir, now, claude) {
  if (recordOfAgent(dir, input.agent_id)) return;
  const transcript = agentTranscript(input);
  const launched = launchedJobFile(transcript);
  if (launched?.role !== role || !existsSync(launched.file)) return;
  const { file } = launched;
  const path = launchRecordPath(file, dir);
  if (!readRecord(path)) return;
  const cockpit = claude();
  updateRecord(path, (record) => {
    if (!record || record.state === "closed" || knows(record, input.agent_id) || readJob(file).status === "closed") return undefined;
    if (record.agent_id) return withAgentState(record, input.agent_id, "running");
    return { ...record, agent_id: input.agent_id, session_id: input.session_id, transcript_path: transcript, ...(cockpit && { cockpit_pid: cockpit.pid, cockpit_pid_start: cockpit.start }), bound_at: now };
  });
}

function nextState({ hook_event_name: event, notification_type: type }) {
  if (event === "Notification") return type === "permission_prompt" ? "waiting: permission" : undefined;
  if (event === "SubagentStop") return "idle";
  if (event === "PostToolUse") return "running";
  return undefined;
}

function stopped(input, dir, now) {
  if (input.hook_event_name !== "PostToolUse" || input.tool_name !== "TaskStop") return;
  const named = Object.values(input.tool_input ?? {}).filter((value) => typeof value === "string" && value);
  const namedAgent = (record) => named.find((value) => knows(record, value));
  const found = findRecord(dir, (record) => record.session_id === input.session_id && Boolean(namedAgent(record)));
  if (!found) return;
  updateRecord(found.path, (record) => {
    const agent = record?.session_id === input.session_id ? namedAgent(record) : undefined;
    return agent ? { ...withAgentState(record, agent, "stopped"), last_event_at: now } : undefined;
  });
}

export function handle(input, { dir = STATE_DIR, now = new Date().toISOString(), claude = claudeProcess } = {}) {
  if (!input.agent_id) {
    stopped(input, dir, now);
    return;
  }
  const role = input.agent_type?.match(JOB_AGENT)?.[1];
  if (role) bind(input, role, dir, now, claude);
  const found = recordOfAgent(dir, input.agent_id);
  if (!found) return;
  const state = nextState(input);
  const cockpit = cockpitAlive(found.record) ? null : claude();
  updateRecord(found.path, (record) => {
    if (!record || !knows(record, input.agent_id)) return undefined;
    const current = agentsOf(record)[input.agent_id];
    const next = state && current !== "stopped" ? state : current;
    return { ...withAgentState(record, input.agent_id, next), ...(cockpit && !cockpitAlive(record) && { cockpit_pid: cockpit.pid, cockpit_pid_start: cockpit.start }), last_event_at: now };
  });
}

export function run() {
  const input = readHookInput();
  try {
    handle(input);
  } catch (error) {
    logGate({ hook: "job-session", decision: "skip-on-error", event: input.hook_event_name, error: error.message });
    process.stderr.write(`tedy job status: ${error.message}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
