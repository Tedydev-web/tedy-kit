import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WORKSPACE = process.env.TEDY_PROBE_WORKSPACE ?? "/tmp/tedy-probes-bg/work";
export const LEGACY = "[legacy] these blocks measure claude --bg sessions, which job.mjs no longer launches (ADR 0018); they re-measure ADR 0015 blocks [9] to [13b] only";
const BASE = dirname(WORKSPACE);
const LAUNCHED = join(BASE, "launched");
const FACTS = join(BASE, "facts.txt");
const LOGS = "/tmp/tedy-probes/logs";
const PROBE = join(dirname(fileURLToPath(import.meta.url)), "probe");
const MODEL = "claude-sonnet-5-5";
const BUDGET = 8.5;
const WAIT_MS = 120_000;
const ENDED = new Set(["done", "failed", "stopped"]);

export function cleanupTargets(rows, launched, workspace) {
  if (workspace !== WORKSPACE) return [];
  const ids = new Set(launched.filter(Boolean));
  return rows.filter((row) => row.kind === "background" && row.id && ids.has(row.sessionId) && (row.cwd === workspace || String(row.cwd ?? "").startsWith(`${workspace}/`)));
}

const parts = (entry) => (Array.isArray(entry?.message?.content) ? entry.message.content : []);

export function commandOutcome(entries, marker) {
  const uses = new Set();
  for (const entry of entries) for (const part of parts(entry)) if (part?.type === "tool_use" && String(part.input?.command ?? "").includes(marker)) uses.add(part.id);
  for (const entry of entries) {
    for (const part of parts(entry)) {
      if (part?.type !== "tool_result" || !uses.has(part.tool_use_id)) continue;
      return part.is_error && /denied|permission|not allowed|rejected/i.test(JSON.stringify(part.content ?? "")) ? "auto-denied" : "ran";
    }
  }
  return uses.size ? "pending" : "not-called";
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const uniq = (values) => [...new Set(values.map((value) => value ?? "null"))].join(",") || "none";

function sh(command, args, { cwd, env = {}, timeout = 60_000 } = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout, input: "" });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

function rows() {
  try {
    return JSON.parse(sh("claude", ["agents", "--json", "--all"]).out);
  } catch {
    return [];
  }
}

const row = (uuid) => rows().find((item) => item.kind === "background" && item.sessionId === uuid) ?? null;
const launched = () => (existsSync(LAUNCHED) ? readFileSync(LAUNCHED, "utf8").split("\n").filter(Boolean) : []);

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

function transcript(uuid) {
  const root = join(homedir(), ".claude", "projects");
  for (const project of readdirSync(root)) {
    const file = join(root, project, `${uuid}.jsonl`);
    if (!existsSync(file)) continue;
    return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }
  return [];
}

const tokens = (usage = {}) => (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);

let spent = 0;
let rate = null;

function fact(line) {
  console.log(line);
  appendFileSync(FACTS, `${line}\n`);
}

function backgroundCost(uuid) {
  const usages = new Map();
  for (const entry of transcript(uuid)) if (entry.type === "assistant" && entry.message?.usage) usages.set(entry.message.id ?? entry.uuid, entry.message.usage);
  const total = [...usages.values()].reduce((sum, usage) => sum + tokens(usage), 0);
  const usd = rate === null ? 0 : total * rate;
  spent += usd;
  return `usage=${usages.size ? "yes" : "no"} tokens=${total} est_usd=${usd.toFixed(3)}`;
}

function printRun(args, { env = {}, cwd } = {}) {
  const dir = cwd ?? mkdtempSync("/tmp/tedy-probes-p-");
  if (!cwd) {
    sh("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "a\n");
  }
  const sid = randomUUID();
  const result = sh("claude", ["-p", "--plugin-dir", PROBE, "--model", MODEL, "--permission-mode", "bypassPermissions", "--max-budget-usd", "1", "--output-format", "json", "--session-id", sid, ...args], { cwd: dir, env, timeout: 300_000 });
  if (!cwd) {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(homedir(), ".claude", "projects", dir.replace(/[/.]/g, "-")), { recursive: true, force: true });
  }
  let json = {};
  try {
    json = JSON.parse(result.out);
  } catch {}
  const usd = json.total_cost_usd ?? 0;
  spent += usd;
  return { sid, dir, json, usd, models: Object.keys(json.modelUsage ?? {}).join(",") || "none", code: result.code, err: result.err.split("\n").find(Boolean) ?? "" };
}

