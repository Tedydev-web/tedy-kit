import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { missingSections, render, setStatus, slugOf, stamp } from "./handoff.mjs";
import { age, createAtomic, JOB_ROLES, jobsDir, launchRecordPath, listJobs, readJob, readRecord, recordLaunch, removeRecord, setKey, updateRecord, withSection, writeAtomic } from "./job-files.mjs";
import { addWorktree, git as gitRun, merged, planWorktree, removeWorktree } from "./job-worktrees.mjs";
import { agentRunning, claudeProcess, cockpitAlive } from "./job-session-hooks.mjs";
import { resolveMap } from "./project-map.mjs";

const SKILLS = { pm: "tedy:pm", review: "tedy:review-pr" };
const PLUGIN = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const JOBS_DOC = join(PLUGIN, "shared", "jobs.md");
const DEV_SKILL = join(PLUGIN, "skills", "dev", "SKILL.md");
const NAME_LIMIT = 32;
const RESUMED = "is resumed: the latest ## Note in the job file, quoted below, is the rework request. Go on with it and end with job.mjs done or stop.";

function writableRepo(map, given) {
  const root = map.paths[0];
  const path = resolve(root, given);
  const repo = (map.repos ?? []).find((item) => resolve(root, item.path) === path);
  if (!repo) throw new Error(`${given} is not a repository in the project map`);
  if (repo.readonly) throw new Error(`${given} is read-only in the project map; a job may not write there`);
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  return path;
}

function startPrompt(role, file) {
  const head = `Job file ${JSON.stringify(file)}. Plugin root: ${PLUGIN}; read <plugin> and \${CLAUDE_PLUGIN_ROOT} in kit files as that path. First read ${JOBS_DOC}, section "Job".`;
  if (SKILLS[role]) return `${head} Then invoke the Skill tool with skill "${SKILLS[role]}" and args ${JSON.stringify(`job ${file}`)}, and do the job in the job file.`;
  if (role === "dev") return `${head} Then Read ${DEV_SKILL} and follow it on the job in the job file; the Skill tool cannot invoke it.`;
  return `${head} Then do the job in the job file; devops has no skill.`;
}

function agentName(role, file) {
  const [, day, time, slug] = basename(file, ".md").match(/^(\d{6})-(\d{4})-[a-z]+-(.+)$/) ?? [];
  return slug ? `${role}-${day}${time}-${slug}`.slice(0, NAME_LIMIT).replace(/-+$/, "") : null;
}

const agentSpec = (role, title, name, prompt) => ({ subagent_type: `tedy:${role}`, run_in_background: true, name, description: [role, ...title.split(" ").slice(0, 4)].join(" "), prompt });

const launchRecord = (file) => readRecord(launchRecordPath(file));

const RECORDED = ["role", "cwd", "repo"];
const AGENT_KEYS = ["agent_id", "session_id", "transcript_path", "cockpit_pid", "cockpit_pid_start", "bound_at", "state", "last_event_at"];

const differences = (file, job, record) => RECORDED.filter((key) => job[key] !== record[key]).map((key) => `${file}: its ${key}: ${job[key] ?? "(none)"} differs from the launch record (${record[key] ?? "none"})`);

const NAMED_ROLE = /^\d{6}-\d{4}-(pm|devops|dev|review)-/;

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

const cockpitOf = (found) => (found ? { cockpit_pid: found.pid, cockpit_pid_start: found.start } : {});

