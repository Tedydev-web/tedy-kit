import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { missingSections, render, setStatus, slugOf, stamp } from "./handoff.mjs";
import { age, createAtomic, JOB_ROLES, jobsDir, launchRecordPath, listJobs, readJob, recordLaunch, setKey, withSection, writeAtomic, writeRecord } from "./job-files.mjs";
import { alive, claudeProcess, processInfo } from "./job-session-hooks.mjs";
import { profileDir } from "./profile.mjs";
import { STATE_DIR } from "./state-dir.mjs";
import { loadMaps, resolveMap } from "./project-map.mjs";

const SKILLS = { pm: "pm", dev: "dev", review: "review-pr" };
const PLUGIN = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const JOBS_DOC = join(PLUGIN, "shared", "jobs.md");

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

export const askRules = ({ profile, state }) => ["Bash(git *--output*)", `Edit(/${profile}/**)`, ...(state ? [`Edit(/${state}/**)`] : [])];

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const quoted = (word) => `'${word.replaceAll("'", `'"'"'`)}'`;

function writableRepo(map, given) {
  const root = map.paths[0];
  const path = resolve(root, given);
  const repo = (map.repos ?? []).find((item) => resolve(root, item.path) === path);
  if (!repo) throw new Error(`${given} is not a repository in the project map`);
  if (repo.readonly) throw new Error(`${given} is read-only in the project map; a job may not write there`);
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  return path;
}

export const settingsPath = (role) => join(STATE_DIR, "jobs", "settings", `${role}.json`);

