import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { launchRecordPath, recordLaunch } from "../lib/job-files.mjs";
import { processInfo } from "../lib/job-session-hooks.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

export async function sleeper({ claude = true } = {}) {
  const child = spawn("node", ["-e", `setInterval(() => {}, 1000); console.log("up")`], { stdio: ["ignore", "pipe", "ignore"], argv0: claude ? "claude" : "node" });
  await once(child.stdout, "data");
  return { child, pid: child.pid, start: processInfo(child.pid).start, exited: once(child, "exit") };
}

export const DEAD_PID = 2 ** 22 + 17;

export const PLUGIN = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
export const SCRIPT = join(PLUGIN, "scripts", "job.mjs");
const FAKE_COCKPIT = fileURLToPath(new URL("./fake-cockpit-for-tests.mjs", import.meta.url));
export const JOBS_DOC = join(PLUGIN, "shared", "jobs.md");

export const BODY = "Add the line hello to notes.txt.\n\n## User decisions\nnone yet\n\n## First safe step\nRead notes.txt.\n\n## Sources\nthe user's request\n";

export function world(mapExtra = { jobs: true }, root = tempDir("tedy-job-")) {
  const profile = join(root, "profile");
  const state = join(root, "state");
  const bin = join(root, "bin");
  for (const dir of [join(profile, "projects"), state, bin, join(root, "fe"), join(root, "be")]) mkdirSync(dir, { recursive: true });
  const map = { name: "acme-shop", paths: [root], repos: [{ path: "fe", role: "FE" }, { path: "be", role: "BE", readonly: true }], ...mapExtra };
  writeFileSync(join(profile, "projects", "shop.md"), `# map\n\n\`\`\`json\n${JSON.stringify(map)}\n\`\`\`\n`);
  const log = join(root, "claude.log");
  writeFileSync(log, "");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" >> "${log}"\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const body = join(root, "body.md");
  writeFileSync(body, BODY);
  const env = (extra = {}) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: state, ...extra });
  const run = (args, { extra, cwd = root } = {}) => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [FAKE_COCKPIT, SCRIPT, ...args], { cwd, encoding: "utf8", env: env(extra), argv0: "claude" });
    return { status, stdout, stderr };
  };
  const runAsync = (args) => promisify(execFile)(process.execPath, [FAKE_COCKPIT, SCRIPT, ...args], { cwd: root, encoding: "utf8", env: env(), argv0: "claude" });
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  const jobs = () => (existsSync(join(root, "plans", "jobs")) ? readdirSync(join(root, "plans", "jobs")).filter((name) => name.endsWith(".md")).map((name) => join(root, "plans", "jobs", name)) : []);
  const record = (file) => JSON.parse(readFileSync(launchRecordPath(file, state), "utf8"));
  return { root, profile, state, bin, body, map, env, run, runAsync, calls, jobs, record };
}

export function jobFile(w, { role = "dev", status = "running", created = new Date(Date.now() - (3 * 60 + 5) * 60_000).toISOString(), name = "add-hello", record = {}, header = [] } = {}) {
  mkdirSync(join(w.root, "plans", "jobs"), { recursive: true });
  const file = join(w.root, "plans", "jobs", `261106-0900-${role}-${name}.md`);
  const lines = [`to: tedy:${role}`, "from: cockpit", `status: ${status}`, `created: ${created}`, `title: ${name.replaceAll("-", " ")}`, `cwd: ${w.root}`, ...header];
  writeFileSync(file, `${lines.join("\n")}\n\n${BODY}`);
  if (record) recordLaunch(file, { role, cwd: w.root, agent_name: `${role}-${name}`, cockpit_pid: DEAD_PID, cockpit_pid_start: "1", ...record }, w.state);
  return file;
}

export const bound = (cockpit, extra = {}) => ({ agent_id: "a1b2c3", session_id: "s-cockpit", cockpit_pid: cockpit.pid, cockpit_pid_start: cockpit.start, bound_at: "2026-11-11T02:00:00.000Z", state: "running", ...extra });