class Untrusted extends Error {}

export const shortIdOf = (line) => String(line).match(/backgrounded · ([0-9a-f]{8})\b/)?.[1] ?? null;

function launch(block, mark, { settings = {}, flags = [], prompt, resume = null }) {
  const merged = JSON.stringify({ ...settings, env: { ...(settings.env ?? {}), TEDY_PROBE_MARK: mark } });
  const head = resume ? ["--resume", resume, "--bg"] : ["--bg"];
  const result = sh("claude", [...head, "--plugin-dir", PROBE, "--model", MODEL, "--settings", merged, ...flags, prompt], { cwd: WORKSPACE });
  if (/Workspace not trusted/i.test(result.out + result.err)) {
    fact(`LAUNCH-FAILED ${block}: Workspace not trusted`);
    throw new Untrusted();
  }
  const line = (result.err || result.out).split("\n").find(Boolean) ?? `exit ${result.code}`;
  const short = result.code === 0 ? shortIdOf(result.out) : null;
  const found = short ? rows().find((item) => item.kind === "background" && item.id === short) : null;
  if (!found) {
    fact(`LAUNCH-FAILED ${block}: ${line}`);
    return null;
  }
  appendFileSync(LAUNCHED, `${found.sessionId}\n`);
  return { uuid: found.sessionId, short, line: result.out.split("\n").find(Boolean) };
}

async function watch(uuid, until = () => false) {
  const start = Date.now();
  const states = [];
  let last = null;
  while (Date.now() - start < WAIT_MS) {
    last = row(uuid) ?? last;
    if (last) states.push(`${last.state ?? "-"}/${last.status ?? "-"}/${last.waitingFor ?? "-"}`);
    if (until(last) || ENDED.has(last?.state)) break;
    await sleep(5_000);
  }
  return { last, states: uniq(states) };
}

async function stop(uuid) {
  const current = row(uuid);
  if (!current?.id) return current;
  const result = sh("claude", ["stop", current.id]);
  for (let tries = 0; tries < 12; tries += 1) {
    const now = row(uuid);
    if (!now || ENDED.has(now.state)) return { ...now, stopCode: result.code };
    await sleep(5_000);
  }
  return { ...row(uuid), stopCode: result.code };
}

const marked = (tag, uuid, mark = uuid) => logs(tag).filter((line) => line.session_id === uuid && line.mark === mark);
const stopped = (uuid, mark = uuid) => () => marked("stop", uuid, mark).length > 0;

function askOutcome(uuid, marker, last) {
  const outcome = commandOutcome(transcript(uuid), marker);
  return outcome === "pending" && last?.waitingFor === "permission prompt" ? "prompted" : outcome;
}

function overBudget() {
  if (spent <= BUDGET) return false;
  fact(`[gate] spend USD ${spent.toFixed(2)} passed ${BUDGET}; remaining blocks skipped`);
  return true;
}

function cleanup() {
  if (!existsSync(WORKSPACE) || !statSync(WORKSPACE).isDirectory()) return;
  for (const target of cleanupTargets(rows(), launched(), WORKSPACE)) {
    const stopResult = sh("claude", ["stop", target.id]);
    const rmResult = sh("claude", ["rm", target.id]);
    console.log(`cleanup ${target.id}: stop=${stopResult.code} rm=${rmResult.code}`);
  }
}

function trusted() {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")).projects?.[WORKSPACE]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
}

