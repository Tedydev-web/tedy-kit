import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bashInputs, classify } from "./git-gate.mjs";
import { route } from "../lib/handoff.mjs";
import { boundJob } from "../lib/job-session-hooks.mjs";
import { ask, gateSwitches, logGate, readHookInput, STATE_DIR } from "../lib/hook-io.mjs";
import { resolveMap } from "../lib/project-map.mjs";
import { expandHome, shellWords, tokenize, walkCommands } from "../lib/shell-segments.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SCRIPT_WRITES = [
  { kind: "tracker-status", pattern: /^(?=[\s\S]*--apply\b)(?![\s\S]*--(?:priority|estimate|start|due)\b)[\s\S]*?openproject\.mjs["']?\s+set\b/ },
  { kind: "tracker", pattern: /openproject\.mjs["']?\s+apply\b|pg\.py["']?\s+set\b|^(?=[\s\S]*--apply\b)[\s\S]*?(?:openproject\.mjs["']?\s+(?:set|comment|comment-edit|relation|relation-delete|rollback)|op_apply\.py|pg\.py["']?\s+(?:sync|rollback))\b/ },
  { kind: "doc-figma", pattern: /gdoc-comments\.mjs["']?\s+(reply|anchor|post|edit|delete)\b|figma-comments\.mjs["']?\s+(post|reply|delete)\b|doc-comment-file\.mjs/ },
  { kind: "code", pattern: /github-write\.mjs["']?\s+pr-body\b/ },
  { kind: "pr-review", pattern: /github-write\.mjs["']?\s+(post|resolve|unresolve|edit|minimize)\b/ },
];
const OWNER = { tracker: "pm", "tracker-status": "pm", "doc-figma": "pm", "pr-review": "review", code: "dev" };
const WHAT = {
  tracker: "writing to the tracker",
  "tracker-status": "changing a work package's status or assignee",
  "doc-figma": "Doc or Figma comments",
  "pr-review": "posting or resolving PR review comments",
  code: "changing or committing product code",
};
const FORBIDDEN = {
  dev: new Set(["tracker", "doc-figma", "pr-review"]),
  devops: new Set(["tracker", "doc-figma", "pr-review"]),
  review: new Set(["code", "tracker", "doc-figma"]),
  pm: new Set(["code", "pr-review"]),
  dispatch: new Set(["code", "tracker", "tracker-status", "doc-figma", "pr-review"]),
  reader: new Set(["code", "tracker", "tracker-status", "doc-figma", "pr-review"]),
  cockpit: new Set(["code"]),
};
export const AGENT_ROLES = { "tedy:pm": "pm", "tedy:dev": "dev", "tedy:review": "review", "tedy:devops": "devops" };
const JOB_ROLES = new Set(Object.values(AGENT_ROLES));
const SESSION_ROLES = join(STATE_DIR, "session-roles");
const SAFE_ID = /^[\w-]+$/;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function storedRole(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function rememberRole(file, role, replace) {
  try {
    const stored = storedRole(file);
    if (stored === role || (stored && !replace)) {
      const now = new Date();
      utimesSync(file, now, now);
      return;
    }
    mkdirSync(SESSION_ROLES, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, role);
    renameSync(temporary, file);
    const now = Date.now();
    for (const name of readdirSync(SESSION_ROLES)) {
      const at = statSync(join(SESSION_ROLES, name), { throwIfNoEntry: false })?.mtimeMs;
      if (at !== undefined && now - at > WEEK_MS) rmSync(join(SESSION_ROLES, name), { force: true });
    }
  } catch (error) {
    logGate({ hook: "role-gate", decision: "session-role-unwritten", error: error.message });
  }
}

export function agentRole(input) {
  const file = typeof input.session_id === "string" && SAFE_ID.test(input.session_id) ? join(SESSION_ROLES, input.session_id) : null;
  if (!input.agent_id) {
    if (!Object.hasOwn(AGENT_ROLES, input.agent_type)) return null;
    const role = AGENT_ROLES[input.agent_type];
    if (file) rememberRole(file, role, input.source !== "compact");
    else logGate({ hook: "role-gate", decision: "session-role-unsafe-id", agent_type: input.agent_type, session: String(input.session_id).slice(0, 80) });
    return { role, label: input.agent_type };
  }
  let parent;
  try {
    parent = file && storedRole(file);
  } catch (error) {
    logGate({ hook: "role-gate", decision: "session-role-unreadable", agent_type: input.agent_type, error: error.message });
    return { role: "reader", label: input.agent_type ?? "subagent" };
  }
  if (!JOB_ROLES.has(parent)) return null;
  return input.agent_type === "tedy:reviewer" ? { role: "reader", label: input.agent_type } : { role: parent, label: input.agent_type ?? "subagent" };
}

const jobAgentType = (input) => Boolean(input.agent_id) && Object.hasOwn(AGENT_ROLES, input.agent_type);

export function spawnedRole(input, map, list = listSessions) {
  if (!jobAgentType(input) || map?.jobs !== true || !boundJob(input)) return null;
  if (map.sessions?.length && roleOf(map, sessionName(input.session_id, list()))) return null;
  return { role: AGENT_ROLES[input.agent_type], label: input.agent_type };
}

function repoOf(map, path) {
  const root = map.paths[0];
  for (const repo of map.repos ?? []) {
    const inside = relative(join(root, repo.path), path);
    if (!inside.startsWith("..") && !isAbsolute(inside)) return { repo: repo.path, inside };
  }
  const shared = relative(join(root, "worktrees"), path);
  if (!shared.startsWith("..") && !isAbsolute(shared)) return { repo: null, inside: shared };
  return null;
}

const isCode = (hit) => hit && !hit.inside.split("/").includes("plans") && !hit.inside.endsWith(".md");

export function classifyActions(input, map, role) {
  if (!role && !map.sessions?.length && !map.jobs) return [];
  const cwd = input.cwd ?? process.cwd();
  if (EDIT_TOOLS.has(input.tool_name)) {
    const path = resolve(cwd, input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "");
    const hit = repoOf(map, path);
    return isCode(hit) ? [{ kind: "code", repo: hit.repo }] : [];
  }
  const actions = [];
  for (const item of bashInputs(input).inputs ?? []) {
    if (item.tool_name !== "Bash") continue;
    for (const { text: segment, dir } of walkCommands(item.tool_input?.command ?? "", item.cwd ?? cwd).parts) {
      const action = classify(segment, dir);
      if (action.kind === "cd") continue;
      const script = SCRIPT_WRITES.find((write) => write.pattern.test(shellWords(segment)));
      if (script) actions.push({ kind: script.kind, repo: null, script: true });
      else if (action.kind === "commit" || action.kind === "push") {
        const hit = repoOf(map, action.dir);
        if (hit) actions.push({ kind: "code", repo: hit.repo });
      }
    }
  }
  return actions;
}

export const classifyAction = (input, map, role) => classifyActions(input, map, role)[0] ?? null;

const JOB_SCRIPT = /(?:^|\/)job\.mjs$/;

function jobScriptCalls(input) {
  const cwd = input.cwd ?? process.cwd();
  const calls = [];
  for (const item of bashInputs(input).inputs ?? []) {
    if (item.tool_name !== "Bash") continue;
    for (const { text, dir } of walkCommands(item.tool_input?.command ?? "", item.cwd ?? cwd).parts) {
      const tokens = tokenize(text);
      tokens.forEach((token, index) => {
        if (JOB_SCRIPT.test(token)) calls.push({ args: tokens.slice(index + 1), dir });
      });
    }
  }
  return calls;
}

export function closeReason(input, who) {
  if (!who) return null;
  const files = jobScriptCalls(input).filter(({ args }) => args[0] === "close").map(({ args, dir }) => (args[1] ? resolve(dir, expandHome(args[1])) : "with no job file"));
  if (!files.length) return null;
  return `tedy role gate: this is a ${who.role} job (${who.label}); job.mjs close ${[...new Set(files)].join(", ")} marks that job closed and removes its worktree, which belongs to the cockpit. Allow it only if the user asked for it here.`;
}

export const roleOf = (map, name) => (map.sessions ?? []).find((session) => session.name === name)?.role ?? null;

export function sessionName(sessionId, list) {
  return list.find((session) => session.sessionId === sessionId)?.name ?? null;
}

function ownerSession(map, role, repo) {
  try {
    return route(map, role, repo ?? undefined).name;
  } catch {
    return null;
  }
}

export function decide(map, name, action) {
  const role = roleOf(map, name);
  if (!role || !action || !FORBIDDEN[role]?.has(action.kind)) return null;
  const owner = OWNER[action.kind];
  const target = ownerSession(map, owner, action.repo);
  return `tedy role gate: this is "${name}", the ${role} session; ${WHAT[action.kind]} belongs to the ${owner} session${target ? ` "${target}"` : ""}. Hand it over with what you found and where, per ${fileURLToPath(new URL("../shared/handoff.md", import.meta.url))}, unless the user allows this one here.`;
}

const JOBS_DOC = fileURLToPath(new URL("../shared/jobs.md", import.meta.url));

export function agentReason(who, action, map = {}) {
  if (!FORBIDDEN[who.role]?.has(action.kind)) return null;
  const owner = OWNER[action.kind];
  if (who.role === "cockpit") return `tedy role gate: this is the cockpit of ${map.name}; ${WHAT[action.kind]} belongs to the ${owner} role. Start a ${owner} job per ${JOBS_DOC}, unless the user allows this one here.`;
  const next = map.jobs ? `Write a card, or a question card to start a ${owner} job, per ${JOBS_DOC}` : "Leave a draft under plans/drafts for it";
  return `tedy role gate: this is a ${who.role} job (${who.label}); ${WHAT[action.kind]} belongs to the ${owner} role. ${next}, unless the user allows this one here.`;
}

export const cockpitCard = (map) => `This is the cockpit of ${map.name}: start jobs per ${JOBS_DOC}, approve with /tedy:pending.`;

export function jobCard(map, who, gateOn = true) {
  if (map.jobs) return `Role: this session is a ${who.role} job (${who.label}) of ${map.name}. Work it per ${JOBS_DOC}, section "Job": read the job file your prompt names, turn each decision into a question card and each write that needs approval into a publish card, and end with job.mjs done or stop.${gateOn ? " A write that belongs to another role asks the user first." : ""}`;
  return `Role: this session is a ${who.role} job (${who.label}) of ${map.name}. When work for another role turns up (a PRD or Figma question, a tracker task, a PR review, code another role owns), stop looking into it, write what you saw and where (file:line, PRD locator, frame) into a draft under plans/drafts, and return to this job's task; the owning role does the research.${gateOn ? " A write that belongs to another role asks the user first." : ""}`;
}

export function roleCard(map, name, gateOn = true) {
  const role = roleOf(map, name);
  if (!role) return "";
  const repos = (map.sessions.find((session) => session.name === name).repos ?? []).join(", ");
  const others = (map.sessions ?? []).filter((session) => session.name !== name).map((session) => `"${session.name}" (${session.role}${session.repos ? `: ${session.repos.join(", ")}` : ""})`).join(", ");
  if (role === "dispatch") return `Role: this session is "${name}", the dispatch session of ${map.name}. It does no role work itself and publishes nothing. The role sessions are ${others}. Route every request per the dispatch section of ${fileURLToPath(new URL("../shared/handoff.md", import.meta.url))}: hand it to the owning session without the hand-off question, ask only when the owner is unclear or the request spans two roles, and relay each session's reply in one line.`;
  return `Role: this session is "${name}", the ${role} session of ${map.name}${repos ? ` for ${repos}` : ""}. The other sessions are ${others}. When work for another role turns up (a PRD or Figma question, a tracker task, a PR review, code in another session's repository), stop looking into it, write what you saw and where (file:line, PRD locator, frame) into a hand-off per ${fileURLToPath(new URL("../shared/handoff.md", import.meta.url))}, and return to this session's task; the receiving session does the research.${gateOn ? " A write that belongs to another role asks the user first." : ""}`;
}

export function listSessions() {
  return JSON.parse(execFileSync("claude", ["agents", "--json", "--all"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }));
}

export function judge(input, map, list = listSessions, who = agentRole(input) ?? spawnedRole(input, map, list)) {
  const actions = classifyActions(input, map, who?.role);
  if (!actions.length) return null;
  const first = (reasonOf) => {
    for (const action of actions) {
      const reason = reasonOf(action);
      if (reason) return { action, reason };
    }
    return { action: actions[0], reason: null };
  };
  if (who) {
    const { action, reason } = first((each) => agentReason(who, each, map));
    return { kind: action.kind, role: who.role, session: null, reason };
  }
  const name = map.jobs && !map.sessions?.length ? null : sessionName(input.session_id, list());
  if (map.jobs && !roleOf(map, name)) {
    const { action, reason } = first((each) => (each.script ? null : agentReason({ role: "cockpit" }, each, map)));
    return { kind: action.kind, role: "cockpit", session: null, reason };
  }
  const { action, reason } = first((each) => (name && decide(map, name, each)) || null);
  return { kind: action.kind, role: name && roleOf(map, name), session: name, reason };
}

export function run() {
  const input = readHookInput({ askOnFailure: true });
  try {
    const cwd = input.cwd ?? process.cwd();
    let who = agentRole(input);
    let resolved;
    if (!who && jobAgentType(input)) {
      resolved = resolveMap(cwd);
      who = resolved ? spawnedRole(input, resolved.map) : null;
    }
    const closing = closeReason(input, who);
    if (closing) {
      logGate({ hook: "role-gate", decision: "ask", agent_type: input.agent_type, role: who.role, kind: "job-close", tool: input.tool_name });
      ask(closing);
      return;
    }
    if (!gateSwitches().roleGate) return;
    if (resolved === undefined) resolved = resolveMap(cwd);
    const verdict = resolved && judge(input, resolved.map, listSessions, who);
    if (verdict) {
      logGate({ hook: "role-gate", decision: verdict.reason ? "ask" : "allow", session: verdict.session, agent_type: input.agent_type, role: verdict.role, kind: verdict.kind, tool: input.tool_name });
      if (verdict.reason) ask(verdict.reason);
    }
  } catch (error) {
    logGate({ hook: "role-gate", decision: "ask-on-error", error: error.message });
    ask(`tedy gate: could not check which session role owns this write (${error.message}). Allow it only if the user asked for it, then fix the project map.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
