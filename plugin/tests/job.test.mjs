import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { parse } from "../lib/handoff.mjs";
import { launchRecordPath, recordLaunch } from "../lib/job-files.mjs";
import { handle, processInfo } from "../lib/job-session-hooks.mjs";
import { tokenize } from "../lib/shell-segments.mjs";
import { BODY, DEAD_PID, JOBS_DOC, jobFile, PLUGIN, SCRIPT, sleeper, world } from "./job-world-for-tests.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const JOB_KEYS = ["to", "from", "status", "updated", "created", "title", "cwd", "permission_mode", "session_id"];

test("settings writes one settings file per role in the state dir with the role's allowlist for every jobs map, its ask rules and the TEDY env, and prints its path", () => {
  const w = world();
  const other = tempDir("tedy-job-other-");
  writeFileSync(join(w.profile, "projects", "other.md"), `\`\`\`json\n${JSON.stringify({ name: "other", paths: [other], jobs: true })}\n\`\`\`\n`);
  writeFileSync(join(w.profile, "projects", "legacy.md"), `\`\`\`json\n${JSON.stringify({ name: "legacy", paths: ["/w/legacy"], sessions: [] })}\n\`\`\`\n`);
  const out = w.run(["settings", "dev"]);
  assert.equal(out.status, 0, out.stderr);
  const file = join(w.state, "jobs", "settings", "dev.json");
  assert.equal(out.stdout.trim(), file);
  const settings = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(settings).sort(), ["env", "permissions"]);
  assert.deepEqual(settings.env, { TEDY_STATE_DIR: w.state, TEDY_PROFILE_DIR: w.profile });
  for (const rule of ["Edit", `Read(/${w.root}/**)`, `Edit(/${w.root}/plans/**)`, `Read(/${other}/**)`, `Edit(/${other}/plans/**)`]) assert.ok(settings.permissions.allow.includes(rule), rule);
  assert.ok(!settings.permissions.allow.some((rule) => rule.includes("/w/legacy")));
  assert.equal(new Set(settings.permissions.allow).size, settings.permissions.allow.length);
  assert.deepEqual(settings.permissions.ask, ["Bash(git *--output*)", `Edit(/${w.profile}/**)`, `Edit(/${w.state}/**)`]);
  const text = readFileSync(file, "utf8");
  assert.equal(w.run(["settings", "dev"]).stdout.trim(), file);
  assert.equal(readFileSync(file, "utf8"), text);
  assert.ok(!JSON.parse(readFileSync(w.run(["settings", "pm"]).stdout.trim(), "utf8")).permissions.allow.includes("Edit"));
  assert.match(w.run(["settings", "qa"]).stderr, /unknown role qa/);
  assert.deepEqual(w.calls(), []);
});

