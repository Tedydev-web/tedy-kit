import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HANDOFF_KEYS, missingSections, parse, render, setStatus, slugOf, stamp } from "./handoff.mjs";
import { profileDir } from "./profile.mjs";
import { resolveMap } from "./project-map.mjs";

export const JOB_KEYS = Object.freeze([...HANDOFF_KEYS, "cwd", "permission_mode", "session_id"]);
const ROLES = ["pm", "dev", "review", "devops"];
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

function launchedRow(claude, output, name) {
  const short = output.match(/backgrounded\s+·\s+(\S+)\s+·/)?.[1];
  let problem = "its session is not in the list";
  for (let tries = 0; tries < 10; tries += 1) {
    try {
      const rows = fleet(claude);
      const found = (short && rows.find((item) => item.id === short || item.sessionId?.startsWith(short))) || rows.filter((item) => item.name === name).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
      if (found?.sessionId) return { found };
    } catch (error) {
      problem = error.message;
    }
    sleep(300);
  }
  return { problem };
}

export function setKey(text, key, value) {
  const lines = text.split("\n");
  const header = new RegExp(`^(${JOB_KEYS.join("|")}): `);
  const end = lines.findIndex((line) => !header.test(line));
  const at = lines.slice(0, end).findIndex((line) => line.startsWith(`${key}: `));
  if (at === -1) lines.splice(end, 0, `${key}: ${value}`);
  else lines[at] = `${key}: ${value}`;
  return lines.join("\n");
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

const extraArgs = (mode) => [...(mode ? ["--permission-mode", mode] : []), ...(process.env.TEDY_JOB_PLUGIN_DIR ? ["--plugin-dir", process.env.TEDY_JOB_PLUGIN_DIR] : [])];

const startPrompt = (role, file) => (role === "devops" ? `Job file ${file}. Read ${JOBS_DOC}, section "Job", then do the job.` : `/tedy:${SKILLS[role]} job ${file}. First read ${JOBS_DOC}, section "Job".`);

const trustHint = (text, cwd) => (/Workspace not trusted/i.test(text) ? `\nopen \`claude\` once in ${cwd} and accept the trust dialog` : "");

function launched(file, claude, args, cwd, name) {
  const { status, stdout, stderr } = claude(args, cwd);
  if (status !== 0) {
    const text = `${(stderr || stdout).trim()}${trustHint(stderr || stdout, cwd)}`;
    writeFileSync(file, `${setStatus(readFileSync(file, "utf8"), "stopped", new Date().toISOString()).replace(/\s+$/, "")}\n\n## Outcome\n\nThe launch failed: ${text}\n`);
    console.error(text);
    throw new Error(`the launch failed, so the job is stopped: ${file}`);
  }
  const { found, problem } = launchedRow(claude, `${stdout}\n${stderr}`, name);
  if (!found) return `warning: ${name} was started, but its session id could not be read (${problem}); the job file has no session_id, so job.mjs list shows it lost; find the session by name in claude agents`;
  writeFileSync(file, setKey(readFileSync(file, "utf8"), "session_id", found.sessionId));
  return null;
}

function createJob(dir, base, text) {
  mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n += 1) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const file = join(dir, `${slug}.md`);
    try {
      writeFileSync(file, text(file), { flag: "wx" });
      return { file, slug };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

export function start(map, role, { title, body, repo, mode, dryRun = false }, claude = claudeCli) {
  if (map.jobs !== true) throw new Error(`the project map ${map.name} does not set "jobs": true; hand the work over per ${join(PLUGIN, "shared", "handoff.md")} instead`);
  if (!ROLES.includes(role)) throw new Error(`unknown role ${role}; use pm, dev, review or devops`);
  const line = String(title ?? "").replace(/\s+/g, " ").trim();
  const slug = slugOf(line);
  if (!slug) throw new Error(`the title has no words: ${title}`);
  const missing = missingSections(body);
  if (missing.length) throw new Error(`the body lacks ${missing.join(", ")}; see ${JOBS_DOC}`);
  if (mode !== undefined && !/^[A-Za-z]+$/.test(mode)) throw new Error(`--permission-mode ${mode} is not a mode name`);
  const cwd = repo ? writableRepo(map, repo) : map.paths[0];
  const dir = join(map.paths[0], "plans", "jobs");
  const base = `${stamp()}-${role}-${slug}`;
  const argv = (file, fileSlug) => ["--agent", `tedy:${role}`, "--bg", "--name", `${role} ${map.name} ${fileSlug.slice(base.length - slug.length)}`, "--settings", settings(role, map), ...extraArgs(mode), startPrompt(role, file)];
  if (dryRun) {
    let n = 1;
    while (existsSync(join(dir, `${n === 1 ? base : `${base}-${n}`}.md`))) n += 1;
    const fileSlug = n === 1 ? base : `${base}-${n}`;
    return `cd ${shellWord(cwd)} && claude ${argv(join(dir, `${fileSlug}.md`), fileSlug).map(shellWord).join(" ")}`;
  }
  const created = new Date().toISOString();
  const header = (file) => [["cwd", cwd], ["permission_mode", mode]].filter(([, value]) => value).reduce((text, [key, value]) => setKey(text, key, value), setStatus(render({ to: `tedy:${role}`, from: "cockpit", title: line, body, created }), "running", created));
  const { file, slug: fileSlug } = createJob(dir, base, header);
  const args = argv(file, fileSlug);
  const name = args[args.indexOf("--name") + 1];
  const warning = launched(file, claude, args, cwd, name);
  return [`started: ${name} ${file}`, warning].filter(Boolean).join("\n");
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

function main([command, target, ...rest]) {
  const given = flags(rest);
  if (command === "start" && target && typeof given.title === "string" && typeof given["body-file"] === "string") {
    const resolved = resolveMap(process.cwd());
    if (!resolved) throw new Error(`no project map covers ${process.cwd()}; run /tedy:setup`);
    const repo = typeof given.repo === "string" ? given.repo : undefined;
    const mode = typeof given["permission-mode"] === "string" ? given["permission-mode"] : undefined;
    console.log(start(resolved.map, target, { title: given.title, body: readFileSync(given["body-file"], "utf8"), repo, mode, dryRun: given["dry-run"] === true }));
    return 0;
  }
  console.error("usage: job.mjs start <pm|dev|review|devops> --title <t> --body-file <f> [--repo <path>] [--permission-mode <mode>] [--dry-run]");
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
