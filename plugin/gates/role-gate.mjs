import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bashInputs, classify } from "./git-gate.mjs";
import { jobsDir } from "../lib/job-files.mjs";
import { jobOfAgent } from "../lib/job-session-hooks.mjs";
import { profileDir } from "../lib/profile.mjs";
import { ask, gateSwitches, logGate, readHookInput, STATE_DIR } from "../lib/hook-io.mjs";
import { loadMaps, resolveMap } from "../lib/project-map.mjs";
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

function jobMap(file) {
  const dir = dirname(file);
  return loadMaps().find(({ map }) => map.paths?.length && existsSync(jobsDir(map)) && realpathSync(jobsDir(map)) === dir) ?? null;
}

export function spawnedRole(input, job = jobOfAgent(input)) {
  if (!jobAgentType(input) || !job) return null;
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

export function classifyActions(input, map) {
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

export const classifyAction = (input, map) => classifyActions(input, map)[0] ?? null;

const JOB_SCRIPT = /(?:^|\/)job\.mjs$/;

function bashSegments(input) {
  const cwd = input.cwd ?? process.cwd();
  return (bashInputs(input).inputs ?? []).filter((item) => item.tool_name === "Bash").flatMap((item) => walkCommands(item.tool_input?.command ?? "", item.cwd ?? cwd).parts);
}

function jobScriptCalls(input) {
  const calls = [];
  for (const { text, dir } of bashSegments(input)) {
    const tokens = tokenize(text);
    tokens.forEach((token, index) => {
      if (JOB_SCRIPT.test(token)) calls.push({ args: tokens.slice(index + 1), dir });
    });
  }
  return calls;
}

function gitOutput(text) {
  const tokens = tokenize(text);
  const at = tokens.findIndex((token) => basename(token) === "git");
  return at !== -1 && tokens.slice(at + 1).some((token) => token.startsWith("--output"));
}

const within = (dir, path) => {
  const inside = relative(resolve(dir), path);
  return !inside.startsWith("..") && !isAbsolute(inside);
};

export function kitStateReason(input, who) {
  if (!who) return null;
  const job = `tedy role gate: this is a ${who.role} job (${who.label});`;
  if (EDIT_TOOLS.has(input.tool_name)) {
    const path = resolve(input.cwd ?? process.cwd(), input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "");
    const kit = [["profile", profileDir()], ["state", STATE_DIR]].find(([, dir]) => within(dir, path));
    return kit ? `${job} ${input.tool_name} of ${path} changes the kit's ${kit[0]} dir ${resolve(kit[1])}, which belongs to the cockpit. Allow it only if the user asked for it here.` : null;
  }
  if (!bashSegments(input).some(({ text }) => gitOutput(text))) return null;
  return `${job} git --output writes a file wherever it points, the kit's profile and state dirs included, which belong to the cockpit. Allow it only if the user asked for it here.`;
}

export function closeReason(input, who) {
  if (!who) return null;
  const calls = jobScriptCalls(input).filter(({ args }) => args[0] === "close").map(({ args, dir }) => ({ file: args[1] && !args[1].startsWith("--") ? resolve(dir, expandHome(args[1])) : null, finished: args.includes("--if-finished") }));
  if (!calls.length) return null;
  const names = calls.map(({ file, finished }) => (file ? `${file}${finished ? " --if-finished" : ""}` : finished ? "--if-finished" : "with no job file"));
  const effect = calls.some(({ file, finished }) => finished && !file) ? "closes every done job that no card names and removes its worktree" : calls.some(({ finished }) => finished) ? "closes that job once it is done and no card names it, and removes its worktree" : "marks that job closed and removes its worktree";
  return `tedy role gate: this is a ${who.role} job (${who.label}); job.mjs close ${[...new Set(names)].join(", ")} ${effect}, which belongs to the cockpit. Allow it only if the user asked for it here.`;
}

const JOBS_DOC = fileURLToPath(new URL("../shared/jobs.md", import.meta.url));

export function agentReason(who, action, map = {}) {
  if (!FORBIDDEN[who.role]?.has(action.kind)) return null;
  const owner = OWNER[action.kind];
  if (who.role === "cockpit") return `tedy role gate: this is the cockpit of ${map.name}; ${WHAT[action.kind]} belongs to the ${owner} role. Start a ${owner} job per ${JOBS_DOC}, unless the user allows this one here.`;
  return `tedy role gate: this is a ${who.role} job (${who.label}); ${WHAT[action.kind]} belongs to the ${owner} role. Write a card, or a question card to start a ${owner} job, per ${JOBS_DOC}, unless the user allows this one here.`;
}

export const cockpitCard = (map) => `This is the cockpit of ${map.name}: start jobs and ask their open cards per ${JOBS_DOC}, section "Cockpit".`;

export function jobCard(map, who, gateOn = true) {
  return `Role: this session is a ${who.role} job (${who.label}) of ${map.name}. Work it per ${JOBS_DOC}, section "Job": read the job file your prompt names, decide each local, reversible choice yourself and record it with its reason in the outcome, turn each decision the user must make into a question card and each write that needs approval into a publish card, and end with job.mjs done or stop.${gateOn ? " A write that belongs to another role asks the user first." : ""}`;
}

export function judge(input, map, who = agentRole(input) ?? spawnedRole(input)) {
  const actions = classifyActions(input, map);
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
    return { kind: action.kind, role: who.role, reason };
  }
  const { action, reason } = first((each) => (each.script ? null : agentReason({ role: "cockpit" }, each, map)));
  return { kind: action.kind, role: "cockpit", reason };
}

export function run() {
  const input = readHookInput({ askOnFailure: true });
  try {
    const cwd = input.cwd ?? process.cwd();
    let who = agentRole(input);
    let resolved;
    let spawned = null;
    if (!who && jobAgentType(input)) {
      const probe = { role: AGENT_ROLES[input.agent_type], label: input.agent_type };
      const asks = closeReason(input, probe) || kitStateReason(input, probe);
      const job = asks || gateSwitches().roleGate ? jobOfAgent(input) : null;
      if (job) {
        try {
          resolved = jobMap(job.file);
        } catch (error) {
          if (gateSwitches().roleGate) throw error;
          logGate({ hook: "role-gate", decision: "skip-map-unreadable", agent_type: input.agent_type, error: error.message });
          return;
        }
        const needed = resolved && (asks || classifyActions(input, resolved.map).length);
        spawned = needed ? spawnedRole(input, job) : null;
        who = spawned;
      }
    }
    const closing = closeReason(input, who);
    const kitState = closing ? null : kitStateReason(input, spawned);
    if (closing || kitState) {
      logGate({ hook: "role-gate", decision: "ask", agent_type: input.agent_type, role: who.role, kind: closing ? "job-close" : "kit-state", tool: input.tool_name });
      ask(closing ?? kitState);
      return;
    }
    if (!gateSwitches().roleGate) return;
    if (resolved === null) logGate({ hook: "role-gate", decision: "job-map-missing", agent_type: input.agent_type });
    if (!resolved) resolved = resolveMap(cwd);
    const verdict = resolved && judge(input, resolved.map, who);
    if (verdict) {
      logGate({ hook: "role-gate", decision: verdict.reason ? "ask" : "allow", agent_type: input.agent_type, role: verdict.role, kind: verdict.kind, tool: input.tool_name });
      if (verdict.reason) ask(verdict.reason);
    }
  } catch (error) {
    logGate({ hook: "role-gate", decision: "ask-on-error", error: error.message });
    ask(`tedy gate: could not check which session role owns this write (${error.message}). Allow it only if the user asked for it, then fix the project map.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
