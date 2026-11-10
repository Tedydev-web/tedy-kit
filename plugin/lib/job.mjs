import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { missingSections, render, setStatus, slugOf, stamp } from "./handoff.mjs";
import { age, createAtomic, JOB_ROLES, jobsDir, launchRecordPath, listJobs, readJob, readRecord, recordLaunch, removeRecord, setKey, updateRecord, withSection, writeAtomic } from "./job-files.mjs";
import { chooseAdapter, closeHerdrPane, HerdrError, herdrAgent, herdrName, herdrState, herdrTab, herdrWorktree, onPath, t3Instance, t3SettingsPath, upsertT3Instances } from "./job-adapters.mjs";
import { addWorktree, git as gitRun, linkedWorktree, merged, planWorktree, removeWorktree, t3Strategy } from "./job-worktrees.mjs";
import { alive, ancestors, claudeProcess, processInfo, recordOfProcesses } from "./job-session-hooks.mjs";
import { profileDir } from "./profile.mjs";
import { STATE_DIR } from "./state-dir.mjs";
import { loadMaps, resolveMap } from "./project-map.mjs";

const SKILLS = { pm: "pm", dev: "dev", review: "review-pr" };
const PLUGIN = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const JOBS_DOC = join(PLUGIN, "shared", "jobs.md");

const KIT_READERS = ["draft-lint.mjs", "project-map.mjs", "project-state.mjs get", "profile.mjs path", "labels.mjs", "prd-section.mjs", "figma-read.mjs", "task-lint.mjs", "op-status.mjs", "openproject.mjs get", "openproject.mjs list", "openproject.mjs preview", "openproject.mjs pr-body", "gdoc-comments.mjs list", "figma-comments.mjs list", "merged-sweep.mjs", "pending.mjs card publish", "pending.mjs card question", "pending.mjs card notify", "job.mjs done", "job.mjs stop"];
const READ_GIT = ["status*", "diff*", "log*", "show*", "fetch -q origin", "rev-parse --path-format=absolute --git-dir --git-common-dir"];
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

const startPrompt = (role, file) => (role === "devops" ? `Job file ${JSON.stringify(file)}. Read ${JOBS_DOC}, section "Job", then do the job.` : `/tedy:${SKILLS[role]} job ${JSON.stringify(file)}. First read ${JOBS_DOC}, section "Job".`);

const jobName = (map, role, file) => `${role} ${map.name} ${basename(file, ".md").replace(/^\d{6}-\d{4}-/, "").slice(`${role}-`.length)}`;

const word = (text) => (/^[A-Za-z0-9:_-]+$/.test(text) ? text : quoted(text));

const pluginDir = () => (process.env.TEDY_JOB_PLUGIN_DIR ? ["--plugin-dir", process.env.TEDY_JOB_PLUGIN_DIR] : []);

const claudeArgs = ({ role, settings, prompt, mode, resume }) => [...(resume ? ["--resume", resume] : []), "--agent", `tedy:${role}`, "--settings", settings, ...(mode ? ["--permission-mode", mode] : []), ...pluginDir(), prompt];

function launchSpec({ role, cwd, title, settings, prompt, mode, resume, via, strategy }) {
  const args = claudeArgs({ role, settings, prompt, mode, resume });
  const t3 = { instanceId: t3Instance(role), title, message: prompt, ...(strategy && { workspaceStrategy: strategy }) };
  return { role, cwd, title, agent: `tedy:${role}`, settings, prompt, ...(resume && { resume }), via, ...(via === "t3" && { t3 }), command: `cd ${quoted(cwd)} && claude ${args.map(word).join(" ")}` };
}

function openPane(adapter, forced, { cwd, label, tree }) {
  if (adapter !== "herdr") return { adapter, warnings: [] };
  try {
    return { adapter, warnings: [], ...(tree ? herdrWorktree({ ...tree, label }) : herdrTab({ cwd, label })) };
  } catch (error) {
    if (!(error instanceof HerdrError) || forced) throw error;
    return { adapter: "print", warnings: [`warning: ${error.message}; run the command below in any terminal`] };
  }
}

function startAgent(file, spec, args, opened, turn) {
  if (opened.adapter !== "herdr") return { spec, warnings: opened.warnings };
  const herdr = { name: herdrName(spec.role, file, turn), pane: opened.pane };
  const recordVia = (fields) => updateRecord(launchRecordPath(file), (record) => record && { ...record, ...fields });
  try {
    const warnings = herdrAgent({ ...herdr, args });
    recordVia({ via: "herdr", herdr });
    return { spec: { ...spec, via: "herdr", herdr }, warnings: [...opened.warnings, ...warnings] };
  } catch (error) {
    if (!(error instanceof HerdrError)) throw error;
    recordVia({ via: "print" });
    return { spec: { ...spec, via: "print" }, warnings: [...opened.warnings, `warning: ${error.message}; run the command below in any terminal`] };
  }
}

