import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { missingSections, render, setStatus, slugOf, stamp } from "./handoff.mjs";
import { age, createAtomic, JOB_ROLES, jobsDir, listJobs, readJob, setKey, withoutKey, withSection, writeAtomic } from "./job-files.mjs";
import { profileDir } from "./profile.mjs";
import { STATE_DIR } from "./state-dir.mjs";
import { resolveMap } from "./project-map.mjs";

const SKILLS = { pm: "pm", dev: "dev", review: "review-pr" };
const PLUGIN = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const JOBS_DOC = join(PLUGIN, "shared", "jobs.md");
const ENDED = new Set(["stopped", "done", "failed"]);

const KIT_READERS = ["draft-lint.mjs", "project-map.mjs", "project-state.mjs get", "profile.mjs path", "labels.mjs", "prd-section.mjs", "figma-read.mjs", "task-lint.mjs", "op-status.mjs", "openproject.mjs get", "openproject.mjs list", "openproject.mjs preview", "openproject.mjs pr-body", "gdoc-comments.mjs list", "figma-comments.mjs list", "merged-sweep.mjs", "pending.mjs card publish", "pending.mjs card question", "pending.mjs card notify", "job.mjs done", "job.mjs stop"];
const READ_GIT = ["status*", "diff*", "log*", "show*", "fetch -q origin"];
const READ_GH = ["pr view*", "pr diff*", "pr list*", "pr checks*"];
const NPM_SCRIPTS = ["typecheck", "lint", "lint:check", "format:check", "check", "test", "test:unit", "test:cov"];
const BUILD_GIT = ["worktree add *", "worktree list*", "worktree remove *", "switch *", "add *", "commit *", "push -u origin *"];
const git = (forms) => forms.map((form) => `Bash(git ${form})`);
const gitIn = (forms) => forms.map((form) => `Bash(git -C * ${form})`);

export function allowRules(role, { plugin, root, profile }) {
  const common = [`Read(/${plugin}/**)`, `Read(/${root}/**)`, `Read(/${profile}/**)`, `Edit(/${root}/plans/**)`, ...KIT_READERS.map((name) => `Bash(node ${plugin}/scripts/${name}*)`), ...git(READ_GIT), ...READ_GH.map((form) => `Bash(gh ${form})`)];
  if (role === "dev" || role === "devops") return [...common, "Edit", "Bash(npm test*)", ...NPM_SCRIPTS.flatMap((name) => [`Bash(npm run ${name})`, `Bash(npm run ${name} -- *)`]), ...git(BUILD_GIT), ...gitIn([...READ_GIT, ...BUILD_GIT]), "Bash(gh pr create --draft *)"];
  if (role === "review") return [...common, "Bash(npm test*)", ...git(["worktree add *", "worktree list*"])];
  return common;
}

