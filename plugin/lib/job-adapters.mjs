import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export const ADAPTERS = Object.freeze(["t3", "herdr", "print"]);

export function onPath(name, path = process.env.PATH ?? "") {
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

function herdrMissing(env) {
  if (env.HERDR_ENV !== "1") return "HERDR_ENV is not 1, so this session does not run inside herdr";
  if (!onPath("herdr", env.PATH)) return "herdr is not on PATH";
  return null;
}

export function chooseAdapter({ via, t3 = false, env = process.env } = {}) {
  if (via === undefined) return t3 ? "t3" : herdrMissing(env) ? "print" : "herdr";
  if (!ADAPTERS.includes(via)) throw new Error(`--via ${via} is not an adapter; use t3, herdr or print`);
  if (via === "t3" && !t3) throw new Error("--via t3 needs --t3, which the cockpit passes when its tools list t3_thread_launch");
  const why = via === "herdr" && herdrMissing(env);
  if (why) throw new Error(`--via herdr cannot run: ${why}`);
  return via;
}

export const t3Instance = (role) => `tedy-${role}`;

export class HerdrError extends Error {
  constructor(command, code, message) {
    super(`herdr ${command} failed (${code}: ${message})`);
    this.command = command;
    this.code = code;
  }
}

function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function herdr(args, env = process.env) {
  const command = args.slice(0, 2).join(" ");
  const result = spawnSync("herdr", args, { encoding: "utf8", env, timeout: 60_000 });
  if (result.error) throw new HerdrError(command, result.error.code ?? "spawn", result.error.message);
  if (result.status !== 0) {
    const error = parsed(result.stderr)?.error;
    throw new HerdrError(command, error?.code ?? `exit ${result.status}`, error?.message ?? result.stderr.trim());
  }
  const reply = parsed(result.stdout);
  if (!reply?.result) throw new HerdrError(command, "bad reply", result.stdout.trim().slice(0, 200));
  return reply.result;
}

export const herdrName = (role, file, turn) => `${role}-${createHash("sha256").update(`${file}\n${turn}`).digest("hex").slice(0, 6)}`;

export function herdrTab({ cwd, label }, env = process.env) {
  const workspace = env.HERDR_WORKSPACE_ID ? ["--workspace", env.HERDR_WORKSPACE_ID] : [];
  const pane = herdr(["tab", "create", ...workspace, "--cwd", cwd, "--label", label, "--no-focus"], env).root_pane?.pane_id;
  if (!pane) throw new HerdrError("tab create", "bad reply", "no root_pane.pane_id");
  return { pane, cwd };
}

export function herdrWorktree({ repo, branch, base, label }, env = process.env) {
  const result = herdr(["worktree", "create", "--cwd", repo, "--branch", branch, "--base", `origin/${base}`, "--label", label, "--no-focus"], env);
  const pane = result.root_pane?.pane_id;
  const path = result.worktree?.path;
  if (!pane || !path) throw new HerdrError("worktree create", "bad reply", "no root_pane.pane_id or worktree.path");
  return { pane, cwd: path };
}

export function herdrAgent({ name, pane, args }, env = process.env) {
  try {
    herdr(["agent", "start", name, "--kind", "claude", "--pane", pane, "--", ...args], env);
    return [];
  } catch (error) {
    if (error.code !== "agent_not_ready") throw error;
    return [`warning: herdr agent ${name} waits at a prompt in pane ${pane} (agent_not_ready); answer it there, the trust dialog included`];
  }
}

export function herdrState(name, env = process.env) {
  try {
    return herdr(["agent", "get", name], env).agent?.agent_status ?? "unknown";
  } catch (error) {
    if (error instanceof HerdrError) return error.code;
    throw error;
  }
}
