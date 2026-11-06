import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "../lib/handoff.mjs";
import { tokenize } from "../lib/shell-segments.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const PLUGIN = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const SCRIPT = join(PLUGIN, "scripts", "job.mjs");
const JOBS_DOC = join(PLUGIN, "shared", "jobs.md");

const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const fx = JSON.parse(readFileSync(process.env.CLAUDE_FIXTURE, "utf8"));
const prior = readFileSync(process.env.CLAUDE_LOG, "utf8").split("\\n").filter(Boolean).map((line) => JSON.parse(line));
const job = String(args.at(-1) ?? "").match(/\\/\\S+?\\/plans\\/jobs\\/\\S+?\\.md/)?.[0];
appendFileSync(process.env.CLAUDE_LOG, JSON.stringify({ args, cwd: process.cwd(), job: job && existsSync(job) ? readFileSync(job, "utf8") : null }) + "\\n");
if (args.includes("--bg")) {
  if (fx.fail) {
    process.stderr.write(fx.fail);
    process.exit(1);
  }
  const n = prior.filter((call) => call.args.includes("--bg")).length;
  process.stderr.write("backgrounded \\u00b7 " + (fx.launches ?? [])[n] + " \\u00b7 a name\\n");
} else if (args[0] === "agents") {
  const n = prior.filter((call) => call.args[0] === "agents").length;
  const lists = fx.agents ?? [[]];
  process.stdout.write(JSON.stringify(lists[Math.min(n, lists.length - 1)]));
}
`;

const BODY = "Add the line hello to notes.txt.\n\n## User decisions\nnone yet\n\n## First safe step\nRead notes.txt.\n\n## Sources\nthe user's request\n";

function world(mapExtra = { jobs: true }) {
  const root = tempDir("tedy-job-");
  const profile = join(root, "profile");
  const state = join(root, "state");
  const bin = join(root, "bin");
  for (const dir of [join(profile, "projects"), state, bin, join(root, "fe"), join(root, "be")]) mkdirSync(dir, { recursive: true });
  const map = { name: "acme-shop", paths: [root], repos: [{ path: "fe", role: "FE" }, { path: "be", role: "BE", readonly: true }], ...mapExtra };
  writeFileSync(join(profile, "projects", "shop.md"), `# map\n\n\`\`\`json\n${JSON.stringify(map)}\n\`\`\`\n`);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(join(bin, "claude"), 0o755);
  const log = join(root, "claude.log");
  writeFileSync(log, "");
  const fixture = join(root, "fixture.json");
  writeFileSync(fixture, "{}");
  const body = join(root, "body.md");
  writeFileSync(body, BODY);
  const env = (extra = {}) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_FIXTURE: fixture, CLAUDE_LOG: log, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: state, TEDY_JOB_PLUGIN_DIR: "", ...extra });
  const run = (args, { fx, extra } = {}) => {
    if (fx) writeFileSync(fixture, JSON.stringify(fx));
    const { status, stdout, stderr } = spawnSync("node", [SCRIPT, ...args], { cwd: root, encoding: "utf8", env: env(extra) });
    return { status, stdout, stderr };
  };
  const runAsync = (args) => promisify(execFile)("node", [SCRIPT, ...args], { cwd: root, encoding: "utf8", env: env() });
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const jobs = () => (existsSync(join(root, "plans", "jobs")) ? readdirSync(join(root, "plans", "jobs")).map((name) => join(root, "plans", "jobs", name)) : []);
  return { root, profile, state, body, run, runAsync, calls, jobs };
}

const JOB_KEYS = ["to", "from", "status", "updated", "created", "title", "cwd", "permission_mode", "session_id"];
const row = (id, state, extra = {}) => ({ id, sessionId: `${id}-0000-4000-8000-000000000000`, name: "n", kind: "background", state, ...extra });
const settingsOf = (args) => JSON.parse(args[args.indexOf("--settings") + 1]);
const stampless = (value) => value.replace(/\d{6}-\d{4}/g, "<stamp>");

