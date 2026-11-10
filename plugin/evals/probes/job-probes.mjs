import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LOGS = "/tmp/tedy-probes/logs";
const PROBE = join(dirname(fileURLToPath(import.meta.url)), "probe");
const MODEL = "claude-sonnet-5-5";

const uniq = (values) => [...new Set(values.map((value) => value ?? "null"))].join(",") || "none";

function sh(command, args, { cwd, env = {}, timeout = 60_000 } = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout, input: "" });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

function logs(tag) {
  const file = join(LOGS, `${tag}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

const tokens = (usage = {}) => (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);

function printRun(args, { env = {} } = {}) {
  const dir = mkdtempSync("/tmp/tedy-probes-p-");
  sh("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "a\n");
  const sid = randomUUID();
  const result = sh("claude", ["-p", "--plugin-dir", PROBE, "--model", MODEL, "--permission-mode", "bypassPermissions", "--max-budget-usd", "1", "--output-format", "json", "--session-id", sid, ...args], { cwd: dir, env, timeout: 300_000 });
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(homedir(), ".claude", "projects", dir.replace(/[/.]/g, "-")), { recursive: true, force: true });
  let json = {};
  try {
    json = JSON.parse(result.out);
  } catch {}
  return { sid, dir, json, usd: json.total_cost_usd ?? 0, models: Object.keys(json.modelUsage ?? {}).join(",") || "none", code: result.code, err: result.err.split("\n").find(Boolean) ?? "" };
}

function blockTen() {
  const run = printRun(["--agent", "probe:zz-job-probe", "Run: echo hi"]);
  const lines = logs("any-tool").filter((line) => line.session_id === run.sid);
  console.log(`[10] exit=${run.code} err=${run.err || "none"} agent_type=${uniq(lines.map((line) => line.agent_type))} tool_calls=${lines.length} tokens=${tokens(run.json.usage)} cost=${run.usd.toFixed(3)} model=${run.models}`);
  return run.code === 0;
}

function blockNine() {
  const run = printRun(["--agent", "probe:zz-job-probe", "Run git status --short. Then spawn one Explore subagent that runs ls. Then reply with the names of the probe:* skills you can see."], { env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } });
  const inDir = (line) => String(line.cwd ?? "").startsWith(run.dir);
  const tools = logs("any-tool").filter(inDir);
  const main = tools.filter((line) => !line.agent_id);
  const sub = tools.filter((line) => line.agent_id);
  const start = logs("startup").filter((line) => line.session_id === run.sid);
  const text = String(run.json.result ?? "");
  console.log(`[9] exit=${run.code} main agent_type=${uniq(main.map((line) => line.agent_type))} SessionStart lines=${start.length} agent_type=${uniq(start.map((line) => line.agent_type))} subagent lines=${sub.length} agent_type=${uniq(sub.map((line) => line.agent_type))} agent_id=${sub.length ? "present" : "none"} parent_session=${sub.length ? sub.every((line) => line.session_id === run.sid) : "n/a"} skills visible=${/zz-visible-probe/.test(text)} body=${/zz-body-probe/.test(text)} hidden=${/zz-hidden-probe/.test(text)} cost=${run.usd.toFixed(3)} model=${run.models}`);
}

function main(mode) {
  mkdirSync(LOGS, { recursive: true });
  console.log(`# job probes ${new Date().toISOString()} ${sh("claude", ["--version"]).out.trim()} model=${MODEL}`);
  if (mode === "9") return blockNine();
  if (blockTen() && mode !== "10") blockNine();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv[2] ?? "jobs");