export function claudeCli(args, cwd) {
  const result = spawnSync("claude", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  if (result.error) throw new Error(`claude ${args[0]}: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function fleet(claude) {
  const { status, stdout, stderr } = claude(["agents", "--json", "--all"]);
  if (status !== 0) throw new Error(`claude agents --json --all failed: ${(stderr || stdout).trim()}`);
  const rows = JSON.parse(stdout);
  if (!Array.isArray(rows)) throw new Error("claude agents --json --all did not print a list");
  return rows;
}

function call(claude, args, cwd) {
  const { status, stdout, stderr } = claude(args, cwd);
  if (status !== 0) throw new Error(`claude ${args.join(" ")} failed: ${(stderr || stdout).trim()}`);
}

function launchedRow(claude, output, name, previous, since) {
  const short = output.match(/backgrounded\s+·\s+(\S+)\s+·/)?.[1];
  let problem = "its session is not in the list";
  for (let tries = 0; tries < 10; tries += 1) {
    try {
      const rows = fleet(claude).filter((item) => item.sessionId && item.sessionId !== previous);
      const matches = short ? rows.filter((item) => item.id === short || item.sessionId.startsWith(short)) : rows.filter((item) => item.name === name && Number(item.startedAt) >= since);
      if (matches.length === 1) return { found: matches[0] };
      if (matches.length > 1) problem = short ? `${matches.length} sessions match the short id ${short}` : `${matches.length} sessions named ${name} started after the launch`;
    } catch (error) {
      problem = error.message;
    }
    sleep(300);
  }
  return { problem };
}

const shellWord = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'"'"'`)}'`);

function writableRepo(map, given) {
  const root = map.paths[0];
  const path = resolve(root, given);
  const repo = (map.repos ?? []).find((item) => resolve(root, item.path) === path);
  if (!repo) throw new Error(`${given} is not a repository in the project map`);
  if (repo.readonly) throw new Error(`${given} is read-only in the project map; a job may not write there`);
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  return path;
}

function settings(role, map) {
  const env = Object.fromEntries(["TEDY_STATE_DIR", "TEDY_PROFILE_DIR"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  return JSON.stringify({ permissions: { allow: allowRules(role, { plugin: PLUGIN, root: map.paths[0], profile: profileDir() }) }, worktree: { bgIsolation: "none" }, ...(Object.keys(env).length && { env }) });
}

const launchArgs = (role, map, mode) => ["--settings", settings(role, map), ...(mode ? ["--permission-mode", mode] : []), ...(process.env.TEDY_JOB_PLUGIN_DIR ? ["--plugin-dir", process.env.TEDY_JOB_PLUGIN_DIR] : [])];

const startPrompt = (role, file) => (role === "devops" ? `Job file ${file}. Read ${JOBS_DOC}, section "Job", then do the job.` : `/tedy:${SKILLS[role]} job ${file}. First read ${JOBS_DOC}, section "Job".`);

const jobName = (map, role, file) => `${role} ${map.name} ${basename(file, ".md").slice(`${stamp()}-${role}-`.length)}`;

const trustHint = (text, cwd) => (/Workspace not trusted/i.test(text) ? `\nopen \`claude\` once in ${cwd} and accept the trust dialog` : "");

function spawned(claude, args, cwd) {
  try {
    return claude(args, cwd);
  } catch (error) {
    return { status: 1, stdout: "", stderr: error.message };
  }
}

const recordFile = (file, dir) => join(dir, "jobs", `${createHash("sha256").update(realpathSync(file)).digest("hex").slice(0, 32)}.json`);

export function recordLaunch(file, launch, dir = STATE_DIR) {
  mkdirSync(join(dir, "jobs"), { recursive: true });
  writeAtomic(recordFile(file, dir), `${JSON.stringify({ file: realpathSync(file), ...launch })}\n`);
}

function launchRecord(file) {
  try {
    return JSON.parse(readFileSync(recordFile(file, STATE_DIR), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const NAMED_ROLE = /^\d{6}-\d{4}-(pm|devops|dev|review)-/;
const MODE = /^[A-Za-z]+$/;

function trusted(map, file) {
  const job = readJob(file);
  const real = realpathSync(job.path);
  if (!existsSync(jobsDir(map)) || dirname(real) !== realpathSync(jobsDir(map))) throw new Error(`${file} is not under ${jobsDir(map)} of this project`);
  const named = basename(real).match(NAMED_ROLE)?.[1];
  if (named !== job.role) throw new Error(`${file}: its to: ${job.to} does not match the role ${named ?? "(none)"} in its file name`);
  if (job.permission_mode !== undefined && !MODE.test(job.permission_mode)) throw new Error(`${file}: its permission_mode: ${job.permission_mode} is not a mode name`);
  const record = launchRecord(real);
  if (!record) return { ...job, record: null };
  for (const key of ["role", "cwd", "permission_mode", "session_id"]) {
    if (job[key] !== record[key]) throw new Error(`${file}: its ${key}: ${job[key] ?? "(none)"} differs from the launch record (${record[key] ?? "none"}); a job file may not change it`);
  }
  if (record.cwd !== map.paths[0]) writableRepo(map, record.cwd);
  return { ...job, record };
}

function launched(file, claude, args, cwd, name, previous, launch) {
  const since = Date.now();
  const { status, stdout, stderr } = spawned(claude, args, cwd);
  if (status !== 0) {
    const text = `${(stderr || stdout).trim()}${trustHint(stderr || stdout, cwd)}`;
    writeAtomic(file, withSection(setStatus(readFileSync(file, "utf8"), "stopped", new Date().toISOString()), "Outcome", `The launch failed: ${text}`));
    console.error(text);
    throw new Error(`the launch failed, so the job is stopped: ${file}`);
  }
  const { found, problem } = launchedRow(claude, `${stdout}\n${stderr}`, name, previous, since);
  const text = readFileSync(file, "utf8");
  writeAtomic(file, found ? setKey(text, "session_id", found.sessionId) : withoutKey(text, "session_id"));
  recordLaunch(file, { ...launch, session_id: found?.sessionId });
  return found ? null : `warning: ${name} was started, but its session id could not be read (${problem}); the job file has no session_id, so job.mjs list shows it lost; find the session by name in claude agents`;
}

function createJob(dir, base, text) {
  mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n += 1) {
    const file = join(dir, `${n === 1 ? base : `${base}-${n}`}.md`);
    try {
      createAtomic(file, text(file));
      return file;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

export function start(map, role, { title, body, repo, mode, dryRun = false, claude = claudeCli }) {
  if (map.jobs !== true) throw new Error(`the project map ${map.name} does not set "jobs": true; hand the work over per ${join(PLUGIN, "shared", "handoff.md")} instead`);
  if (!JOB_ROLES.includes(role)) throw new Error(`unknown role ${role}; use pm, dev, review or devops`);
  const line = String(title ?? "").replace(/\s+/g, " ").trim();
  const slug = slugOf(line);
  if (!slug) throw new Error(`the title has no words: ${title}`);
  const missing = missingSections(body);
  if (missing.length) throw new Error(`the body lacks ${missing.join(", ")}; see ${JOBS_DOC}`);
  if (mode !== undefined && !MODE.test(mode)) throw new Error(`--permission-mode ${mode} is not a mode name`);
  const cwd = repo ? writableRepo(map, repo) : map.paths[0];
  const base = join(jobsDir(map), `${stamp()}-${role}-${slug}`);
  const argv = (file) => ["--agent", `tedy:${role}`, "--bg", "--name", jobName(map, role, file), ...launchArgs(role, map, mode), startPrompt(role, file)];
  if (dryRun) {
    let n = 1;
    while (existsSync(`${n === 1 ? base : `${base}-${n}`}.md`)) n += 1;
    return `cd ${shellWord(cwd)} && claude ${argv(`${n === 1 ? base : `${base}-${n}`}.md`).map(shellWord).join(" ")}`;
  }
  const created = new Date().toISOString();
  const header = [["cwd", cwd], ["permission_mode", mode]].filter(([, value]) => value).reduce((text, [key, value]) => setKey(text, key, value), setStatus(render({ to: `tedy:${role}`, from: "cockpit", title: line, body, created }), "running", created));
  const file = createJob(jobsDir(map), basename(base), () => header);
  const launch = { role, cwd, permission_mode: mode };
  recordLaunch(file, launch);
  const warning = launched(file, claude, argv(file), cwd, jobName(map, role, file), undefined, launch);
  return [`started: ${jobName(map, role, file)} ${file}`, warning].filter(Boolean).join("\n");
}

function open(file) {
  const job = readJob(file);
  if (job.status === "closed") throw new Error(`${file} is already closed`);
  return job;
}

function finish(file, status, outcome) {
  const job = open(file);
  writeAtomic(job.path, withSection(setStatus(job.text, status, new Date().toISOString()), "Outcome", outcome));
  return job.path;
}

export function done(file, outcome) {
  if (!String(outcome ?? "").trim()) throw new Error("the outcome is empty; name the drafts, cards, PR URLs or report path");
  return finish(file, "done", outcome);
}

export function stop(file, reason) {
  if (!String(reason ?? "").trim()) throw new Error("--reason needs a line");
  return finish(file, "stopped", `Stopped: ${reason}`);
}

function stopSession(job, claude, waitMs) {
  const row = fleet(claude).find((item) => item.sessionId === job.session_id);
  if (!row) return null;
  if (!ENDED.has(row.state)) call(claude, ["stop", row.id]);
  for (const until = Date.now() + waitMs; ; sleep(500)) {
    const now = fleet(claude).find((item) => item.sessionId === job.session_id);
    if (!now || ENDED.has(now.state)) return row;
    if (Date.now() > until) throw new Error(`the session ${row.id} did not stop within ${waitMs / 1000} s; nothing was resumed or closed, run the command again`);
  }
}

export function resume(map, file, note, { claude = claudeCli, waitMs = 30_000 } = {}) {
  const job = trusted(map, file);
  if (job.status === "closed") throw new Error(`${file} is closed; start a new job instead`);
  if (!String(note ?? "").trim()) throw new Error("the note is empty");
  if (!job.record) throw new Error(`${file} has no launch record, so it was not started by job.mjs start here; close it and start a new job`);
  if (!job.session_id) throw new Error(`${file} has no session_id, so its session cannot be resumed; close it with --reason and start a new job`);
  stopSession(job, claude, waitMs);
  const at = new Date().toISOString();
  const fresh = readJob(job.path);
  if (fresh.status === "closed") throw new Error(`${file} was closed while its session stopped; nothing was resumed`);
  writeAtomic(job.path, withSection(setStatus(fresh.text, "running", at), `Note ${at}`, note));
  const prompt = `${note.trim()}\n\nThis is the latest ## Note of your job ${job.path}. Go on per ${JOBS_DOC}, section "Job", and end with job.mjs done or stop.`;
  const { role, cwd, permission_mode: mode } = job.record;
  const warning = launched(job.path, claude, ["--resume", job.session_id, "--bg", "--agent", `tedy:${role}`, ...launchArgs(role, map, mode), prompt], cwd, jobName(map, role, job.path), job.session_id, { role, cwd, permission_mode: mode });
  return [`resumed: ${job.path}`, warning].filter(Boolean).join("\n");
}

export function close(map, file, reason, { claude = claudeCli, waitMs = 30_000 } = {}) {
  const job = trusted(map, file);
  if (job.status === "closed") throw new Error(`${file} is already closed`);
  if (job.status === "running" && !reason) throw new Error(`${file} is still running; give --reason to stop it, or wait for job.mjs done`);
  if (job.status === "running") stop(file, reason);
  const row = job.record?.session_id ? stopSession(job, claude, waitMs) : null;
  if (row) call(claude, ["rm", row.id]);
  writeAtomic(job.path, setStatus(readFileSync(job.path, "utf8"), "closed", new Date().toISOString()));
  return [`closed: ${job.path}`, job.record ? null : `warning: ${file} has no launch record, so no session was stopped or removed; check claude agents by name`].filter(Boolean).join("\n");
}

export function list(map, { claude = claudeCli } = {}) {
  const jobs = listJobs(map);
  const rows = jobs.some((job) => job.status === "running") ? fleet(claude) : [];
  return jobs.map((job) => {
    const row = job.session_id && rows.find((item) => item.sessionId === job.session_id);
    const status = job.status !== "running" ? job.status : !row || ENDED.has(row.state) ? "lost" : row.waitingFor ? `waiting: ${row.waitingFor}, claude attach ${row.id}` : job.status;
    return `${job.role} · ${job.title} · ${status} · ${age(job.created)} · ${job.path}`;
  });
}

function flags(args) {
  const found = {};
  for (const [index, arg] of args.entries()) {
    if (!arg.startsWith("--")) continue;
    const next = args[index + 1];
    found[arg.slice(2)] = next === undefined || next.startsWith("--") ? true : next;
  }
  return found;
}

function project() {
  const resolved = resolveMap(process.cwd());
  if (!resolved) throw new Error(`no project map covers ${process.cwd()}; run /tedy:setup`);
  return resolved.map;
}

const text = (value) => (typeof value === "string" ? value : undefined);

function main([command, target, ...rest]) {
  const given = flags(rest);
  if (command === "start" && target && text(given.title) && text(given["body-file"])) {
    console.log(start(project(), target, { title: given.title, body: readFileSync(given["body-file"], "utf8"), repo: text(given.repo), mode: text(given["permission-mode"]), dryRun: given["dry-run"] === true }));
    return 0;
  }
  if (command === "done" && target && text(given["outcome-file"])) {
    console.log(`done: ${done(target, readFileSync(given["outcome-file"], "utf8"))}`);
    return 0;
  }
  if (command === "stop" && target && text(given.reason)) {
    console.log(`stopped: ${stop(target, given.reason)}`);
    return 0;
  }
  if (command === "resume" && target && text(given["note-file"])) {
    console.log(resume(project(), target, readFileSync(given["note-file"], "utf8")));
    return 0;
  }
  if (command === "close" && target) {
    console.log(close(project(), target, text(given.reason)));
    return 0;
  }
  if (command === "list") {
    console.log(list(project()).join("\n") || "No jobs are open.");
    return 0;
  }
  console.error("usage: job.mjs start <pm|dev|review|devops> --title <t> --body-file <f> [--repo <path>] [--permission-mode <mode>] [--dry-run] | done <job file> --outcome-file <f> | stop <job file> --reason <text> | resume <job file> --note-file <f> | close <job file> [--reason <text>] | list");
  return 2;
}

export function run() {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`job: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