test("start --dry-run prints one cd-and-claude line for the job, with the role's settings, and writes no job file", () => {
  const w = world();
  const out = w.run(["start", "dev", "--title", "Add hello", "--body-file", w.body, "--repo", "fe", "--dry-run"]);
  assert.equal(out.status, 0, out.stderr);
  const line = out.stdout.trim();
  assert.equal(line.split("\n").length, 1);
  const tokens = tokenize(line);
  assert.deepEqual(tokens.slice(0, 8), ["cd", join(w.root, "fe"), "&&", "claude", "--agent", "tedy:dev", "--bg", "--name"]);
  assert.equal(tokens[8], "dev acme-shop add-hello");
  assert.equal(tokens[9], "--settings");
  const settings = JSON.parse(tokens[10]);
  assert.deepEqual(settings.worktree, { bgIsolation: "none" });
  assert.deepEqual(settings.env, { TEDY_STATE_DIR: w.state, TEDY_PROFILE_DIR: w.profile });
  assert.ok(settings.permissions.allow.includes("Edit"));
  assert.equal(tokens.length, 12);
  assert.match(tokens[11], new RegExp(`^/tedy:dev job ${join(w.root, "plans", "jobs")}/\\d{6}-\\d{4}-dev-add-hello\\.md\\. First read ${JOBS_DOC}, section "Job"\\.$`));
  assert.ok(!tokens.includes("--session-id") && !tokens.includes("-w"));
  assert.deepEqual(w.jobs(), []);
  assert.deepEqual(w.calls(), []);
  const plugin = tokenize(w.run(["start", "pm", "--title", "Gaps", "--body-file", w.body, "--dry-run"], { extra: { TEDY_JOB_PLUGIN_DIR: "/opt/kit/plugin", TEDY_STATE_DIR: "" } }).stdout.trim());
  assert.equal(plugin[1], w.root);
  assert.deepEqual(plugin.slice(plugin.indexOf("--plugin-dir"), plugin.indexOf("--plugin-dir") + 2), ["--plugin-dir", "/opt/kit/plugin"]);
  assert.deepEqual(JSON.parse(plugin[plugin.indexOf("--settings") + 1]).env, { TEDY_PROFILE_DIR: w.profile });
});