const launchArgs = (role, file) => ["--agent", `tedy:${role}`, "--settings", file, ...pluginDir()];

export function t3InstanceText(role, current) {
  const file = writeSettings(role, current);
  const env = Object.entries(JSON.parse(readFileSync(file, "utf8")).env ?? {}).map(([key, value]) => `${key}=${value}`);
  return [`Instance name: ${t3Instance(role)}`, `Launch arguments: ${launchArgs(role, file).join(" ")}`, ...(env.length ? ["Environment:", ...env] : ["Environment: none"])].join("\n");
}

function t3InstanceConfig(role, current) {
  const args = launchArgs(role, writeSettings(role, current));
  const spaced = args.find((arg) => /\s/.test(arg));
  if (spaced) throw new Error(`the Launch argument ${spaced} holds a space, which T3 would split; nothing was written`);
  return { driver: "claudeAgent", displayName: `tedy ${role}`, enabled: true, config: { launchArgs: args.join(" ") } };
}

export function writeT3Instances(roles, current) {
  const instances = Object.fromEntries(roles.map((role) => [t3Instance(role), t3InstanceConfig(role, current)]));
  const file = t3SettingsPath();
  const { changes, backup } = upsertT3Instances(instances, file);
  const lines = changes.map(([id, change]) => `${id}: ${change} (Launch arguments: ${instances[id].config.launchArgs})`);
  return (backup ? [`backed up ${file} to ${backup}`, ...lines, `wrote ${file}; T3 Code loads it without a restart`] : [...lines, `${file} already holds these instances; nothing was written`]).join("\n");
}

const launchRecord = (file) => readRecord(launchRecordPath(file));

const RECORDED = ["role", "cwd", "permission_mode", "repo"];
const SESSION_KEYS = ["session_id", "transcript_path", "pid", "pid_start", "bound_at", "state", "last_event_at", "herdr"];

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
  const repo = record.repo ?? record.cwd;
  if (repo !== map.paths[0]) writableRepo(map, repo);
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

function worktreeFor(opened, tree) {
  if (!tree) return {};
  if (opened.adapter === "t3") return { owner: "t3" };
  if (opened.adapter === "herdr") return { owner: "herdr", path: opened.cwd };
  addWorktree(tree);
  return { owner: "core", path: tree.path };
}