function prepare() {
  mkdirSync(WORKSPACE, { recursive: true });
  mkdirSync(LOGS, { recursive: true });
  cleanup();
  for (const name of readdirSync(WORKSPACE)) rmSync(join(WORKSPACE, name), { recursive: true, force: true });
  rmSync(join(BASE, "wt"), { recursive: true, force: true });
  writeFileSync(LAUNCHED, "");
  sh("git", ["init", "-q"], { cwd: WORKSPACE });
  writeFileSync(join(WORKSPACE, "a.txt"), "a\n");
  sh("git", ["add", "a.txt"], { cwd: WORKSPACE });
  sh("git", ["-c", "user.email=p@p", "-c", "user.name=p", "commit", "-qm", "init"], { cwd: WORKSPACE });
  appendFileSync(join(WORKSPACE, "a.txt"), "m\n");
  fact(`# job probes ${new Date().toISOString()} ${sh("claude", ["--version"]).out.trim()} model=${MODEL}`);
}

function blockTen() {
  const run = printRun(["--agent", "probe:zz-job-probe", "Run: echo hi"]);
  const lines = logs("any-tool").filter((line) => line.session_id === run.sid);
  const total = tokens(run.json.usage);
  rate = total ? run.usd / total : null;
  fact(`[10] exit=${run.code} err=${run.err || "none"} agent_type=${uniq(lines.map((line) => line.agent_type))} tool_calls=${lines.length} cost=${run.usd.toFixed(3)} model=${run.models} projection=${(run.usd * 12).toFixed(2)}`);
  return run.code === 0 && run.usd * 12 <= BUDGET;
}

function blockNine() {
  const run = printRun(["--agent", "probe:zz-job-probe", "Run git status --short. Then spawn one Explore subagent that runs ls. Then reply with the names of the probe:* skills you can see."], { env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } });
  const inDir = (line) => String(line.cwd ?? "").startsWith(run.dir);
  const tools = logs("any-tool").filter(inDir);
  const main = tools.filter((line) => !line.agent_id);
  const sub = tools.filter((line) => line.agent_id);
  const start = logs("startup").filter((line) => line.session_id === run.sid);
  const text = String(run.json.result ?? "");
  fact(`[9] exit=${run.code} main agent_type=${uniq(main.map((line) => line.agent_type))} SessionStart lines=${start.length} agent_type=${uniq(start.map((line) => line.agent_type))} subagent lines=${sub.length} agent_type=${uniq(sub.map((line) => line.agent_type))} agent_id=${sub.length ? "present" : "none"} parent_session=${sub.length ? sub.every((line) => line.session_id === run.sid) : "n/a"} skills visible=${/zz-visible-probe/.test(text)} body=${/zz-body-probe/.test(text)} hidden=${/zz-hidden-probe/.test(text)} cost=${run.usd.toFixed(3)} model=${run.models}`);
}

async function blockEleven() {
  const mark = randomUUID();
  const out = launch("[11]", mark, { flags: ["--agent", "probe:zz-job-probe", "--name", "probe job one"], prompt: "/probe:zz-body-probe Then run git status --short." });
  if (out === null) return null;
  const { uuid } = out;
  const working = await watch(uuid, stopped(uuid, mark));
  const after = await stop(uuid);
  const tools = marked("any-tool", uuid, mark);
  const all = logs("any-tool").filter((line) => line.session_id === uuid);
  const stops = marked("stop", uuid, mark);
  const text = JSON.stringify(transcript(uuid));
  fact(`[11] launch="${out.line}" short_id_is_session_prefix=${uuid.startsWith(out.short)} name=${working.last?.name ?? "none"} states=${working.states} after_stop=${after?.state ?? "gone"} skill_started=${text.includes("BODYTOKEN-58213")} body_reply=${text.includes("BODY-LOADED")} agent_type=${uniq(tools.map((line) => line.agent_type))} agent_id=${uniq(tools.map((line) => line.agent_id))} permission_mode=${uniq(tools.map((line) => line.permission_mode))} mark=${tools.length ? "present" : all.length ? "absent" : "no-lines"} stop_lines=${stops.length} stop_agent_type=${uniq(stops.map((line) => line.agent_type))} entrypoint=${uniq(stops.map((line) => line.entrypoint))} ${backgroundCost(uuid)}`);
  return { uuid, short: out.short };
}