export function start(map, role, { title, body, repo, branch }, { caller = claudeProcess } = {}) {
  if (map.jobs !== true) throw new Error(`the project map ${map.name} does not set "jobs": true; hand the work over per ${join(PLUGIN, "shared", "handoff.md")} instead`);
  if (!JOB_ROLES.includes(role)) throw new Error(`unknown role ${role}; use pm, dev, review or devops`);
  const line = String(title ?? "").replace(/\s+/g, " ").trim();
  const slug = slugOf(line);
  if (!slug) throw new Error(`the title has no words: ${title}`);
  const missing = missingSections(body);
  if (missing.length) throw new Error(`the body lacks ${missing.join(", ")}; see ${JOBS_DOC}`);
  const repoPath = repo ? writableRepo(map, repo) : null;
  const tree = role === "dev" && repoPath ? planWorktree(map, repoPath, { branch, slug }) : null;
  if (branch !== undefined && !tree) throw new Error("--branch applies only to a dev job with --repo");
  const cwd = tree?.path ?? repoPath ?? map.paths[0];
  const created = new Date().toISOString();
  const keys = [["cwd", cwd], ["repo", repoPath], ["branch", tree?.branch], ["base", tree?.base], ["worktree", tree?.path], ["worktree_owner", tree && "core"]];
  const header = keys.filter(([, value]) => value).reduce((text, [key, value]) => setKey(text, key, value), setStatus(render({ to: `tedy:${role}`, from: "cockpit", title: line, body, created }), "running", created));
  const file = createJob(jobsDir(map), `${stamp()}-${role}-${slug}`, () => header);
  const name = agentName(role, file);
  try {
    const taken = listJobs(map).find((job) => job.path !== file && agentName(job.role, job.path) === name);
    if (taken) throw new Error(`the agent name ${name} is already used by the open job ${taken.path}; close that job or start this one with a title whose first words differ; nothing was started`);
    if (tree) addWorktree(tree);
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
  recordLaunch(file, { role, cwd, created, agent_name: name, ...cockpitOf(caller()), ...(repoPath && { repo: repoPath }), ...(tree && { branch: tree.branch, base: tree.base, worktree_owner: "core", worktree: tree.path }) });
  return agentSpec(role, line, name, startPrompt(role, file));
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
  return `stopped: ${finish(file, "stopped", `Stopped: ${reason}`)}`;
}

const withoutAgent = (record) => Object.fromEntries(Object.entries(record).filter(([key]) => !AGENT_KEYS.includes(key)));

const runningRefusal = (file, record) => `${file}: its agent ${record.agent_name ?? record.agent_id} (${record.agent_id}) is ${record.state ?? "running"} in cockpit session ${record.session_id} (claude pid ${record.cockpit_pid})`;

export function close(map, file, reason) {
  const job = inJobsDir(map, file);
  if (job.status === "closed") throw new Error(`${file} is already closed`);
  if (job.status === "running" && !reason) throw new Error(`${file} is still running; give --reason to stop it, or wait for job.mjs done`);
  let record;
  try {
    record = launchRecord(job.real);
  } catch (error) {
    throw new Error(`${file}: its launch record ${launchRecordPath(job.real)} cannot be read, so the kit cannot tell whether its agent still runs; nothing was closed (${error.message})`);
  }
  if (agentRunning(record)) throw new Error(`${runningRefusal(file, record)}; stop it with TaskStop in that session, then close it again; nothing was closed`);
  const ending = "end that agent or the cockpit session, then close it again; nothing was closed";
  if (record && !record.cockpit_pid) throw new Error(`${file}: its launch record holds no cockpit claude pid, so the kit cannot tell whether its agent still runs; ${ending}`);
  if (record && !record.agent_id && cockpitAlive(record)) throw new Error(`${file}: its agent ${record.agent_name} has made no tool call yet while the cockpit that started it (claude pid ${record.cockpit_pid}) still runs, so it may be starting; ${ending}`);
  if (job.status === "running") finish(job.path, "stopped", `Stopped: ${reason}`);
  writeAtomic(job.path, setStatus(readFileSync(job.path, "utf8"), "closed", new Date().toISOString()));
  const tree = coreWorktree(record) ? [removeWorktree(record, "the job is closed")] : [];
  if (tree.length && existsSync(record.worktree)) updateRecord(launchRecordPath(job.real), (fresh) => withoutAgent(fresh ?? record));
  else removeRecord(launchRecordPath(job.real));
  return [`closed: ${job.path}`, ...tree].join("\n");
}

const DAY = 86_400_000;

const recordedTree = (record) => record?.worktree_owner === "core" && Boolean(record.worktree && record.repo);

const coreWorktree = (record) => recordedTree(record) && existsSync(record.worktree);

function pruneDecision(job, record, days, now) {
  if (agentRunning(record)) return { why: "its agent still runs in the cockpit" };
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

function readableRecord(file) {
  try {
    return { record: launchRecord(file) };
  } catch (error) {
    return { record: null, error: error.message };
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

const sameProcess = (found, record) => Boolean(found) && found.pid === record.cockpit_pid && found.start === record.cockpit_pid_start;

export function resume(map, file, note, { caller = claudeProcess } = {}) {
  const job = trusted(map, file);
  if (job.status === "closed") throw new Error(`${file} is closed; start a new job instead`);
  if (!String(note ?? "").trim()) throw new Error("the note is empty");
  if (!job.record) throw new Error(`${file} has no launch record, so it was not started by job.mjs start here; close it and start a new job`);
  const { record } = job;
  if (!existsSync(record.cwd)) throw new Error(`${file}: its folder ${record.cwd} no longer exists; close it and start a new job`);
  const live = Boolean(record.agent_id) && cockpitAlive(record);
  const cockpit = caller();
  if (live && !sameProcess(cockpit, record)) throw new Error(`${file}: its agent ${record.agent_name ?? record.agent_id} (${record.agent_id}) belongs to another live cockpit session, ${record.session_id} (claude pid ${record.cockpit_pid}); resume it there with SendMessage; nothing was resumed`);
  const agent = record.agent_id;
  updateRecord(launchRecordPath(job.real), (fresh) => {
    if (fresh?.agent_id !== agent) throw new Error(`${file}: its launch record changed while resuming (agent ${fresh?.agent_id ?? "none"}, not ${agent ?? "none"}); nothing was resumed, run the command again`);
    if (live) return { ...fresh, state: "running" };
    return { ...withoutAgent(fresh), ...cockpitOf(cockpit), ...(agent && { earlier: [...(fresh.earlier ?? []), agent] }) };
  });
  const at = new Date().toISOString();
  writeAtomic(job.path, withSection(setStatus(job.text, "running", at), `Note ${at}`, note));
  if (live) return { tool: "SendMessage", to: record.agent_id, message: `Job file ${JSON.stringify(job.path)} ${RESUMED}\n\n${note.trim()}` };
  const prompt = `${startPrompt(record.role, job.path)} The job ${RESUMED}\n\n${note.trim()}`;
  return { tool: "Agent", ...agentSpec(record.role, job.title ?? record.role, record.agent_name ?? agentName(record.role, job.path), prompt) };
}

function kitStatus(record) {
  if (!record.agent_id) return "not started";
  if (!record.cockpit_pid) return "unknown (no cockpit pid recorded)";
  if (!cockpitAlive(record)) return "lost (cockpit gone)";
  return record.state ?? "running";
}

function status(job) {
  if (job.status !== "running") return job.status;
  try {
    const record = launchRecord(job.path);
    return record ? kitStatus(record) : "lost (no launch record)";
  } catch (error) {
    return `unknown (${error.message})`;
  }
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

function only(command, args, allowed, verb) {
  const unknown = args.find((arg) => arg.startsWith("--") && !allowed.includes(arg));
  if (unknown) throw new Error(`${command} takes only ${allowed.length === 1 ? allowed[0] : `${allowed.slice(0, -1).join(", ")} and ${allowed.at(-1)}`}${command === "close" ? " <text>" : ""}, not ${unknown}; nothing was ${verb}`);
}

function project() {
  const resolved = resolveMap(process.cwd());
  if (!resolved) throw new Error(`no project map covers ${process.cwd()}; run /tedy:setup`);
  return resolved.map;
}

const text = (value) => (typeof value === "string" ? value : undefined);

const print = (value) => console.log(JSON.stringify(value, null, 2));

function main([command, target, ...rest]) {
  const given = flags(rest);
  if (command === "start" && target) {
    only("start", rest, ["--title", "--body-file", "--repo", "--branch"], "started");
    if (text(given.title) && text(given["body-file"])) {
      print(start(project(), target, { title: given.title, body: readFileSync(given["body-file"], "utf8"), repo: text(given.repo), branch: text(given.branch) }));
      return 0;
    }
  }
  if (command === "done" && target && text(given["outcome-file"])) {
    console.log(`done: ${done(target, readFileSync(given["outcome-file"], "utf8"))}`);
    return 0;
  }
  if (command === "stop" && target && text(given.reason)) {
    console.log(stop(target, given.reason));
    return 0;
  }
  if (command === "resume" && target) {
    only("resume", rest, ["--note-file"], "resumed");
    if (text(given["note-file"])) {
      print(resume(project(), target, readFileSync(given["note-file"], "utf8")));
      return 0;
    }
  }
  if (command === "close" && target) {
    only("close", rest, ["--reason"], "closed");
    console.log(close(project(), target, text(given.reason)));
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
  console.error("usage: job.mjs start <pm|dev|review|devops> --title <t> --body-file <f> [--repo <path>] [--branch <name>] | done <job file> --outcome-file <f> | stop <job file> --reason <text> | resume <job file> --note-file <f> | close <job file> [--reason <text>] | list | prune [--days <n>] [--dry-run]");
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
