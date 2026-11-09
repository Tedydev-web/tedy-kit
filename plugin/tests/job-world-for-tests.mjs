import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { launchRecordPath, recordLaunch } from "../lib/job-files.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

export const PLUGIN = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
export const SCRIPT = join(PLUGIN, "scripts", "job.mjs");
export const JOBS_DOC = join(PLUGIN, "shared", "jobs.md");

export const BODY = "Add the line hello to notes.txt.\n\n## User decisions\nnone yet\n\n## First safe step\nRead notes.txt.\n\n## Sources\nthe user's request\n";

const SEPARATOR = "\u001f";

const FAKE_HERDR = (log) => `#!/bin/sh
for a in "$@"; do printf '%s\\037' "$a" >> "${log}"; done
printf '\\036' >> "${log}"
if [ -n "$FAKE_HERDR_FAIL" ] && [ "$1 $2" = "\${FAKE_HERDR_FAIL%%:*}" ]; then
  printf '{"id":"1","error":{"code":"%s","message":"fake failure"}}\\n' "\${FAKE_HERDR_FAIL#*:}" >&2
  exit 1
fi
case "$1 $2" in
  "tab create") echo '{"id":"1","result":{"type":"tab_created","tab":{"tab_id":"w1:t2"},"root_pane":{"pane_id":"w1:p7"}}}' ;;
  "worktree create") printf '{"id":"1","result":{"type":"worktree_created","root_pane":{"pane_id":"w1:p8"},"worktree":{"path":"%s"}}}\\n' "$FAKE_HERDR_WORKTREE" ;;
  "agent start") echo '{"id":"1","result":{"type":"agent_info","agent":{"agent_status":"idle"}}}' ;;
  "agent get")
    if [ -z "$FAKE_HERDR_STATUS" ]; then echo '{"id":"1","error":{"code":"agent_not_found","message":"no such agent"}}' >&2; exit 1; fi
    printf '{"id":"1","result":{"type":"agent_info","agent":{"agent_status":"%s"}}}\\n' "$FAKE_HERDR_STATUS" ;;
  "notification show") echo '{"id":"1","result":{"type":"notification_show","shown":true,"reason":"shown"}}' ;;
  *) echo '{"id":"1","error":{"code":"unexpected","message":"unexpected call"}}' >&2; exit 1 ;;
esac
`;

export function fakeHerdr(bin) {
  mkdirSync(bin, { recursive: true });
  const log = join(bin, "herdr.log");
  writeFileSync(log, "");
  writeFileSync(join(bin, "herdr"), FAKE_HERDR(log));
  chmodSync(join(bin, "herdr"), 0o755);
  return () => readFileSync(log, "utf8").split("\u001e").filter(Boolean).map((line) => line.split(SEPARATOR).slice(0, -1));
}

export function world(mapExtra = { jobs: true }) {
  const root = tempDir("tedy-job-");
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
  const herdrCalls = fakeHerdr(bin);
  const body = join(root, "body.md");
  writeFileSync(body, BODY);
  const env = (extra = {}) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: state, TEDY_JOB_PLUGIN_DIR: "", HERDR_ENV: "", HERDR_WORKSPACE_ID: "", ...extra });
  const run = (args, { extra } = {}) => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8", env: env(extra) });
    return { status, stdout, stderr };
  };
  const runAsync = (args) => promisify(execFile)(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8", env: env() });
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  const jobs = () => (existsSync(join(root, "plans", "jobs")) ? readdirSync(join(root, "plans", "jobs")).filter((name) => name.endsWith(".md")).map((name) => join(root, "plans", "jobs", name)) : []);
  const record = (file) => JSON.parse(readFileSync(launchRecordPath(file, state), "utf8"));
  return { root, profile, state, bin, body, map, env, run, runAsync, calls, herdrCalls, jobs, record };
}

export function jobFile(w, { role = "dev", status = "running", mode, created = new Date(Date.now() - (3 * 60 + 5) * 60_000).toISOString(), name = "add-hello", record = {}, header = [] } = {}) {
  mkdirSync(join(w.root, "plans", "jobs"), { recursive: true });
  const file = join(w.root, "plans", "jobs", `261106-0900-${role}-${name}.md`);
  const lines = [`to: tedy:${role}`, "from: cockpit", `status: ${status}`, `created: ${created}`, `title: ${name.replaceAll("-", " ")}`, `cwd: ${w.root}`, ...(mode ? [`permission_mode: ${mode}`] : []), ...header];
  writeFileSync(file, `${lines.join("\n")}\n\n${BODY}`);
  if (record) recordLaunch(file, { role, cwd: w.root, permission_mode: mode, settings: join(w.state, "jobs", "settings", `${role}.json`), ...record }, w.state);
  return file;
}
