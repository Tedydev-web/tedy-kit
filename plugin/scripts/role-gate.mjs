import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classify, splitSegments } from "./git-gate.mjs";
import { route } from "./handoff.mjs";
import { ask, gateSwitches, logGate, readHookInput } from "./hook-io.mjs";
import { resolveMap } from "./project-map.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SCRIPT_WRITES = [
  { kind: "tracker", pattern: /openproject\.mjs["']?\s+apply\b|pg\.py["']?\s+set\b|^(?=[\s\S]*--apply\b)[\s\S]*?(?:openproject\.mjs["']?\s+(?:set|comment|comment-edit|relation|relation-delete|rollback)|op_apply\.py|pg\.py["']?\s+(?:sync|rollback))\b/ },
  { kind: "doc-figma", pattern: /gdoc-comments\.mjs["']?\s+(reply|anchor|post|edit|delete)\b|figma-comments\.mjs["']?\s+(post|reply|delete)\b|doc-comment-file\.mjs/ },
  { kind: "code", pattern: /github-write\.mjs["']?\s+pr-body\b/ },
  { kind: "pr-review", pattern: /github-write\.mjs["']?\s+(post|resolve|unresolve|edit|minimize)\b/ },
];
const OWNER = { tracker: "pm", "doc-figma": "pm", "pr-review": "review", code: "dev" };
const WHAT = {
  tracker: "writing to the tracker",
  "doc-figma": "Doc or Figma comments",
  "pr-review": "posting or resolving PR review comments",
  code: "changing or committing product code",
};
const FORBIDDEN = {
  dev: new Set(["tracker", "doc-figma", "pr-review"]),
  devops: new Set(["tracker", "doc-figma", "pr-review"]),
  review: new Set(["code", "tracker", "doc-figma"]),
  pm: new Set(["code", "pr-review"]),
  dispatch: new Set(["code", "tracker", "doc-figma", "pr-review"]),
};

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

export function classifyAction(input, map) {
  if (!map.sessions?.length) return null;
  const cwd = input.cwd ?? process.cwd();
  if (EDIT_TOOLS.has(input.tool_name)) {
    const path = resolve(cwd, input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "");
    const hit = repoOf(map, path);
    return isCode(hit) ? { kind: "code", repo: hit.repo } : null;
  }
  if (input.tool_name !== "Bash") return null;
  let dir = cwd;
  for (const segment of splitSegments(input.tool_input?.command ?? "")) {
    const action = classify(segment, dir);
    if (action.kind === "cd") {
      dir = action.dir;
      continue;
    }
    const script = SCRIPT_WRITES.find((write) => write.pattern.test(segment));
    if (script) return { kind: script.kind, repo: null };
    if (action.kind === "commit" || action.kind === "push") {
      const hit = repoOf(map, action.dir);
      if (hit) return { kind: "code", repo: hit.repo };
    }
  }
  return null;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = readHookInput();
  try {
    const resolved = gateSwitches().roleGate && resolveMap(input.cwd ?? process.cwd());
    const action = resolved && classifyAction(input, resolved.map);
    if (action) {
      const name = sessionName(input.session_id, listSessions());
      const reason = name && decide(resolved.map, name, action);
      logGate({ hook: "role-gate", decision: reason ? "ask" : "allow", session: name, kind: action.kind, tool: input.tool_name });
      if (reason) ask(reason);
    }
  } catch (error) {
    logGate({ hook: "role-gate", decision: "ask-on-error", error: error.message });
    ask(`tedy gate: could not check which session role owns this write (${error.message}). Allow it only if the user asked for it, then fix the project map.`);
  }
}