test("start refuses a map without jobs, an unknown role, a body without its sections and a repo it may not write", () => {
  const legacy = world({ sessions: [{ name: "PM - Shop", role: "pm" }] });
  const refused = legacy.run(["start", "dev", "--title", "x", "--body-file", legacy.body]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^job: the project map acme-shop does not set "jobs": true/m);
  const w = world();
  assert.match(w.run(["start", "qa", "--title", "x", "--body-file", w.body]).stderr, /unknown role qa; use pm, dev, review or devops/);
  writeFileSync(w.body, BODY.replace("## First safe step", "## First step"));
  const missing = w.run(["start", "dev", "--title", "x", "--body-file", w.body]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /the body lacks ## First safe step; see .*shared\/jobs\.md/);
  writeFileSync(w.body, BODY);
  assert.match(w.run(["start", "dev", "--title", "x", "--body-file", w.body, "--repo", "be"]).stderr, /be is read-only in the project map/);
  assert.match(w.run(["start", "dev", "--title", "x", "--body-file", w.body, "--repo", "elsewhere"]).stderr, /elsewhere is not a repository in the project map/);
  assert.match(w.run(["start", "dev", "--title", "!!!", "--body-file", w.body]).stderr, /the title has no words/);
  assert.deepEqual(w.jobs(), []);
  assert.deepEqual(w.calls(), []);
});

test("start writes the running job file before it spawns, reads the session id back from the launch line and the fleet list, and passes the dry-run argv", () => {
  const w = world();
  const dry = tokenize(w.run(["start", "dev", "--title", "Add hello", "--body-file", w.body, "--repo", "fe", "--permission-mode", "default", "--dry-run"]).stdout.trim());
  const out = w.run(["start", "dev", "--title", "Add hello", "--body-file", w.body, "--repo", "fe", "--permission-mode", "default"], { fx: { launches: ["aaaa1111"], agents: [[row("zzzz9999", "busy"), row("aaaa1111", "busy")]] } });
  assert.equal(out.status, 0, out.stderr);
  const [file] = w.jobs();
  assert.match(file, /plans\/jobs\/\d{6}-\d{4}-dev-add-hello\.md$/);
  assert.equal(out.stdout.trim(), `started: dev acme-shop add-hello ${file}`);
  const [launch, agents] = w.calls();
  assert.equal(launch.cwd, join(w.root, "fe"));
  assert.deepEqual(stampless(JSON.stringify(["claude", ...launch.args])), stampless(JSON.stringify(dry.slice(3))));
  assert.deepEqual(launch.args.slice(launch.args.indexOf("--permission-mode"), launch.args.indexOf("--permission-mode") + 2), ["--permission-mode", "default"]);
  const before = parse(launch.job, JOB_KEYS);
  assert.deepEqual([before.to, before.from, before.status, before.title, before.cwd, before.permission_mode, before.session_id], ["tedy:dev", "cockpit", "running", "Add hello", join(w.root, "fe"), "default", undefined]);
  assert.deepEqual(agents.args, ["agents", "--json", "--all"]);
  const after = readFileSync(file, "utf8");
  assert.equal(parse(after, JOB_KEYS).session_id, row("aaaa1111").sessionId);
  assert.equal(parse(after).status, "running");
  assert.match(after, /\n\nAdd the line hello to notes\.txt\.\n\n## User decisions\n/);
});

test("two concurrent identical starts write two job files", async () => {
  const w = world();
  writeFileSync(join(w.root, "fixture.json"), JSON.stringify({ launches: ["aaaa1111", "bbbb2222"], agents: [[row("aaaa1111", "busy"), row("bbbb2222", "busy")]] }));
  const args = ["start", "pm", "--title", "Gaps in epic 3", "--body-file", w.body];
  const outs = await Promise.all([w.runAsync(args), w.runAsync(args)]);
  const files = w.jobs();
  assert.equal(files.length, 2, outs.map((o) => o.stdout).join(""));
  if (new Set(files.map((file) => file.match(/\d{6}-\d{4}/)[0])).size === 2) return;
  assert.deepEqual(files.map((file) => file.replace(/^.*\/\d{6}-\d{4}-/, "")).sort(), ["pm-gaps-in-epic-3-2.md", "pm-gaps-in-epic-3.md"]);
  assert.deepEqual(w.calls().filter((call) => call.args.includes("--bg")).map((call) => call.args[call.args.indexOf("--name") + 1]).sort(), ["pm acme-shop gaps-in-epic-3", "pm acme-shop gaps-in-epic-3-2"]);
});

test("a launch the CLI refuses leaves the job stopped with the CLI's text, and an untrusted folder adds the trust hint", () => {
  const w = world();
  const out = w.run(["start", "review", "--title", "Review 12", "--body-file", w.body], { fx: { fail: "Error: Workspace not trusted. Run claude in this folder first.\n" } });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /^Error: Workspace not trusted\. Run claude in this folder first\.$/m);
  assert.match(out.stderr, new RegExp(`open \`claude\` once in ${w.root} and accept the trust dialog`));
  const [file] = w.jobs();
  const text = readFileSync(file, "utf8");
  assert.equal(parse(text).status, "stopped");
  assert.match(text, /\n## Outcome\n\nThe launch failed: Error: Workspace not trusted\. Run claude in this folder first\.\nopen `claude` once in .* and accept the trust dialog\n$/);
});

test("a started job whose session the fleet list does not show is reported started with a warning and keeps no session_id", () => {
  const w = world();
  const out = w.run(["start", "pm", "--title", "Gaps", "--body-file", w.body], { fx: { launches: ["cccc3333"], agents: [[]] } });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^started: pm acme-shop gaps \/.*\nwarning: pm acme-shop gaps was started, but its session id could not be read \(its session is not in the list\); the job file has no session_id/);
  const [file] = w.jobs();
  assert.equal(parse(readFileSync(file, "utf8"), JOB_KEYS).session_id, undefined);
  assert.equal(parse(readFileSync(file, "utf8")).status, "running");
});

test("a launch that cannot run claude at all leaves the job stopped with the error, like a refused launch", async () => {
  const { start } = await import("../lib/job.mjs");
  const w = world();
  const map = { name: "acme-shop", paths: [w.root], jobs: true };
  const claude = () => {
    throw new Error("claude --agent: spawnSync claude ENOENT");
  };
  assert.throws(() => start(map, "pm", { title: "Gaps", body: BODY, claude }), /the launch failed, so the job is stopped/);
  const [file] = w.jobs();
  const text = readFileSync(file, "utf8");
  assert.equal(parse(text).status, "stopped");
  assert.match(text, /\n## Outcome\n\nThe launch failed: claude --agent: spawnSync claude ENOENT\n$/);
});

test("jobs.md has the Job section every prompt and job card names, and the skills point a jobs map at it", () => {
  const headings = readFileSync(JOBS_DOC, "utf8").split("\n").filter((line) => line.startsWith("## "));
  assert.deepEqual(headings, ["## Which session this is", "## Cockpit", "## Job", "## Permissions"]);
  for (const skill of ["pm", "dev", "review-pr"]) {
    const text = readFileSync(join(PLUGIN, "skills", skill, "SKILL.md"), "utf8");
    assert.match(text, /When the map sets `jobs` or `sessions`, follow `\$\{CLAUDE_PLUGIN_ROOT\}\/shared\/jobs\.md` or `handoff\.md` instead of switching skills here\./, skill);
    assert.match(text, /When the map lists `sessions` without this one and sets no `jobs`, hand/, skill);
  }
});

test("a launch binds only to its own short id, and to a name only for a session started after the launch", async () => {
  const { start } = await import("../lib/job.mjs");
  const w = world();
  const map = { name: "acme-shop", paths: [w.root], jobs: true };
  const old = { ...row("aaaa1111", "done"), name: "dev acme-shop add-hello", startedAt: Date.now() - 86_400_000 };
  const fresh = (id) => ({ ...row(id, "busy"), name: "dev acme-shop add-hello", startedAt: Date.now() });
  const runner = (launchLine, lists) => {
    let polls = 0;
    return (args) => {
      if (args.includes("--bg")) return { status: 0, stdout: "", stderr: launchLine };
      if (args[0] === "agents") return { status: 0, stdout: JSON.stringify(lists[Math.min(polls++, lists.length - 1)]()), stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
  };
  const sessionOf = (out) => parse(readFileSync(out.split("\n")[0].split(" ").at(-1), "utf8"), JOB_KEYS).session_id;
  const byShort = start(map, "dev", { title: "Add hello", body: BODY, claude: runner("backgrounded · bbbb2222 · dev acme-shop add-hello\n", [() => [old], () => [old, fresh("bbbb2222")]]) });
  assert.equal(sessionOf(byShort), row("bbbb2222").sessionId);
  const byName = start(map, "dev", { title: "Add hello", body: BODY, claude: runner("launched\n", [() => [old], () => [old, { ...fresh("cccc3333"), name: "dev acme-shop add-hello-2" }]]) });
  assert.equal(sessionOf(byName), row("cccc3333").sessionId);
  const twice = start(map, "dev", { title: "Add hello", body: BODY, claude: runner("launched\n", [() => [old, { ...fresh("dddd4444"), name: "dev acme-shop add-hello-3" }, { ...fresh("eeee5555"), name: "dev acme-shop add-hello-3" }]]) });
  assert.match(twice, /warning: .*2 sessions named dev acme-shop add-hello-3 started after the launch/);
  assert.equal(sessionOf(twice), undefined);
});

test("each role's prompt names its skill, and devops, which has none, names jobs.md without a slash command", () => {
  const w = world();
  const prompt = (role) => tokenize(w.run(["start", role, "--title", "t", "--body-file", w.body, "--dry-run"]).stdout.trim()).at(-1);
  assert.match(prompt("pm"), /^\/tedy:pm job \//);
  assert.match(prompt("review"), /^\/tedy:review-pr job \//);
  assert.match(prompt("dev"), /^\/tedy:dev job \//);
  assert.match(prompt("devops"), new RegExp(`^Job file ${join(w.root, "plans", "jobs")}/\\d{6}-\\d{4}-devops-t\\.md\\. Read ${JOBS_DOC}, section "Job", then do the job\\.$`));
});

test("each role's allowlist lets routine work run and leaves publishing, deploys and job starts on ask", async () => {
  const { allowRules } = await import("../lib/job.mjs");
  const at = { plugin: "/k/plugin", root: "/w/shop", profile: "/p/tedy" };
  const bash = (rules) => rules.filter((rule) => rule.startsWith("Bash(")).map((rule) => rule.slice(5, -1));
  const allows = (role, command) => bash(allowRules(role, at)).some((pattern) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(command));
  const kit = (line) => `node /k/plugin/scripts/${line}`;
  for (const role of ["pm", "dev", "review", "devops"]) {
    const rules = allowRules(role, at);
    for (const rule of ["Read(//k/plugin/**)", "Read(//w/shop/**)", "Read(//p/tedy/**)", "Edit(//w/shop/plans/**)"]) assert.ok(rules.includes(rule), `${role} ${rule}`);
    for (const command of [kit("draft-lint.mjs doc-comment d.md"), kit("project-state.mjs get learned_until"), kit("pending.mjs card publish --title t --body-file b"), kit("pending.mjs card question --title t --body-file b"), kit("job.mjs done /w/shop/plans/jobs/j.md --outcome-file o"), kit("job.mjs stop /w/shop/plans/jobs/j.md --reason r"), kit("openproject.mjs get /api/v3/work_packages/1"), "git status --short", "git diff origin/dev", "git fetch -q origin", "gh pr view 12"]) assert.ok(allows(role, command), `${role} may run ${command}`);
    for (const command of ["rg x", "fd x", kit("github-write.mjs post r.md"), kit("openproject.mjs apply d.json"), kit("openproject.mjs comment 1 --body-file b --apply"), kit("gdoc-comments.mjs reply A --body-file b"), kit("figma-comments.mjs post 1:2 --body-file b"), kit("doc-comment-file.mjs post d.json"), kit("job.mjs start dev --title t --body-file b"), kit("job.mjs close j.md"), kit("pending.mjs done c.md"), kit("pending.mjs card-note c.md --text x"), "npm run lint:fix", "npm run format", "npm run test:e2e", "npm run deploy", "git fetch --upload-pack=x origin", "gh pr merge 12"]) assert.ok(!allows(role, command), `${role} may not run ${command}`);
  }
  for (const role of ["dev", "devops"]) {
    assert.ok(allowRules(role, at).includes("Edit"));
    for (const command of ["git push -u origin feat/x", "gh pr create --draft --base dev --title t --body-file b.md", "npm test", "npm run typecheck", "npm run lint:check", "npm run test -- --watch=false", "git worktree add .claude/worktrees/x -b feat/x origin/dev", "git -C /w/shop/fe/.claude/worktrees/x status --porcelain", "git -C /w/shop/fe/.claude/worktrees/x add a.ts", "git -C /w/shop/fe/.claude/worktrees/x commit -m feat", "git -C /w/shop/fe/.claude/worktrees/x push -u origin feat/x"]) assert.ok(allows(role, command), `${role} may run ${command}`);
  }
  for (const role of ["pm", "review"]) {
    assert.ok(!allowRules(role, at).includes("Edit"));
    for (const command of ["git push -u origin feat/x", "gh pr create --draft --base dev", "npm run lint", "git commit -m x", "git -C x -c core.fsmonitor=y status"]) assert.ok(!allows(role, command), `${role} may not run ${command}`);
  }
  assert.ok(allows("review", "npm test") && allows("review", "git worktree add /tmp/rv -b rv origin/dev") && !allows("review", "git worktree remove /tmp/rv"));
  assert.ok(!allows("pm", "npm test") && !allows("pm", "git worktree add x"));
});

const { recordLaunch } = await import("../lib/job.mjs");

function jobFile(w, { role = "dev", status = "running", session = row("aaaa1111").sessionId, mode, created = new Date(Date.now() - (3 * 60 + 5) * 60_000).toISOString(), name = "add-hello", record = true } = {}) {
  mkdirSync(join(w.root, "plans", "jobs"), { recursive: true });
  const file = join(w.root, "plans", "jobs", `261106-0900-${role}-${name}.md`);
  const header = [`to: tedy:${role}`, "from: cockpit", `status: ${status}`, `created: ${created}`, `title: ${name.replaceAll("-", " ")}`, `cwd: ${w.root}`, ...(mode ? [`permission_mode: ${mode}`] : []), ...(session ? [`session_id: ${session}`] : [])];
  writeFileSync(file, `${header.join("\n")}\n\n${BODY}`);
  if (record) for (const dir of [w.state, process.env.TEDY_STATE_DIR]) recordLaunch(file, { role, cwd: w.root, permission_mode: mode, session_id: session ?? undefined }, dir);
  return file;
}

const forge = (file, from, to) => writeFileSync(file, readFileSync(file, "utf8").replace(from, to));

test("resume and close act only on what start recorded outside the job file, so a job cannot redirect its own resume or another job's session", () => {
  const note = (w) => {
    writeFileSync(join(w.root, "note.md"), "again\n");
    return join(w.root, "note.md");
  };
  const fx = { launches: ["ffff6666"], agents: [[row("aaaa1111", "stopped"), row("bbbb2222", "busy")]] };
  const cases = [
    [(file) => forge(file, "to: tedy:review", "to: tedy:dev"), { role: "review" }, /its to: tedy:dev does not match the role review in its file name/],
    [(file) => forge(file, /cwd: .*/, "cwd: /"), {}, /its cwd: \/ differs from the launch record/],
    [(file) => forge(file, "status: done", "status: done\npermission_mode: bypassPermissions"), {}, /its permission_mode: bypassPermissions differs from the launch record/],
    [(file) => forge(file, row("aaaa1111").sessionId, row("bbbb2222").sessionId), {}, /its session_id: bbbb2222-0000-4000-8000-000000000000 differs from the launch record/],
    [(file) => forge(file, "status: done", "status: done\npermission_mode: default; x"), {}, /permission_mode: default; x is not a mode name/],
  ];
  for (const [tamper, options, message] of cases) {
    const w = world();
    const file = jobFile(w, { status: "done", ...options });
    tamper(file);
    const resumed = w.run(["resume", file, "--note-file", note(w)], { fx });
    assert.equal(resumed.status, 1, resumed.stdout);
    assert.match(resumed.stderr, message);
    const closed = w.run(["close", file], { fx });
    assert.equal(closed.status, 1);
    assert.match(closed.stderr, message);
    assert.deepEqual(w.calls(), []);
  }
  const w = world();
  const outside = join(w.root, "plans", "other.md");
  mkdirSync(join(w.root, "plans"), { recursive: true });
  writeFileSync(outside, readFileSync(jobFile(w, { status: "done" }), "utf8"));
  assert.match(w.run(["resume", outside, "--note-file", note(w)], { fx }).stderr, /is not under .*plans\/jobs of this project/);
  const unrecorded = jobFile(w, { status: "done", name: "by-hand", record: false });
  assert.match(w.run(["resume", unrecorded, "--note-file", note(w)], { fx }).stderr, /has no launch record/);
  const out = w.run(["close", unrecorded], { fx });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /warning: .* has no launch record, so no session was stopped or removed/);
  assert.equal(parse(readFileSync(unrecorded, "utf8")).status, "closed");
  assert.deepEqual(w.calls(), []);
});

test("stop and rm get the fleet row's short id, never the full session id", () => {
  const w = world();
  const file = jobFile(w, { status: "done" });
  assert.equal(w.run(["close", file], { fx: { agents: [[row("aaaa1111", "busy")], [row("aaaa1111", "stopped")]] } }).status, 0);
  const sessionCalls = w.calls().filter((call) => call.args[0] === "stop" || call.args[0] === "rm");
  assert.deepEqual(sessionCalls.map((call) => call.args), [["stop", "aaaa1111"], ["rm", "aaaa1111"]]);
  assert.ok(w.calls().every((call) => call.args[0] === "agents" || !call.args.includes(row("aaaa1111").sessionId)));
});

test("done refuses an empty outcome and otherwise appends it, stop records the reason, and neither touches the session", () => {
  const w = world();
  const file = jobFile(w);
  const outcome = join(w.root, "outcome.md");
  writeFileSync(outcome, "  \n");
  const empty = w.run(["done", file, "--outcome-file", outcome]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /the outcome is empty/);
  assert.equal(parse(readFileSync(file, "utf8")).status, "running");
  writeFileSync(outcome, "Branch feat/hello pushed; drafts: none.\n");
  assert.equal(w.run(["done", file, "--outcome-file", outcome]).status, 0);
  const text = readFileSync(file, "utf8");
  assert.equal(parse(text).status, "done");
  assert.match(text, /## Sources\nthe user's request\n\n## Outcome\n\nBranch feat\/hello pushed; drafts: none\.\n$/);
  const other = jobFile(w, { name: "other" });
  assert.equal(w.run(["stop", other, "--reason", "the PRD tab is gone"]).status, 0);
  assert.equal(parse(readFileSync(other, "utf8")).status, "stopped");
  assert.match(readFileSync(other, "utf8"), /\n## Outcome\n\nStopped: the PRD tab is gone\n$/);
  assert.match(w.run(["done", join(w.root, "body.md"), "--outcome-file", outcome]).stderr, /is not a job file/);
  assert.deepEqual(w.calls(), []);
});

test("resume stops the session, waits for the stop, then resumes it by its full id with the same settings, and records the new id and the note", () => {
  const w = world();
  const file = jobFile(w, { status: "done", mode: "default" });
  const note = join(w.root, "note.md");
  writeFileSync(note, "Also add the line world.\n");
  const fx = { launches: ["dddd4444"], agents: [[row("aaaa1111", "waiting")], [row("aaaa1111", "busy")], [row("aaaa1111", "stopped")], [row("aaaa1111", "stopped"), row("dddd4444", "busy")]] };
  const out = w.run(["resume", file, "--note-file", note], { fx });
  assert.equal(out.status, 0, out.stderr);
  const calls = w.calls();
  assert.deepEqual(calls.map((call) => call.args[0]), ["agents", "stop", "agents", "agents", "--resume", "agents"]);
  assert.deepEqual(calls[1].args, ["stop", "aaaa1111"]);
  const resumed = calls[4];
  assert.deepEqual(resumed.args.slice(0, 5), ["--resume", row("aaaa1111").sessionId, "--bg", "--agent", "tedy:dev"]);
  assert.equal(resumed.cwd, w.root);
  const dry = tokenize(w.run(["start", "dev", "--title", "x", "--body-file", w.body, "--dry-run"]).stdout.trim());
  assert.deepEqual(settingsOf(resumed.args), settingsOf(dry));
  assert.deepEqual(resumed.args.slice(resumed.args.indexOf("--permission-mode"), resumed.args.indexOf("--permission-mode") + 2), ["--permission-mode", "default"]);
  assert.match(resumed.args.at(-1), /^Also add the line world\.\n\n/);
  assert.equal(parse(resumed.job).status, "running");
  const text = readFileSync(file, "utf8");
  assert.equal(parse(text, JOB_KEYS).session_id, row("dddd4444").sessionId);
  assert.match(text, /\n## Note \d{4}-\d{2}-\d{2}T[\d:.]+Z\n\nAlso add the line world\.\n$/);
});

test("resume keeps what the job wrote while its stop was awaited, and every job-file write replaces the file instead of truncating it", async () => {
  const { done, resume } = await import("../lib/job.mjs");
  const { linkSync } = await import("node:fs");
  const w = world();
  const file = jobFile(w);
  let polls = 0;
  const claude = (args) => {
    if (args[0] === "agents") {
      polls += 1;
      if (polls === 2) done(file, "PR https://x/1 opened");
      const state = polls === 1 ? "busy" : polls === 2 ? "busy" : "stopped";
      return { status: 0, stdout: JSON.stringify(polls < 4 ? [row("aaaa1111", state)] : [row("aaaa1111", "stopped"), row("eeee5555", "busy")]), stderr: "" };
    }
    if (args.includes("--bg")) return { status: 0, stdout: "", stderr: "backgrounded · eeee5555 · x\n" };
    return { status: 0, stdout: "", stderr: "" };
  };
  resume({ name: "acme-shop", paths: [w.root], repos: [], jobs: true }, file, "also add world", { claude, waitMs: 5000 });
  const text = readFileSync(file, "utf8");
  assert.match(text, /\n## Outcome\n\nPR https:\/\/x\/1 opened\n\n## Note [^\n]+\n\nalso add world\n$/);
  assert.equal(parse(text).status, "running");
  const linked = join(w.root, "linked.md");
  linkSync(file, linked);
  done(file, "second outcome");
  assert.equal(readFileSync(linked, "utf8"), text);
  assert.ok(readdirSync(join(w.root, "plans", "jobs")).every((name) => name.endsWith(".md")));
});

test("resume refuses a closed job and a job whose session does not stop in time, and changes nothing", async () => {
  const w = world();
  const note = join(w.root, "note.md");
  writeFileSync(note, "again\n");
  const closed = jobFile(w, { status: "closed" });
  assert.match(w.run(["resume", closed, "--note-file", note]).stderr, /is closed; start a new job instead/);
  assert.deepEqual(w.calls(), []);
  const { resume } = await import("../lib/job.mjs");
  const file = jobFile(w, { status: "done", name: "slow" });
  const before = readFileSync(file, "utf8");
  const seen = [];
  const claude = (args) => {
    seen.push(args[0]);
    return { status: 0, stdout: args[0] === "agents" ? JSON.stringify([row("aaaa1111", "busy")]) : "", stderr: "" };
  };
  const map = { name: "acme-shop", paths: [w.root], jobs: true };
  assert.throws(() => resume(map, file, "again", { claude, waitMs: 50 }), /the session aaaa1111 did not stop within 0\.05 s; nothing was resumed/);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.ok(!seen.includes("--resume"));
});

test("close refuses a running job without a reason, stops and removes the session of a done one, and marks the job closed", () => {
  const w = world();
  const running = jobFile(w);
  const refused = w.run(["close", running]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is still running; give --reason to stop it/);
  assert.deepEqual(w.calls(), []);
  const out = w.run(["close", running, "--reason", "timeout"], { fx: { agents: [[row("aaaa1111", "busy")], [row("aaaa1111", "stopped")]] } });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(w.calls().map((call) => call.args.slice(0, 2)), [["agents", "--json"], ["stop", "aaaa1111"], ["agents", "--json"], ["rm", "aaaa1111"]]);
  const text = readFileSync(running, "utf8");
  assert.equal(parse(text).status, "closed");
  assert.match(text, /\n## Outcome\n\nStopped: timeout\n$/);
  const w2 = world();
  const done = jobFile(w2, { status: "done" });
  assert.equal(w2.run(["close", done], { fx: { agents: [[row("aaaa1111", "waiting")], [row("aaaa1111", "stopped")]] } }).status, 0);
  assert.deepEqual(w2.calls().map((call) => call.args[0]), ["agents", "stop", "agents", "rm"]);
  assert.equal(parse(readFileSync(done, "utf8")).status, "closed");
  const w3 = world();
  const gone = jobFile(w3, { status: "stopped" });
  assert.equal(w3.run(["close", gone], { fx: { agents: [[]] } }).status, 0);
  assert.deepEqual(w3.calls().map((call) => call.args[0]), ["agents"]);
  assert.match(w3.run(["close", gone]).stderr, /is already closed/);
});

test("list shows every job that is not closed with its age, a running job whose session waits as waiting with its attach command, and one whose session is gone or ended as lost", () => {
  const w = world();
  jobFile(w, { name: "alive", session: row("aaaa1111").sessionId });
  jobFile(w, { name: "failed", session: row("bbbb2222").sessionId });
  jobFile(w, { name: "gone", session: row("cccc3333").sessionId });
  jobFile(w, { name: "stopped", session: row("dddd4444").sessionId });
  jobFile(w, { name: "ended", session: row("eeee5555").sessionId });
  jobFile(w, { name: "asking", session: row("ffff6666").sessionId });
  jobFile(w, { name: "no-id", session: null });
  jobFile(w, { name: "finished", status: "done", created: new Date(Date.now() - 26 * 3_600_000).toISOString() });
  jobFile(w, { name: "old", status: "closed" });
  const rows = [row("aaaa1111", "busy"), row("bbbb2222", "failed"), row("dddd4444", "stopped"), row("eeee5555", "done"), row("ffff6666", "waiting", { waitingFor: "permission prompt" })];
  const out = w.run(["list"], { fx: { agents: [rows] } });
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.trim().split("\n");
  assert.deepEqual(lines.map((line) => line.replace(/ · \/.*$/, "")).sort(), [
    "dev · alive · running · 3h 5m",
    "dev · asking · waiting: permission prompt, claude attach ffff6666 · 3h 5m",
    "dev · ended · lost · 3h 5m",
    "dev · failed · lost · 3h 5m",
    "dev · finished · done · 1d 2h",
    "dev · gone · lost · 3h 5m",
    "dev · no id · lost · 3h 5m",
    "dev · stopped · lost · 3h 5m",
  ].sort());
  assert.equal(w.calls().length, 1);
});