async function blockThirteen(eleven) {
  const prompt = "Run git status --short, then reply AGAIN";
  const shortMark = randomUUID();
  const viaShort = launch("[13-short]", shortMark, { resume: eleven.short, prompt });
  await sleep(30_000);
  const shortAccepted = logs("any-tool").some((line) => line.mark === shortMark);
  if (viaShort) await stop(viaShort.uuid);
  const mark = randomUUID();
  const out = launch("[13]", mark, { resume: eleven.uuid, prompt });
  if (out === null) return;
  await watch(out.uuid, stopped(out.uuid, mark));
  const lines = logs("any-tool").filter((line) => line.mark === mark);
  await stop(out.uuid);
  fact(`[13] short_id_accepted=${shortAccepted} launch="${out.line}" new_session_id=${out.uuid !== eleven.uuid} agent_type=${uniq(lines.map((line) => line.agent_type))} tool_lines=${lines.length} finished=${stopped(out.uuid, mark)()} ${backgroundCost(out.uuid)}`);
}

async function askBlock(block, { settings = {}, flags = [], prompt, marker, hookAsk = false, extra = () => "" }) {
  const mark = randomUUID();
  const out = launch(block, mark, { settings, flags, prompt });
  if (out === null) return null;
  const { uuid } = out;
  const done = (last) => last?.status === "waiting" || ["ran", "auto-denied"].includes(commandOutcome(transcript(uuid), marker));
  const working = await watch(uuid, done);
  const outcome = askOutcome(uuid, marker, working.last);
  const tools = marked("any-tool", uuid, mark);
  const asks = marked("hook-ask", uuid, mark).filter((line) => String(line.cmd ?? "").includes("tedy-hook-ask"));
  const summary = `${block} outcome=${outcome} states=${working.states} permission_mode=${uniq(tools.map((line) => line.permission_mode))} mark=${tools.length ? "present" : "absent"}${hookAsk ? ` hook_ask_lines=${asks.length}` : ""} ${extra(uuid)}`;
  return { uuid, summary };
}

async function finishAsk(result) {
  if (!result) return;
  await stop(result.uuid);
  fact(`${result.summary} ${backgroundCost(result.uuid)}`);
}

async function blockElevenB() {
  const result = await askBlock("[11b]", { settings: { permissions: { ask: ["Bash(echo tedy-ask-probe*)"] } }, prompt: "Run exactly: echo tedy-ask-probe-1", marker: "tedy-ask-probe" });
  if (!result) return;
  const copy = launch("[13b]", randomUUID(), { resume: result.uuid, prompt: "reply COPY" });
  await sleep(15_000);
  const original = row(result.uuid);
  fact(`[13b] launch="${copy?.line ?? "failed"}" copy_id_differs=${copy ? copy.uuid !== result.uuid : "n/a"} original_state=${original?.state ?? "gone"}/${original?.waitingFor ?? "-"}`);
  if (copy) {
    await stop(copy.uuid);
    backgroundCost(copy.uuid);
  }
  await finishAsk(result);
}

async function blockElevenC() {
  const result = await askBlock("[11c]", {
    flags: ["--permission-mode", "default"],
    settings: { permissions: { allow: ["Bash(git status*)", "Bash(echo *)"] } },
    prompt: "Run git status --short. Then run exactly: echo tedy-hook-ask-1",
    marker: "tedy-hook-ask-1",
    hookAsk: true,
    extra: (uuid) => `git_status=${commandOutcome(transcript(uuid), "git status")}`,
  });
  await finishAsk(result);
}

async function blockElevenD() {
  const result = await askBlock("[11d]", { prompt: "Run exactly: echo tedy-hook-ask-2", marker: "tedy-hook-ask-2", hookAsk: true });
  await finishAsk(result);
}