export function writeSettings(role, current) {
  if (!JOB_ROLES.includes(role)) throw new Error(`unknown role ${role}; use pm, dev, review or devops`);
  const maps = [...(current ? [current] : []), ...loadMaps().map((entry) => entry.map)].filter((map) => map.jobs === true && map.paths?.[0]);
  const profile = profileDir();
  const allow = [...new Set(maps.flatMap((map) => allowRules(role, { plugin: PLUGIN, root: map.paths[0], profile })))];
  const env = Object.fromEntries(["TEDY_STATE_DIR", "TEDY_PROFILE_DIR"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  const file = settingsPath(role);
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify({ permissions: { allow, ask: askRules({ profile, state: STATE_DIR }) }, ...(Object.keys(env).length && { env }) }, null, 2)}\n`);
  return file;
}

const startPrompt = (role, file) => (role === "devops" ? `Job file ${file}. Read ${JOBS_DOC}, section "Job", then do the job.` : `/tedy:${SKILLS[role]} job ${file}. First read ${JOBS_DOC}, section "Job".`);

const jobName = (map, role, file) => `${role} ${map.name} ${basename(file, ".md").replace(/^\d{6}-\d{4}-/, "").slice(`${role}-`.length)}`;

function launchSpec({ role, cwd, title, settings, prompt, mode, resume }) {
  const flags = [...(resume ? ["--resume", resume] : []), "--agent", `tedy:${role}`, "--settings", quoted(settings), ...(mode ? ["--permission-mode", mode] : []), ...(process.env.TEDY_JOB_PLUGIN_DIR ? ["--plugin-dir", quoted(process.env.TEDY_JOB_PLUGIN_DIR)] : [])];
  return { role, cwd, title, agent: `tedy:${role}`, settings, prompt, ...(resume && { resume }), command: `cd ${quoted(cwd)} && claude ${flags.join(" ")} ${quoted(prompt)}` };
}

function launchRecord(file) {
  const path = launchRecordPath(file);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`the launch record ${path} cannot be read (${error.message})`);
  }
}

const RECORDED = ["role", "cwd", "permission_mode"];
const SESSION_KEYS = ["session_id", "transcript_path", "pid", "pid_start", "bound_at", "state", "last_event_at"];

const differences = (file, job, record) => RECORDED.filter((key) => job[key] !== record[key]).map((key) => `${file}: its ${key}: ${job[key] ?? "(none)"} differs from the launch record (${record[key] ?? "none"})`);

const NAMED_ROLE = /^\d{6}-\d{4}-(pm|devops|dev|review)-/;
const MODE = /^[A-Za-z]+$/;

function inJobsDir(map, file) {
  const job = readJob(file);
  const real = realpathSync(job.path);
  if (!existsSync(jobsDir(map)) || dirname(real) !== realpathSync(jobsDir(map))) throw new Error(`${file} is not under ${jobsDir(map)} of this project`);
  return { ...job, real };
}

function trusted(map, file) {
  const job = inJobsDir(map, file);
  const named = basename(job.real).match(NAMED_ROLE)?.[1];
  if (named !== job.role) throw new Error(`${file}: its to: ${job.to} does not match the role ${named ?? "(none)"} in its file name`);
  if (job.permission_mode !== undefined && !MODE.test(job.permission_mode)) throw new Error(`${file}: its permission_mode: ${job.permission_mode} is not a mode name`);
  const record = launchRecord(job.real);
  if (!record) return { ...job, record: null };
  const [different] = differences(file, job, record);
  if (different) throw new Error(`${different}; a job file may not change it`);
  if (record.cwd !== map.paths[0]) writableRepo(map, record.cwd);
  return { ...job, record };
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

export function start(map, role, { title, body, repo, mode }) {
  if (map.jobs !== true) throw new Error(`the project map ${map.name} does not set "jobs": true; hand the work over per ${join(PLUGIN, "shared", "handoff.md")} instead`);
  if (!JOB_ROLES.includes(role)) throw new Error(`unknown role ${role}; use pm, dev, review or devops`);
  const line = String(title ?? "").replace(/\s+/g, " ").trim();
  const slug = slugOf(line);
  if (!slug) throw new Error(`the title has no words: ${title}`);
  const missing = missingSections(body);
  if (missing.length) throw new Error(`the body lacks ${missing.join(", ")}; see ${JOBS_DOC}`);
  if (mode !== undefined && !MODE.test(mode)) throw new Error(`--permission-mode ${mode} is not a mode name`);
  const cwd = repo ? writableRepo(map, repo) : map.paths[0];
  const settings = writeSettings(role, map);
  const created = new Date().toISOString();
  const header = [["cwd", cwd], ["permission_mode", mode]].filter(([, value]) => value).reduce((text, [key, value]) => setKey(text, key, value), setStatus(render({ to: `tedy:${role}`, from: "cockpit", title: line, body, created }), "running", created));
  const file = createJob(jobsDir(map), `${stamp()}-${role}-${slug}`, () => header);
  recordLaunch(file, { role, cwd, permission_mode: mode, settings, created });
  return launchSpec({ role, cwd, title: jobName(map, role, file), settings, prompt: startPrompt(role, file), mode });
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

function endSession(record, { waitMs = 5000, own = claudeProcess } = {}) {
  if (!record?.pid) return record?.session_id ? [`warning: no claude pid was recorded for session ${record.session_id}, so nothing was signalled`] : [];
  if (!alive(record)) return processInfo(record.pid) ? [`warning: pid ${record.pid} now belongs to another process, so it was not signalled`] : [];
  if (own()?.pid === record.pid) return [`this is the job's own session (pid ${record.pid}); it is not signalled and stays open for the user`];
  const gone = (until) => {
    for (; Date.now() < until; sleep(100)) if (!alive(record)) return true;
    return !alive(record);
  };
  process.kill(record.pid, "SIGTERM");
  if (gone(Date.now() + waitMs)) return [`ended session ${record.session_id} (pid ${record.pid})`];
  process.kill(record.pid, "SIGKILL");
  if (gone(Date.now() + 2000)) return [`ended session ${record.session_id} (pid ${record.pid}) with SIGKILL after it ignored SIGTERM for ${waitMs / 1000} s`];
  throw new Error(`pid ${record.pid} of session ${record.session_id} is still alive after SIGKILL`);
}

function endRecordedSession(file, options) {
  let record;
  try {
    record = launchRecord(file);
  } catch (error) {
    return [`warning: ${error.message}; nothing was signalled`];
  }
  return endSession(record, options);
}

export function stop(file, reason, options) {
  if (!String(reason ?? "").trim()) throw new Error("--reason needs a line");
  const path = finish(file, "stopped", `Stopped: ${reason}`);
  return [`stopped: ${path}`, ...endRecordedSession(path, options)].join("\n");
}

export function close(map, file, reason, options) {
  const job = inJobsDir(map, file);
  if (job.status === "closed") throw new Error(`${file} is already closed`);
  if (job.status === "running" && !reason) throw new Error(`${file} is still running; give --reason to stop it, or wait for job.mjs done`);
  if (job.status === "running") finish(job.path, "stopped", `Stopped: ${reason}`);
  const lines = endRecordedSession(job.real, options);
  writeAtomic(job.path, setStatus(readFileSync(job.path, "utf8"), "closed", new Date().toISOString()));
  rmSync(launchRecordPath(job.real), { force: true });
  return [`closed: ${job.path}`, ...lines].join("\n");
}

export function resume(map, file, note) {
  const job = trusted(map, file);
  if (job.status === "closed") throw new Error(`${file} is closed; start a new job instead`);
  if (!String(note ?? "").trim()) throw new Error("the note is empty");
  if (!job.record) throw new Error(`${file} has no launch record, so it was not started by job.mjs start here; close it and start a new job`);
  const { record } = job;
  if (!record.session_id) throw new Error(`${file} has no session yet; run the command job.mjs start printed for it, or close it and start a new job`);
  const open = alive(record) ? [`warning: session ${record.session_id} is still open (pid ${record.pid}); type the note in its window, or end it before you run this command, because resuming a running session starts a copy`] : [];
  const at = new Date().toISOString();
  writeAtomic(job.path, withSection(setStatus(job.text, "running", at), `Note ${at}`, note));
  const session = record.session_id;
  const kept = Object.fromEntries(Object.entries(record).filter(([key]) => !SESSION_KEYS.includes(key)));
  writeRecord(launchRecordPath(job.real), { ...kept, earlier: [...(record.earlier ?? []), session] });
  const prompt = `${note.trim()}\n\nThis is the latest ## Note of your job ${job.path}. Go on per ${JOBS_DOC}, section "Job", and end with job.mjs done or stop.`;
  const settings = record.settings ?? writeSettings(record.role, map);
  return { spec: launchSpec({ role: record.role, cwd: record.cwd, title: jobName(map, record.role, job.path), settings, prompt, mode: record.permission_mode, resume: session }), warnings: open };
}

function status(job) {
  if (job.status !== "running") return job.status;
  let record;
  try {
    record = launchRecord(job.path);
  } catch (error) {
    return `unknown (${error.message})`;
  }
  if (!record) return "lost (no launch record)";
  if (!record.session_id) return "not started";
  if (!record.pid && !record.bound_at) return "lost (no pid recorded, started by an older kit)";
  if (record.pid && !alive(record)) return `lost (last seen ${record.last_event_at ?? record.bound_at ?? "never"})`;
  return record.state ?? "running";
}

export const list = (map) => listJobs(map).map((job) => `${job.role} · ${job.title} · ${status(job)} · ${age(job.created)} · ${job.path}`);

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

const printSpec = (spec, json) => console.log(json ? JSON.stringify(spec, null, 2) : spec.command);

function main([command, target, ...rest]) {
  const given = flags(rest);
  if (command === "settings" && target) {
    console.log(writeSettings(target, resolveMap(process.cwd())?.map));
    return 0;
  }
  if (command === "start" && target && text(given.title) && text(given["body-file"])) {
    printSpec(start(project(), target, { title: given.title, body: readFileSync(given["body-file"], "utf8"), repo: text(given.repo), mode: text(given["permission-mode"]) }), given.json === true);
    return 0;
  }
  if (command === "done" && target && text(given["outcome-file"])) {
    console.log(`done: ${done(target, readFileSync(given["outcome-file"], "utf8"))}`);
    return 0;
  }
  if (command === "stop" && target && text(given.reason)) {
    console.log(stop(target, given.reason));
    return 0;
  }
  if (command === "resume" && target && text(given["note-file"])) {
    const { spec, warnings } = resume(project(), target, readFileSync(given["note-file"], "utf8"));
    for (const warning of warnings) console.error(warning);
    printSpec(spec, given.json === true);
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
  console.error("usage: job.mjs settings <pm|dev|review|devops> | start <pm|dev|review|devops> --title <t> --body-file <f> [--repo <path>] [--permission-mode <mode>] [--json] | done <job file> --outcome-file <f> | stop <job file> --reason <text> | resume <job file> --note-file <f> [--json] | close <job file> [--reason <text>] | list");
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