test("start writes the running job file and its launch record, then prints one cd-and-claude command for the user and never runs claude", () => {
  const w = world();
  const out = w.run(["start", "dev", "--title", "Add hello", "--body-file", w.body]);
  assert.equal(out.status, 0, out.stderr);
  const [file] = w.jobs();
  assert.match(file, /plans\/jobs\/\d{6}-\d{4}-dev-add-hello\.md$/);
  const settings = join(w.state, "jobs", "settings", "dev.json");
  const line = out.stdout.trim();
  assert.equal(line.split("\n").length, 1);
  assert.ok(line.startsWith(`cd '${w.root}' && claude --agent tedy:dev --settings '${settings}' '/tedy:dev job "`), line);
  const tokens = tokenize(line);
  assert.deepEqual(tokens.slice(0, 8), ["cd", w.root, "&&", "claude", "--agent", "tedy:dev", "--settings", settings]);
  assert.equal(tokens.length, 9);
  assert.equal(tokens[8], `/tedy:dev job "${file}". First read ${JOBS_DOC}, section "Job".`);
  assert.ok(!tokens.some((token) => ["--bg", "--name", "--session-id", "-w"].includes(token)));
  const job = parse(readFileSync(file, "utf8"), JOB_KEYS);
  assert.deepEqual([job.to, job.from, job.status, job.title, job.cwd, job.session_id], ["tedy:dev", "cockpit", "running", "Add hello", w.root, undefined]);
  assert.match(readFileSync(file, "utf8"), /\n\nAdd the line hello to notes\.txt\.\n\n## User decisions\n/);
  const record = w.record(file);
  assert.deepEqual([record.file, record.role, record.cwd, record.settings, record.session_id], [file, "dev", w.root, settings, undefined]);
  assert.ok(existsSync(settings));
  assert.deepEqual(w.calls(), []);
});

test("start --json prints the launch spec object, and a mode or plugin dir joins the command", () => {
  const w = world();
  const out = w.run(["start", "pm", "--title", "Gaps", "--body-file", w.body, "--permission-mode", "default", "--json"], { extra: { TEDY_JOB_PLUGIN_DIR: "/opt/kit/plugin" } });
  assert.equal(out.status, 0, out.stderr);
  const spec = JSON.parse(out.stdout);
  const [file] = w.jobs();
  const settings = join(w.state, "jobs", "settings", "pm.json");
  assert.deepEqual(Object.keys(spec).sort(), ["agent", "command", "cwd", "prompt", "role", "settings", "title", "via"]);
  assert.deepEqual([spec.role, spec.cwd, spec.title, spec.agent, spec.settings], ["pm", w.root, "pm acme-shop gaps", "tedy:pm", settings]);
  assert.equal(spec.prompt, `/tedy:pm job "${file}". First read ${JOBS_DOC}, section "Job".`);
  assert.deepEqual(tokenize(spec.command), ["cd", w.root, "&&", "claude", "--agent", "tedy:pm", "--settings", settings, "--permission-mode", "default", "--plugin-dir", "/opt/kit/plugin", spec.prompt]);
  assert.equal(parse(readFileSync(file, "utf8"), JOB_KEYS).permission_mode, "default");
  assert.equal(w.record(file).permission_mode, "default");
  assert.deepEqual(w.calls(), []);
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
  assert.match(w.run(["start", "dev", "--title", "x", "--body-file", w.body, "--permission-mode", "default; x"]).stderr, /is not a mode name/);
  assert.deepEqual(w.jobs(), []);
});

test("two concurrent identical starts write two job files with a record each", async () => {
  const w = world();
  const args = ["start", "pm", "--title", "Gaps in epic 3", "--body-file", w.body];
  const outs = await Promise.all([w.runAsync(args), w.runAsync(args)]);
  const files = w.jobs();
  assert.equal(files.length, 2, outs.map((o) => o.stdout).join(""));
  for (const file of files) assert.equal(w.record(file).role, "pm");
  assert.equal(new Set(outs.map((o) => o.stdout)).size, 2);
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

test("each role's prompt names its skill, and devops, which has none, names jobs.md without a slash command", () => {
  const w = world();
  const prompt = (role) => JSON.parse(w.run(["start", role, "--title", "t", "--body-file", w.body, "--json"]).stdout).prompt;
  assert.match(prompt("pm"), /^\/tedy:pm job "\//);
  assert.match(prompt("review"), /^\/tedy:review-pr job "\//);
  assert.match(prompt("dev"), /^\/tedy:dev job "\//);
  assert.match(prompt("devops"), new RegExp(`^Job file "${join(w.root, "plans", "jobs")}/\\d{6}-\\d{4}-devops-t\\.md"\\. Read ${JOBS_DOC}, section "Job", then do the job\\.$`));
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

test("every role asks before git writes a file through --output and before it edits the profile or the state dir", async () => {
  const { askRules } = await import("../lib/job.mjs");
  const at = { plugin: "/k/plugin", root: "/w/shop", profile: "/p/tedy", state: "/s/tedy" };
  const matches = (pattern, command) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(command);
  const bash = askRules(at).filter((rule) => rule.startsWith("Bash(")).map((rule) => rule.slice(5, -1));
  for (const command of ["git diff --output=/home/u/.bashrc", "git log -1 -p --output /w/shop/fe/a.ts", "git -C /w/shop/fe show HEAD --output=x"]) assert.ok(bash.some((pattern) => matches(pattern, command)), command);
  assert.ok(!bash.some((pattern) => matches(pattern, "git diff origin/dev")));
  assert.ok(askRules(at).includes("Edit(//p/tedy/**)") && askRules(at).includes("Edit(//s/tedy/**)"));
});

test("list reads only kit records: the file status when not running, else not started, lost with its last event when the claude pid is gone, else the hook state", async () => {
  const w = world();
  const live = await sleeper();
  try {
    jobFile(w, { name: "unbound" });
    jobFile(w, { name: "no-record", record: null });
    jobFile(w, { name: "asking", record: { session_id: "s-1", pid: live.pid, pid_start: live.start, state: "waiting: permission", last_event_at: "2026-11-09T03:00:00.000Z" } });
    jobFile(w, { name: "busy", record: { session_id: "s-2", pid: live.pid, pid_start: live.start, state: "running" } });
    jobFile(w, { name: "gone", record: { session_id: "s-3", pid: DEAD_PID, pid_start: "1", state: "waiting: permission", last_event_at: "2026-11-09T03:20:53.000Z" } });
    jobFile(w, { name: "reused", record: { session_id: "s-4", pid: live.pid, pid_start: `${live.start}9`, state: "running", last_event_at: "2026-11-09T03:21:00.000Z" } });
    jobFile(w, { name: "no-pid", record: { session_id: "s-5", bound_at: "2026-11-09T03:00:00.000Z", state: "idle" } });
    jobFile(w, { name: "older-kit", record: { session_id: "s-9" } });
    jobFile(w, { name: "finished", status: "done", created: new Date(Date.now() - 26 * 3_600_000).toISOString(), record: { session_id: "s-6", pid: DEAD_PID, pid_start: "1" } });
    jobFile(w, { name: "old", status: "closed" });
    const out = w.run(["list"]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(out.stdout.trim().split("\n").map((line) => line.replace(/ · \/.*$/, "")).sort(), [
      "dev · unbound · not started · 3h 5m",
      "dev · no record · lost (no launch record) · 3h 5m",
      "dev · asking · waiting: permission · 3h 5m",
      "dev · busy · running · 3h 5m",
      "dev · gone · lost (last seen 2026-11-09T03:20:53.000Z) · 3h 5m",
      "dev · reused · lost (last seen 2026-11-09T03:21:00.000Z) · 3h 5m",
      "dev · no pid · unknown (no pid recorded) · 3h 5m",
      "dev · older kit · lost (no pid recorded, started by an older kit) · 3h 5m",
      "dev · finished · done · 1d 2h",
    ].sort());
    assert.deepEqual(w.calls(), []);
  } finally {
    live.child.kill("SIGKILL");
  }
});

test("a session the hooks bind to a started job shows in list with its state", async () => {
  const w = world();
  const out = w.run(["start", "review", "--title", "Review 12", "--body-file", w.body, "--json"]);
  const spec = JSON.parse(out.stdout);
  const transcript = join(w.root, "s-7.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: spec.prompt } })}\n`);
  const live = await sleeper();
  try {
    handle({ hook_event_name: "Notification", notification_type: "permission_prompt", session_id: "s-7", transcript_path: transcript, agent_type: "tedy:review" }, { dir: w.state, claude: () => ({ pid: live.pid, start: live.start }) });
    assert.match(w.run(["list"]).stdout, /^review · Review 12 · waiting: permission · 0m · /);
  } finally {
    live.child.kill("SIGKILL");
  }
});

test("a job in a project folder whose path holds a space or a single quote binds from its launch prompt, plain or as a slash command, for start and resume", () => {
  for (const folder of ["My Projects", "O'Brien \"shop\""]) {
    const w = world(undefined, join(tempDir("tedy-job-"), folder, "shop"));
    const bound = [];
    for (const role of ["pm", "devops"]) {
      const out = w.run(["start", role, "--title", "Add hello", "--body-file", w.body, "--json"]);
      assert.equal(out.status, 0, out.stderr);
      const { prompt } = JSON.parse(out.stdout);
      const [file] = w.jobs().filter((path) => path.includes(`-${role}-`));
      const forms = role === "pm" ? [prompt, `<command-message>tedy:pm</command-message>\n<command-name>/tedy:pm</command-name>\n<command-args>${prompt.slice("/tedy:pm ".length)}</command-args>`] : [prompt];
      for (const [index, content] of forms.entries()) {
        const session = `s-${role}-${index}`;
        if (index) writeFileSync(launchRecordPath(file, w.state), JSON.stringify(Object.fromEntries(Object.entries(w.record(file)).filter(([key]) => !["session_id", "bound_at", "pid", "pid_start", "transcript_path", "last_event_at", "state"].includes(key)))));
        const transcript = join(w.root, `${session}.jsonl`);
        writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content } })}\n`);
        handle({ hook_event_name: "PostToolUse", tool_name: "Bash", session_id: session, transcript_path: transcript, agent_type: `tedy:${role}` }, { dir: w.state, claude: () => null });
        bound.push([folder, role, index, w.record(file).session_id ?? null]);
      }
      const done = join(w.root, "done.md");
      writeFileSync(done, "ok\n");
      assert.equal(w.run(["done", file, "--outcome-file", done]).status, 0);
      const note = join(w.root, "note.md");
      writeFileSync(note, "more\n");
      const resumed = w.run(["resume", file, "--note-file", note, "--json"]);
      assert.equal(resumed.status, 0, resumed.stderr);
      const transcript = join(w.root, `s-${role}-resumed.jsonl`);
      writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: JSON.parse(resumed.stdout).prompt } })}\n`);
      handle({ hook_event_name: "PostToolUse", tool_name: "Bash", session_id: `s-${role}-resumed`, transcript_path: transcript, agent_type: `tedy:${role}` }, { dir: w.state, claude: () => null });
      bound.push([folder, role, "resumed", w.record(file).session_id ?? null]);
    }
    assert.deepEqual(bound, [[folder, "pm", 0, "s-pm-0"], [folder, "pm", 1, "s-pm-1"], [folder, "pm", "resumed", "s-pm-resumed"], [folder, "devops", 0, "s-devops-0"], [folder, "devops", "resumed", "s-devops-resumed"]]);
  }
});

test("stop only writes stopped with its reason and signals no process, not even another job's live session", async () => {
  const w = world();
  const live = await sleeper();
  try {
    const file = jobFile(w, { record: { session_id: "s-1", pid: live.pid, pid_start: live.start } });
    const before = JSON.stringify(w.record(file));
    const out = w.run(["stop", file, "--reason", "the PRD tab is gone"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, `stopped: ${file}\n`);
    const text = readFileSync(file, "utf8");
    assert.equal(parse(text).status, "stopped");
    assert.match(text, /\n## Outcome\n\nStopped: the PRD tab is gone\n$/);
    assert.equal(processInfo(live.pid).start, live.start);
    assert.equal(JSON.stringify(w.record(file)), before);
  } finally {
    live.child.kill("SIGKILL");
  }
  const unrecorded = jobFile(w, { name: "by-hand", record: null });
  assert.equal(w.run(["stop", unrecorded, "--reason", "x"]).stdout.trim(), `stopped: ${unrecorded}`);
  assert.deepEqual(w.calls(), []);
});

test("close ends the recorded claude process with SIGTERM, never a pid whose start time differs, sends SIGKILL to one that ignores SIGTERM, and leaves the caller's own session alone", async () => {
  const { close } = await import("../lib/job.mjs");
  const w = world();
  const other = await sleeper();
  try {
    const reused = jobFile(w, { status: "done", name: "reused", record: { session_id: "s-2", pid: other.pid, pid_start: `${other.start}9` } });
    assert.match(w.run(["close", reused]).stdout, /warning: pid \d+ now belongs to another process, so it was not signalled/);
    assert.equal(processInfo(other.pid).start, other.start);
  } finally {
    other.child.kill("SIGKILL");
  }
  const plain = await sleeper({ claude: false });
  try {
    const forged = jobFile(w, { status: "done", name: "forged", record: { session_id: "s-4", pid: plain.pid, pid_start: plain.start } });
    assert.match(w.run(["close", forged]).stdout, /warning: pid \d+ now belongs to another process, so it was not signalled/);
    assert.equal(processInfo(plain.pid).start, plain.start);
  } finally {
    plain.child.kill("SIGKILL");
  }
  const stubborn = await sleeper({ ignoreTerm: true });
  const file = jobFile(w, { record: { session_id: "s-1", pid: stubborn.pid, pid_start: stubborn.start } });
  recordLaunch(file, JSON.parse(readFileSync(launchRecordPath(file, w.state), "utf8")));
  assert.match(close(w.map, file, "runaway", { waitMs: 300 }), /with SIGKILL after it ignored SIGTERM/);
  assert.deepEqual(await stubborn.exited, [null, "SIGKILL"]);
  const own = await sleeper();
  try {
    const mine = jobFile(w, { name: "mine", record: { session_id: "s-3", pid: own.pid, pid_start: own.start } });
    recordLaunch(mine, JSON.parse(readFileSync(launchRecordPath(mine, w.state), "utf8")));
    assert.match(close(w.map, mine, "blocked", { own: () => ({ pid: own.pid }) }), /this is the job's own session \(pid \d+\); it is not signalled and stays open for the user/);
    assert.equal(processInfo(own.pid).start, own.start);
    assert.equal(parse(readFileSync(mine, "utf8")).status, "closed");
  } finally {
    own.child.kill("SIGKILL");
  }
});

async function inJobSession(w, name, command, before = async () => {}) {
  const wrapper = join(w.bin, "session", "claude");
  if (!existsSync(wrapper)) {
    mkdirSync(join(w.bin, "session"), { recursive: true });
    writeFileSync(wrapper, '#!/bin/sh\necho $$\nread go\neval "$JOB_SESSION_COMMAND"\n');
    chmodSync(wrapper, 0o755);
  }
  const child = spawn(wrapper, [], { cwd: w.root, env: w.env({ JOB_SESSION_COMMAND: command }), stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pid = Number((await once(child.stdout, "data"))[0].toString().trim());
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const own = jobFile(w, { status: "done", name, record: { session_id: `s-${name}`, bound_at: "t", pid, pid_start: processInfo(pid).start } });
  try {
    await before(own);
  } finally {
    child.stdin.end("\n");
  }
  const [status] = await exited;
  return { own, status, stdout, stderr };
}

test("close refuses when it runs in a bound job's session, for another job or its own, whatever shell form runs it, before it writes anything", { skip: process.platform !== "linux" }, async () => {
  const w = world();
  const victim = await sleeper();
  try {
    const target = jobFile(w, { name: "victim", record: { session_id: "s-v", bound_at: "t", pid: victim.pid, pid_start: victim.start } });
    const before = { text: readFileSync(target, "utf8"), record: JSON.stringify(w.record(target)) };
    const script = join(w.root, "closer.sh");
    writeFileSync(script, `node ${SCRIPT} close ${target} --reason x\n`);
    const forms = [
      `node ${SCRIPT} close ${target} --reason x`,
      `C=close; node ${SCRIPT} $C ${target} --reason x`,
      `node ${SCRIPT} "$(echo close)" ${target} --reason x`,
      `ln -sf ${SCRIPT} ${w.root}/j.mjs && node ${w.root}/j.mjs close ${target} --reason x`,
      `printf close | xargs -I{} node ${SCRIPT} {} ${target} --reason x`,
      `sh ${script}`,
    ];
    for (const [index, command] of forms.entries()) {
      const { own, status, stderr } = await inJobSession(w, `own-${index}`, command);
      assert.notEqual(status, 0, command);
      assert.match(stderr, new RegExp(`^job: job\\.mjs close runs in the session of the job ${own}; a job never closes a job, its own included\\. Ask the user to close ${target} from the cockpit$`, "m"), command);
      assert.equal(readFileSync(target, "utf8"), before.text, command);
      assert.equal(JSON.stringify(w.record(target)), before.record, command);
      assert.equal(processInfo(victim.pid)?.start, victim.start, command);
    }
    const self = await inJobSession(w, "self", `node ${SCRIPT} close ${join(w.root, "plans", "jobs", "261106-0900-dev-self.md")}`);
    assert.notEqual(self.status, 0);
    assert.match(self.stderr, /a job never closes a job, its own included\. Ask the user to close .*-dev-self\.md from the cockpit$/m);
    assert.equal(parse(readFileSync(self.own, "utf8")).status, "done");
    assert.ok(existsSync(launchRecordPath(self.own, w.state)));
  } finally {
    victim.child.kill("SIGKILL");
  }
});

test("close refuses in a bound job's session even when a process named claude stands between it and the job's own claude: a shell symlinked as claude, a nested claude", { skip: process.platform !== "linux" }, async () => {
  const w = world();
  const shim = join(w.root, "shim");
  mkdirSync(join(shim, "nested"), { recursive: true });
  const nested = join(shim, "nested", "claude");
  writeFileSync(nested, '#!/bin/sh\nsh -c "$1"\nstatus=$?\nexit $status\n');
  chmodSync(nested, 0o755);
  const forms = [
    (target) => {
      const script = join(shim, `close-${basename(target)}.sh`);
      writeFileSync(script, `node ${SCRIPT} close ${target} --reason x\n`);
      return `ln -sf /bin/sh ${shim}/claude && ${shim}/claude ${script}`;
    },
    (target) => `${nested} "node ${SCRIPT} close ${target} --reason x"`,
  ];
  const results = [];
  for (const [index, form] of forms.entries()) {
    const victim = await sleeper();
    try {
      const target = jobFile(w, { name: `victim-${index}`, record: { session_id: `s-v${index}`, bound_at: "t", pid: victim.pid, pid_start: victim.start } });
      const before = { text: readFileSync(target, "utf8"), record: JSON.stringify(w.record(target)) };
      const command = form(target);
      const { own, status, stderr } = await inJobSession(w, `shimmed-${index}`, command);
      const refused = status !== 0 && new RegExp(`^job: job\\.mjs close runs in the session of the job ${own}; a job never closes a job, its own included\\. Ask the user to close ${target} from the cockpit$`, "m").test(stderr);
      const untouched = readFileSync(target, "utf8") === before.text && JSON.stringify(w.record(target)) === before.record && processInfo(victim.pid)?.start === victim.start;
      results.push({ command, refused, untouched });
    } finally {
      victim.child.kill("SIGKILL");
    }
  }
  assert.deepEqual(results.map(({ refused, untouched }) => [refused, untouched]), forms.map(() => [true, true]), JSON.stringify(results));
});

test("close still refuses in a bound job's session after a nested claude resumed that session and exited", { skip: process.platform !== "linux" }, async () => {
  const w = world();
  const victim = await sleeper();
  try {
    const target = jobFile(w, { name: "victim", record: { session_id: "s-v", bound_at: "t", pid: victim.pid, pid_start: victim.start } });
    const before = { text: readFileSync(target, "utf8"), record: JSON.stringify(w.record(target)) };
    const nestedResume = async () => {
      const nested = await sleeper();
      handle({ hook_event_name: "SessionStart", source: "resume", session_id: "s-nested" }, { dir: w.state, claude: () => ({ pid: nested.pid, start: nested.start }) });
      nested.child.kill("SIGKILL");
      await nested.exited;
    };
    const { own, status, stderr } = await inJobSession(w, "nested", `node ${SCRIPT} close ${target} --reason x`, nestedResume);
    assert.notEqual(status, 0);
    assert.match(stderr, new RegExp(`^job: job\\.mjs close runs in the session of the job ${own}; a job never closes a job, its own included\\.`, "m"));
    assert.equal(readFileSync(target, "utf8"), before.text);
    assert.equal(JSON.stringify(w.record(target)), before.record);
    assert.equal(processInfo(victim.pid)?.start, victim.start);
  } finally {
    victim.child.kill("SIGKILL");
  }
});

test("a user who views a live job with claude --resume and quits leaves list showing the job's own session, and resume still refuses it", async () => {
  const w = world();
  const job = await sleeper();
  const viewer = await sleeper();
  try {
    const file = jobFile(w, { name: "viewed", record: { session_id: "s-1", bound_at: "t", pid: job.pid, pid_start: job.start, state: "idle" } });
    handle({ hook_event_name: "SessionStart", source: "resume", session_id: "s-1" }, { dir: w.state, claude: () => ({ pid: viewer.pid, start: viewer.start }) });
    viewer.child.kill("SIGKILL");
    await viewer.exited;
    assert.deepEqual([w.record(file).pid, w.record(file).pid_start], [job.pid, job.start]);
    assert.match(w.run(["list"]).stdout, /^dev · viewed · running · /);
    const note = join(w.root, "note.md");
    writeFileSync(note, "more\n");
    const resumed = w.run(["resume", file, "--note-file", note]);
    assert.equal(resumed.status, 1);
    assert.match(resumed.stderr, new RegExp(`session s-1 is still open \\(pid ${job.pid}\\)`));
  } finally {
    job.child.kill("SIGKILL");
    viewer.child.kill("SIGKILL");
  }
});

test("close that may not signal the recorded process says why and leaves the job not closed with its record", async () => {
  const { close } = await import("../lib/job.mjs");
  const w = world();
  const live = await sleeper();
  try {
    const file = jobFile(w, { status: "done", record: { session_id: "s-1", pid: live.pid, pid_start: live.start } });
    recordLaunch(file, JSON.parse(readFileSync(launchRecordPath(file, w.state), "utf8")));
    const kill = () => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); };
    assert.throws(() => close(w.map, file, undefined, { kill }), new RegExp(`^Error: the kit may not signal pid ${live.pid} of session s-1 \\(EPERM: it runs as another user\\); the job is not closed\\. End that session yourself, then run job\\.mjs close again$`));
    assert.equal(parse(readFileSync(file, "utf8")).status, "done");
    assert.ok(existsSync(launchRecordPath(file)));
    assert.equal(processInfo(live.pid).start, live.start);
  } finally {
    live.child.kill("SIGKILL");
  }
});

test("a hook that read a job's record before close deleted it, or before resume unbound it, does not write the old session back", () => {
  const w = world();
  const me = () => ({ pid: process.pid, start: processInfo(process.pid).start });
  const closing = jobFile(w, { status: "done", name: "closing", record: { session_id: "s-1", bound_at: "t", pid: DEAD_PID, pid_start: "1" } });
  let closed;
  handle({ hook_event_name: "SessionStart", source: "resume", session_id: "s-1" }, { dir: w.state, claude: () => { closed = closed ?? w.run(["close", closing]); return me(); } });
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(existsSync(launchRecordPath(closing, w.state)), false);
  const resumed = jobFile(w, { status: "done", name: "resumed", record: { session_id: "s-2", bound_at: "t", pid: DEAD_PID, pid_start: "1" } });
  const note = join(w.root, "note.md");
  writeFileSync(note, "more\n");
  let out;
  handle({ hook_event_name: "SessionStart", source: "resume", session_id: "s-2" }, { dir: w.state, claude: () => { out = out ?? w.run(["resume", resumed, "--note-file", note]); return me(); } });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual([w.record(resumed).session_id, w.record(resumed).pid, w.record(resumed).earlier], [undefined, undefined, ["s-2"]]);
});

test("close refuses a running job without a reason, ends the session of a done one, marks the job closed, deletes its record and keeps the transcript", async () => {
  const w = world();
  const running = jobFile(w, { name: "running" });
  const refused = w.run(["close", running]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is still running; give --reason to stop it/);
  const runaway = w.run(["close", running, "--reason", "timeout"]);
  assert.equal(runaway.status, 0, runaway.stderr);
  assert.match(readFileSync(running, "utf8"), /^status: closed$/m);
  assert.match(readFileSync(running, "utf8"), /\n## Outcome\n\nStopped: timeout\n$/);
  const live = await sleeper();
  const transcript = join(w.root, "s-1.jsonl");
  writeFileSync(transcript, "{}\n");
  const done = jobFile(w, { status: "done", record: { session_id: "s-1", transcript_path: transcript, pid: live.pid, pid_start: live.start } });
  const out = w.run(["close", done]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout.trim(), /^closed: .*\nended session s-1 \(pid \d+\)$/);
  assert.deepEqual(await live.exited, [null, "SIGTERM"]);
  assert.equal(parse(readFileSync(done, "utf8")).status, "closed");
  assert.equal(existsSync(launchRecordPath(done, w.state)), false);
  assert.ok(existsSync(transcript));
  assert.match(w.run(["close", done]).stderr, /is already closed/);
  const corrupt = jobFile(w, { status: "stopped", name: "corrupt" });
  writeFileSync(launchRecordPath(corrupt, w.state), "{ trunc");
  assert.match(w.run(["close", corrupt]).stdout, /warning: the launch record .* cannot be read .*; nothing was signalled/);
  const outside = join(w.root, "plans", "other.md");
  writeFileSync(outside, readFileSync(jobFile(w, { status: "done", name: "copied" }), "utf8"));
  assert.match(w.run(["close", outside]).stderr, /is not under .*plans\/jobs of this project/);
  assert.deepEqual(w.calls(), []);
});

test("close of a job no session has bound yet says so, and that a session started later from its command is not tracked", () => {
  const w = world();
  const file = jobFile(w, { status: "stopped", name: "unbound" });
  const out = w.run(["close", file]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, `closed: ${file}\nno session was bound to this job, so nothing was signalled; a session started later from its printed command, T3 thread or herdr pane is not tracked as this job\n`);
  assert.equal(existsSync(launchRecordPath(file, w.state)), false);
});

test("close --if-ended writes nothing when the job's launch record cannot be read", () => {
  const w = world();
  const file = jobFile(w, { status: "done", name: "unreadable", record: { session_id: "s-1", bound_at: "t" } });
  writeFileSync(launchRecordPath(file, w.state), "{ trunc");
  const before = readFileSync(file, "utf8");
  const refused = w.run(["close", file, "--if-ended"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /launch record .* cannot be read, so the kit cannot tell that its session has ended and nothing was closed/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("close --if-ended writes nothing while the job's recorded session is alive, and closes the job once that session has ended", async () => {
  const w = world();
  const live = await sleeper();
  try {
    const file = jobFile(w, { status: "done", name: "finished", record: { session_id: "s-1", bound_at: "t", pid: live.pid, pid_start: live.start } });
    const before = { text: readFileSync(file, "utf8"), record: JSON.stringify(w.record(file)) };
    const refused = w.run(["close", file, "--if-ended"]);
    assert.equal(refused.status, 1);
    assert.equal(refused.stderr, `job: ${file}: session s-1 is still open (pid ${live.pid}), so nothing was closed; end that session in its own window, then close the job again\n`);
    assert.equal(w.run(["close", file, "--if-ended", "x"]).status, 1);
    assert.equal(readFileSync(file, "utf8"), before.text);
    assert.equal(JSON.stringify(w.record(file)), before.record);
    assert.equal(processInfo(live.pid)?.start, live.start);
    live.child.kill("SIGKILL");
    await live.exited;
    const closed = w.run(["close", file, "--if-ended"]);
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(closed.stdout, `closed: ${file}\n`);
    assert.equal(parse(readFileSync(file, "utf8")).status, "closed");
    assert.equal(existsSync(launchRecordPath(file, w.state)), false);
  } finally {
    live.child.kill("SIGKILL");
  }
});

test("close refuses an unknown flag or a --flag=value form before it writes or signals anything", async () => {
  const w = world();
  const live = await sleeper();
  try {
    const file = jobFile(w, { status: "done", name: "forms", record: { session_id: "s-1", bound_at: "t", pid: live.pid, pid_start: live.start } });
    const before = { text: readFileSync(file, "utf8"), record: JSON.stringify(w.record(file)) };
    for (const [form, flag] of [[["--if-ended=true"], "--if-ended=true"], [["--reason=why"], "--reason=why"], [["--ifended"], "--ifended"], [["--if-ended", "--force"], "--force"]]) {
      const out = w.run(["close", file, ...form]);
      assert.equal(out.status, 1, JSON.stringify(form));
      assert.equal(out.stderr, `job: close takes only --reason <text> and --if-ended, not ${flag}; nothing was closed\n`);
    }
    assert.equal(readFileSync(file, "utf8"), before.text);
    assert.equal(JSON.stringify(w.record(file)), before.record);
    assert.equal(processInfo(live.pid)?.start, live.start);
  } finally {
    live.child.kill("SIGKILL");
  }
});

test("resume appends the note, unbinds the session into earlier, and prints a claude --resume command whose prompt names the job file so the hooks bind the resumed session", () => {
  const w = world();
  const file = jobFile(w, { status: "done", mode: "default", record: { session_id: "s-1", transcript_path: "/t/s-1.jsonl", pid: DEAD_PID, pid_start: "1", state: "idle" } });
  const note = join(w.root, "note.md");
  writeFileSync(note, "Also add the line world.\n");
  const out = w.run(["resume", file, "--note-file", note]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stderr, "");
  const tokens = tokenize(out.stdout.trim());
  const settings = join(w.state, "jobs", "settings", "dev.json");
  assert.deepEqual(tokens.slice(0, -1), ["cd", w.root, "&&", "claude", "--resume", "s-1", "--agent", "tedy:dev", "--settings", settings, "--permission-mode", "default"]);
  const prompt = tokens.at(-1);
  assert.ok(prompt.startsWith(`/tedy:dev job "${file}". `), prompt);
  assert.ok(prompt.endsWith("\n\nAlso add the line world."), prompt);
  const text = readFileSync(file, "utf8");
  assert.equal(parse(text).status, "running");
  assert.match(text, /\n## Note \d{4}-\d{2}-\d{2}T[\d:.]+Z\n\nAlso add the line world\.\n$/);
  const record = w.record(file);
  assert.deepEqual([record.session_id, record.pid, record.transcript_path, record.state, record.earlier, record.role, record.permission_mode], [undefined, undefined, undefined, undefined, ["s-1"], "dev", "default"]);
  assert.match(w.run(["list"]).stdout, /· not started ·/);
  const transcript = join(w.root, "s-8.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: prompt } })}\n`);
  handle({ hook_event_name: "SessionStart", source: "resume", session_id: "s-8", transcript_path: transcript, agent_type: "tedy:dev" }, { dir: w.state, claude: () => null });
  assert.equal(w.record(file).session_id, "s-8");
  assert.deepEqual(w.calls(), []);
});

test("resume refuses a job whose recorded session is still open before it starts anything, with any adapter, and a closed, unrecorded, unstarted or tampered job, without changing it", async () => {
  const w = world();
  const note = join(w.root, "note.md");
  writeFileSync(note, "again\n");
  const live = await sleeper();
  try {
    const open = jobFile(w, { status: "done", name: "open", record: { session_id: "s-1", pid: live.pid, pid_start: live.start, via: "herdr", herdr: { name: "dev-abc123", pane: "w1:p2" } } });
    const before = { text: readFileSync(open, "utf8"), record: JSON.stringify(w.record(open)) };
    for (const [args, extra] of [[[], {}], [[], { HERDR_ENV: "1" }], [["--via", "herdr"], { HERDR_ENV: "1" }], [["--t3"], {}]]) {
      const out = w.run(["resume", open, "--note-file", note, ...args], { extra });
      assert.equal(out.status, 1, JSON.stringify(args));
      assert.equal(out.stdout, "");
      assert.match(out.stderr, new RegExp(`^job: ${open}: session s-1 is still open \\(pid ${live.pid}\\); type the note in its open thread or pane, or close that session first, then run job\\.mjs resume again; nothing was resumed$`, "m"));
      assert.equal(readFileSync(open, "utf8"), before.text);
      assert.equal(JSON.stringify(w.record(open)), before.record);
    }
    assert.deepEqual(w.herdrCalls(), []);
  } finally {
    live.child.kill("SIGKILL");
  }
  const cases = [
    [jobFile(w, { status: "closed", name: "closed", record: { session_id: "s-2" } }), /is closed; start a new job instead/],
    [jobFile(w, { status: "done", name: "by-hand", record: null }), /has no launch record/],
    [jobFile(w, { status: "done", name: "unstarted" }), /has no session yet; run the command job\.mjs start printed for it/],
  ];
  const tampered = jobFile(w, { status: "done", name: "tampered", record: { session_id: "s-3" } });
  writeFileSync(tampered, readFileSync(tampered, "utf8").replace(/cwd: .*/, "cwd: /"));
  cases.push([tampered, /its cwd: \/ differs from the launch record/]);
  const renamed = jobFile(w, { role: "review", status: "done", name: "renamed", record: { session_id: "s-4" } });
  writeFileSync(renamed, readFileSync(renamed, "utf8").replace("to: tedy:review", "to: tedy:dev"));
  cases.push([renamed, /its to: tedy:dev does not match the role review in its file name/]);
  for (const [file, message] of cases) {
    const before = readFileSync(file, "utf8");
    const out = w.run(["resume", file, "--note-file", note]);
    assert.equal(out.status, 1, file);
    assert.match(out.stderr, message);
    assert.equal(readFileSync(file, "utf8"), before);
  }
  writeFileSync(note, "  \n");
  assert.match(w.run(["resume", jobFile(w, { status: "done", name: "empty", record: { session_id: "s-5" } }), "--note-file", note]).stderr, /the note is empty/);
});

test("resume passes the role's settings file, written afresh, never a settings path the launch record holds or an edited settings file", () => {
  const w = world();
  const settings = join(w.state, "jobs", "settings", "dev.json");
  const file = jobFile(w, { status: "done", record: { session_id: "s-1", bound_at: "t", pid: DEAD_PID, pid_start: "1", settings: join(w.root, "forged.json") } });
  assert.equal(w.run(["settings", "dev"]).status, 0);
  const fresh = readFileSync(settings, "utf8");
  writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash"] } }));
  const note = join(w.root, "note.md");
  writeFileSync(note, "more\n");
  const out = w.run(["resume", file, "--note-file", note, "--json"]);
  assert.equal(out.status, 0, out.stderr);
  const spec = JSON.parse(out.stdout);
  assert.equal(spec.settings, settings);
  assert.equal(tokenize(spec.command)[tokenize(spec.command).indexOf("--settings") + 1], settings);
  assert.equal(readFileSync(settings, "utf8"), fresh);
});

test("a resume note that names another job of the same role binds the resumed session to its own job", () => {
  const w = world();
  const other = jobFile(w, { status: "done", name: "other" });
  const mine = jobFile(w, { status: "done", name: "mine", record: { session_id: "s-1", bound_at: "t", pid: DEAD_PID, pid_start: "1" } });
  const devops = jobFile(w, { role: "devops", status: "done", name: "deploy", record: { session_id: "s-2", bound_at: "t", pid: DEAD_PID, pid_start: "1" } });
  const note = join(w.root, "note.md");
  writeFileSync(note, `Same fix as in ${other}, please.\n`);
  for (const [file, role, session] of [[mine, "dev", "s-new"], [devops, "devops", "s-ops"]]) {
    const out = w.run(["resume", file, "--note-file", note, "--json"]);
    assert.equal(out.status, 0, out.stderr);
    const { prompt } = JSON.parse(out.stdout);
    assert.ok(prompt.startsWith(role === "devops" ? `Job file "${file}". ` : `/tedy:dev job "${file}". `), prompt);
    const transcript = join(w.root, `${session}.jsonl`);
    writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: prompt } })}\n`);
    handle({ hook_event_name: "PostToolUse", tool_name: "Bash", session_id: session, transcript_path: transcript, agent_type: `tedy:${role}` }, { dir: w.state, claude: () => null });
    assert.equal(w.record(file).session_id, session);
  }
  assert.equal(w.record(other).session_id, undefined);
});

test("done refuses an empty outcome and otherwise appends it, and neither done nor stop runs claude", () => {
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
  assert.match(w.run(["done", join(w.root, "body.md"), "--outcome-file", outcome]).stderr, /is not a job file/);
  assert.deepEqual(w.calls(), []);
});

test("the job code never runs claude: no fleet list, background launch, claude stop or claude rm is left in it", () => {
  for (const name of ["job.mjs", "job-files.mjs", "job-session-hooks.mjs"]) {
    const source = readFileSync(join(PLUGIN, "lib", name), "utf8");
    for (const word of ["claude agents", "--bg", "claude stop", "claude rm", 'spawnSync("claude"']) assert.ok(!source.includes(word), `${name} has ${word}`);
  }
});