async function isolationBlock(block, settings, prompt, file) {
  const mark = randomUUID();
  const out = launch(block, mark, { flags: ["--permission-mode", "default"], settings, prompt });
  if (out === null) return;
  const { uuid } = out;
  const working = await watch(uuid, (last) => stopped(uuid, mark)() || last?.status === "waiting");
  const tools = marked("any-tool", uuid, mark);
  const nested = existsSync(join(WORKSPACE, ".claude", "worktrees")) ? readdirSync(join(WORKSPACE, ".claude", "worktrees")).filter((name) => existsSync(join(WORKSPACE, ".claude", "worktrees", name, file))) : [];
  const worktrees = sh("git", ["worktree", "list"], { cwd: WORKSPACE }).out.trim().split("\n").length;
  const commit = sh("git", ["log", "--oneline", "-1"], { cwd: join(BASE, "wt") });
  const last = working.last;
  await stop(uuid);
  fact(`${block} cwds=${uniq(tools.map((line) => line.cwd))} in_workspace=${existsSync(join(WORKSPACE, file))} in_bg_worktree=${nested.length} worktrees=${worktrees} wt_commit=${commit.code === 0 && !/init/.test(commit.out) ? "yes" : "no"} state=${last?.state ?? "-"} waitingFor=${last?.waitingFor ?? "-"} states=${working.states} ${backgroundCost(uuid)}`);
}

async function blockElevenE() {
  await isolationBlock("[11e]", { worktree: { bgIsolation: "none" }, permissions: { allow: ["Write", "Edit", "Bash(git *)"] } }, "Write plans/probe.md with one line. Then run git worktree add ../wt -b probe-wt, write ../wt/x.txt with one line, and commit it in ../wt. Commit without asking.", "plans/probe.md");
  await isolationBlock("[11e-variant]", { permissions: { allow: ["Write", "Edit"] } }, "Write plans/probe2.md with one line.", "plans/probe2.md");
}

async function blockTwelve() {
  const mark = randomUUID();
  const settings = JSON.stringify({ env: { TEDY_PROBE_MARK: mark } });
  const run = printRun([`Run exactly: claude --plugin-dir ${PROBE} --model ${MODEL} --agent probe:zz-job-probe --bg --name 'probe nested' --settings '${settings}' 'reply OK'`], { cwd: WORKSPACE });
  await sleep(20_000);
  const starts = logs("startup").filter((line) => line.mark === mark);
  const uuid = starts[0]?.session_id ?? null;
  if (uuid) appendFileSync(LAUNCHED, `${uuid}\n`);
  const item = uuid ? row(uuid) : null;
  if (uuid) await stop(uuid);
  fact(`[12] parent_exit=${run.code} nested_row_after_parent=${item ? "yes" : "no"} state=${item?.state ?? "-"} name=${item?.name ?? "none"} nested_startup_lines=${starts.length} parent_cost=${run.usd.toFixed(3)} model=${run.models} ${uuid ? backgroundCost(uuid) : "usage=n/a"}`);
}

async function main(mode) {
  if (!/^\/tmp\/tedy-[\w-]+\/work$/.test(WORKSPACE)) {
    console.error(`job probes: TEDY_PROBE_WORKSPACE must be /tmp/tedy-<name>/work, got ${WORKSPACE}`);
    process.exitCode = 2;
    return;
  }
  if (mode === "cleanup") return cleanup();
  process.on("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));
  prepare();
  fact(LEGACY);
  if (mode === "9") return blockNine();
  if (mode !== "10" && !trusted()) {
    fact("[gate] workspace not trusted; open claude once in /tmp/tedy-probes-bg/work and rerun");
    return;
  }
  if (!blockTen() || mode === "10") return;
  try {
    blockNine();
    const eleven = await blockEleven();
    if (eleven && !overBudget()) await blockThirteen(eleven);
    for (const block of [blockElevenB, blockElevenC, blockElevenD, blockElevenE, blockTwelve]) {
      if (overBudget()) break;
      await block();
    }
  } catch (error) {
    if (!(error instanceof Untrusted)) throw error;
    fact("[gate] workspace not trusted; open claude once in /tmp/tedy-probes-bg/work and rerun");
  }
  fact(`[total] spend_usd=${spent.toFixed(2)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main(process.argv[2] ?? "jobs");