export function start(map, role, { title, body, repo, mode, via, t3, branch }) {
  if (map.jobs !== true) throw new Error(`the project map ${map.name} does not set "jobs": true; hand the work over per ${join(PLUGIN, "shared", "handoff.md")} instead`);
  if (!JOB_ROLES.includes(role)) throw new Error(`unknown role ${role}; use pm, dev, review or devops`);
  const line = String(title ?? "").replace(/\s+/g, " ").trim();
  const slug = slugOf(line);
  if (!slug) throw new Error(`the title has no words: ${title}`);
  const missing = missingSections(body);
  if (missing.length) throw new Error(`the body lacks ${missing.join(", ")}; see ${JOBS_DOC}`);
  if (mode !== undefined && !MODE.test(mode)) throw new Error(`--permission-mode ${mode} is not a mode name`);
  const adapter = chooseAdapter({ via, t3 });
  const repoPath = repo ? writableRepo(map, repo) : null;
  const tree = role === "dev" && repoPath ? planWorktree(map, repoPath, { branch, slug }) : null;
  if (branch !== undefined && !tree) throw new Error("--branch applies only to a dev job with --repo");
  const settings = writeSettings(role, map);
  const opened = openPane(adapter, via === adapter, { cwd: repoPath ?? map.paths[0], label: `${role} ${map.name} ${slug}`, tree });
  const worktree = worktreeFor(opened, tree);
  const cwd = worktree.path ?? repoPath ?? map.paths[0];
  const created = new Date().toISOString();
  const keys = [["cwd", cwd], ["permission_mode", mode], ["repo", repoPath], ["branch", tree?.branch], ["base", tree?.base], ["worktree", worktree.path], ["worktree_owner", worktree.owner]];
  const header = keys.filter(([, value]) => value).reduce((text, [key, value]) => setKey(text, key, value), setStatus(render({ to: `tedy:${role}`, from: "cockpit", title: line, body, created }), "running", created));
  const file = createJob(jobsDir(map), `${stamp()}-${role}-${slug}`, () => header);
  recordLaunch(file, { role, cwd, permission_mode: mode, settings, created, via: opened.adapter, ...(repoPath && { repo: repoPath }), ...(tree && { branch: tree.branch, base: tree.base, worktree_owner: worktree.owner }), ...(worktree.path && { worktree: worktree.path }) });
  const prompt = startPrompt(role, file);
  const spec = launchSpec({ role, cwd, title: jobName(map, role, file), settings, prompt, mode, via: opened.adapter, strategy: worktree.owner === "t3" && t3Strategy(tree) });
  return startAgent(realpathSync(file), spec, claudeArgs({ role, settings, prompt, mode }), opened, 0);
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

function signal(record, name, kill) {
  try {
    kill(record.pid, name);
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    throw new Error(`the kit may not signal pid ${record.pid} of session ${record.session_id} (EPERM: it runs as another user); the job is not closed. End that session yourself, then run job.mjs close again`);
  }
}

function endSession(record, { waitMs = 5000, own = claudeProcess, kill = process.kill } = {}) {
  if (!record) return [];
  if (!record.session_id) return ["no session was bound to this job, so nothing was signalled; a session started later from its printed command, T3 thread or herdr pane is not tracked as this job"];
  if (!record.pid) return [`warning: no claude pid was recorded for session ${record.session_id}, so nothing was signalled`];
  if (!alive(record)) return processInfo(record.pid) ? [`warning: pid ${record.pid} now belongs to another process, so it was not signalled`] : [];
  if (own()?.pid === record.pid) return [`this is the job's own session (pid ${record.pid}); it is not signalled and stays open for the user`];
  const gone = (until) => {
    for (; Date.now() < until; sleep(100)) if (!alive(record)) return true;
    return !alive(record);
  };
  signal(record, "SIGTERM", kill);
  if (gone(Date.now() + waitMs)) return [`ended session ${record.session_id} (pid ${record.pid})`];
  signal(record, "SIGKILL", kill);
  if (gone(Date.now() + 2000)) return [`ended session ${record.session_id} (pid ${record.pid}) with SIGKILL after it ignored SIGTERM for ${waitMs / 1000} s`];
  throw new Error(`pid ${record.pid} of session ${record.session_id} is still alive after SIGKILL`);
}

function readableRecord(file) {
  try {
    return { record: launchRecord(file) };
  } catch (error) {
    return { record: null, error: error.message };
  }
}

const withoutSession = (record) => Object.fromEntries(Object.entries(record).filter(([key]) => !SESSION_KEYS.includes(key)));

function closePane(record, { env = process.env } = {}) {
  const pane = record?.herdr?.pane;
  if (!pane) return [];
  if (env.HERDR_PANE_ID === pane) return [`left herdr pane ${pane} open: this command runs inside it`];
  if (!record.pid) return [`kept herdr pane ${pane}: no claude pid was recorded for session ${record.session_id ?? "(none)"}, so the kit cannot tell that it has ended; close the pane by hand once it has`];
  if (alive(record)) return [`kept herdr pane ${pane}: session ${record.session_id} still runs in it (pid ${record.pid})`];
  return [closeHerdrPane({ pane, session: record.session_id }, env)];
}

export function stop(file, reason) {
  if (!String(reason ?? "").trim()) throw new Error("--reason needs a line");
  return `stopped: ${finish(file, "stopped", `Stopped: ${reason}`)}`;
}

export function close(map, file, reason, options = {}) {
  const caller = recordOfProcesses(STATE_DIR, ancestors());
  if (caller) throw new Error(`job.mjs close runs in the session of the job ${caller.record.file}; a job never closes a job, its own included. Ask the user to close ${file} from the cockpit`);
  const job = inJobsDir(map, file);
  if (job.status === "closed") throw new Error(`${file} is already closed`);
  if (job.status === "running" && !reason) throw new Error(`${file} is still running; give --reason to stop it, or wait for job.mjs done`);
  const { record, error } = readableRecord(job.real);
  if (options.ifEnded && record && alive(record)) throw new Error(`${file}: session ${record.session_id} is still open (pid ${record.pid}), so nothing was closed; end that session in its own window, then close the job again`);
  if (job.status === "running") finish(job.path, "stopped", `Stopped: ${reason}`);
  const lines = [...(error ? [`warning: ${error}; nothing was signalled`] : []), ...endSession(record, options), ...closePane(record, options)];
  writeAtomic(job.path, setStatus(readFileSync(job.path, "utf8"), "closed", new Date().toISOString()));
  const live = Boolean(record?.pid) && alive(record);
  const tree = !coreWorktree(record) ? [] : live ? [`kept ${record.worktree}: its session is still open`] : [removeWorktree(record, "the job is closed")];
  if (tree.length && existsSync(record.worktree)) updateRecord(launchRecordPath(job.real), (fresh) => (live ? (fresh ?? record) : withoutSession(fresh ?? record)));
  else removeRecord(launchRecordPath(job.real));
  return [`closed: ${job.path}`, ...lines, ...tree].join("\n");
}

const DAY = 86_400_000;

const recordedTree = (record) => record?.worktree_owner === "core" && Boolean(record.worktree && record.repo);

const coreWorktree = (record) => recordedTree(record) && existsSync(record.worktree);

function pruneDecision(job, record, days, now) {
  if (alive(record)) return { why: "its session is open" };
  if (job.status === "closed") return { reason: "the job is closed" };
  const finished = job.status === "done" || job.status === "stopped";
  if (finished && merged(record)) return { reason: `its branch is merged into origin/${record.base}` };
  const idle = now - Date.parse(record.last_event_at ?? record.bound_at ?? job.updated ?? job.created);
  if (idle > days * DAY) return { reason: `idle for ${Math.floor(idle / DAY)} days` };
  return { why: `the job is ${job.status}${finished ? `, its branch is not merged into origin/${record.base} and it` : " and"} was active within ${days} days` };
}

function pruneJob({ job, record }, days, dryRun, now) {
  try {
    const { reason, why } = pruneDecision(job, record, days, now);
    if (why) return `kept ${record.worktree}: ${why}`;
    const result = removeWorktree(record, reason, dryRun);
    if (job.status === "closed" && !existsSync(record.worktree)) forget(job.path);
    return result;
  } catch (error) {
    return `kept ${record.worktree}: ${error.message}`;
  }
}

function recordedJobs(map, dryRun) {
  return listJobs(map, { closed: true }).flatMap((job) => {
    const { record, error } = readableRecord(job.path);
    if (error) return [{ warning: `warning: ${error}; the worktree of ${job.path} was not checked` }];
    if (!recordedTree(record)) return [];
    if (existsSync(record.worktree)) return [{ job, record }];
    if (job.status === "closed" && !dryRun) forget(job.path);
    return [];
  });
}

const forget = (file) => removeRecord(launchRecordPath(file));

export function prune(map, { days = 10, dryRun = false, now = Date.now() } = {}) {
  if (!Number.isInteger(days) || days < 1) throw new Error("--days needs a whole number of days above 0");
  const found = recordedJobs(map, dryRun);
  const jobs = found.filter((entry) => entry.job);
  const unread = found.flatMap((entry) => (entry.warning ? [entry.warning] : []));
  const warnings = [...new Set(jobs.map(({ record }) => record.repo))].flatMap((repo) => {
    try {
      gitRun(repo, "fetch", "-q", "origin");
      return [];
    } catch (error) {
      return [`warning: ${error.message}; the merged and pushed checks use the last fetched refs`];
    }
  });
  return [...unread, ...warnings, ...jobs.map((entry) => pruneJob(entry, days, dryRun, now))];
}

export function resume(map, file, note, { via, t3 } = {}) {
  const adapter = chooseAdapter({ via, t3 });
  const job = trusted(map, file);
  if (job.status === "closed") throw new Error(`${file} is closed; start a new job instead`);
  if (!String(note ?? "").trim()) throw new Error("the note is empty");
  if (!job.record) throw new Error(`${file} has no launch record, so it was not started by job.mjs start here; close it and start a new job`);
  const { record } = job;
  if (!record.session_id) throw new Error(`${file} has no session yet; run the command job.mjs start printed for it, or close it and start a new job`);
  const cwd = record.session_cwd ?? record.cwd;
  if (!existsSync(cwd)) throw new Error(`${file}: its folder ${cwd} no longer exists; close it and start a new job`);
  if (alive(record)) throw new Error(`${file}: session ${record.session_id} is still open (pid ${record.pid}); type the note in its open thread or pane, or close that session first, then run job.mjs resume again; nothing was resumed`);
  const strategy = adapter === "t3" && Boolean(record.worktree_owner) && cwd !== record.repo && linkedWorktree(cwd) && { type: "existing_worktree", worktreePath: cwd };
  const title = jobName(map, record.role, job.path);
  const opened = openPane(adapter, via === adapter, { cwd, label: title });
  const session = record.session_id;
  const earlier = [...(record.earlier ?? []), session];
  updateRecord(launchRecordPath(job.real), (fresh) => {
    if (fresh?.session_id !== session) throw new Error(`${file}: its launch record changed while resuming (session ${fresh?.session_id ?? "none"}, not ${session}); nothing was resumed, run the command again`);
    return { ...withoutSession(fresh), earlier, via: opened.adapter };
  });
  const at = new Date().toISOString();
  writeAtomic(job.path, withSection(setStatus(job.text, "running", at), `Note ${at}`, note));
  const prompt = `${startPrompt(record.role, job.path)} The job is resumed: the latest ## Note in the job file, quoted below, is the rework request. Go on with it and end with job.mjs done or stop.\n\n${note.trim()}`;
  const settings = writeSettings(record.role, map);
  const launch = { role: record.role, settings, prompt, mode: record.permission_mode, resume: session };
  const started = startAgent(job.real, launchSpec({ ...launch, cwd, title, via: opened.adapter, strategy }), claudeArgs(launch), opened, earlier.length);
  return started;
}

function kitStatus(record) {
  if (!record.session_id) return "not started";
  if (!record.pid && !record.bound_at) return "lost (no pid recorded, started by an older kit)";
  if (!record.pid) return "unknown (no pid recorded)";
  if (!alive(record)) return `lost (last seen ${record.last_event_at ?? record.bound_at ?? "never"})`;
  return record.state ?? "running";
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
  const state = kitStatus(record);
  if (!record.herdr?.name || /^(waiting|lost)/.test(state) || !onPath("herdr")) return state;
  return `${state} (herdr: ${herdrState(record.herdr.name)})`;
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

function printLaunch({ spec, warnings }, json) {
  for (const warning of warnings) console.error(warning);
  if (json) console.log(JSON.stringify(spec, null, 2));
  else console.log(spec.via === "herdr" ? `herdr agent ${spec.herdr.name} started in pane ${spec.herdr.pane}` : spec.command);
}

const adapterFlags = (given) => ({ via: given.via === true ? "" : given.via, t3: given.t3 !== undefined });

function main([command, target, ...rest]) {
  const given = flags(rest);
  if (command === "settings" && target) {
    console.log(writeSettings(target, resolveMap(process.cwd())?.map));
    return 0;
  }
  if (command === "t3-instance") {
    const args = [target, ...rest].filter((arg) => arg !== undefined);
    const named = args.filter((arg) => !arg.startsWith("--"));
    const all = args.includes("--all");
    const extra = args.filter((arg) => arg.startsWith("--") && !["--all", "--write"].includes(arg));
    if (named.length === (all ? 0 : 1) && !extra.length) {
      const roles = all ? [...JOB_ROLES] : named;
      const current = resolveMap(process.cwd())?.map;
      console.log(args.includes("--write") ? writeT3Instances(roles, current) : roles.map((role) => t3InstanceText(role, current)).join("\n\n"));
      return 0;
    }
  }
  if (command === "start" && target && text(given.title) && text(given["body-file"])) {
    printLaunch(start(project(), target, { title: given.title, body: readFileSync(given["body-file"], "utf8"), repo: text(given.repo), mode: text(given["permission-mode"]), branch: text(given.branch), ...adapterFlags(given) }), given.json === true);
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
    printLaunch(resume(project(), target, readFileSync(given["note-file"], "utf8"), adapterFlags(given)), given.json === true);
    return 0;
  }
  if (command === "close" && target) {
    console.log(close(project(), target, text(given.reason), { ifEnded: given["if-ended"] !== undefined }));
    return 0;
  }
  if (command === "list") {
    console.log(list(project()).join("\n") || "No jobs are open.");
    return 0;
  }
  if (command === "prune") {
    const options = flags([target, ...rest].filter((arg) => arg !== undefined));
    console.log(prune(project(), { days: options.days === undefined ? undefined : Number(options.days), dryRun: options["dry-run"] === true }).join("\n") || "No job worktrees to prune.");
    return 0;
  }
  console.error("usage: job.mjs settings <pm|dev|review|devops> | t3-instance <pm|dev|review|devops>|--all [--write] | start <pm|dev|review|devops> --title <t> --body-file <f> [--repo <path>] [--branch <name>] [--permission-mode <mode>] [--via t3|herdr|print] [--t3] [--json] | done <job file> --outcome-file <f> | stop <job file> --reason <text> | resume <job file> --note-file <f> [--via t3|herdr|print] [--t3] [--json] | close <job file> [--reason <text>] [--if-ended] | list | prune [--days <n>] [--dry-run]");
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
