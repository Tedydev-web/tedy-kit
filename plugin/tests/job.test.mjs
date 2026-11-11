import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { HANDOFF_KEYS, parse, stamp } from "../lib/handoff.mjs";
import { JOB_KEYS as FILE_KEYS, launchRecordPath, readRecord, recordLaunch } from "../lib/job-files.mjs";
import { handle, processInfo } from "../lib/job-session-hooks.mjs";
import { BODY, bound, DEAD_PID, JOBS_DOC, jobFile, PLUGIN, sleeper, world } from "./job-world-for-tests.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const JOB_KEYS = ["to", "from", "status", "updated", "created", "title", "cwd"];

function agentEvent(w, prompt, { id = "a1b2c3", role = "dev", event = "PostToolUse", cockpit = null } = {}) {
  const transcript = join(w.root, "projects", "s-cockpit", "subagents", `agent-${id}.jsonl`);
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, `${JSON.stringify({ type: "user", isSidechain: true, agentId: id, message: { role: "user", content: prompt } })}\n`);
  return handle({ hook_event_name: event, tool_name: "Bash", session_id: "s-cockpit", transcript_path: join(w.root, "projects", "s-cockpit.jsonl"), agent_id: id, agent_type: `tedy:${role}` }, { dir: w.state, claude: () => cockpit });
}

test("start writes the running job file and its launch record, then prints only the Agent call spec for a background job agent and never runs claude", () => {
  const w = world();
  const out = w.run(["start", "pm", "--title", "Gaps in epic 3 of the shop", "--body-file", w.body]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stderr, "");
  const [file] = w.jobs();
  assert.match(file, /plans\/jobs\/\d{6}-\d{4}-pm-gaps-in-epic-3-of-the-shop\.md$/);
  const spec = JSON.parse(out.stdout);
  const [, day, time] = file.match(/(\d{6})-(\d{4})-pm-[^/]+$/);
  assert.deepEqual(Object.keys(spec), ["subagent_type", "run_in_background", "name", "description", "prompt"]);
  assert.deepEqual([spec.subagent_type, spec.run_in_background, spec.name, spec.description], ["tedy:pm", true, `pm-${day}${time}-gaps-in-epic-3-of`, "pm Gaps in epic 3"]);
  assert.ok(spec.prompt.startsWith(`Job file ${JSON.stringify(file)}. `), spec.prompt);
  const job = parse(readFileSync(file, "utf8"), JOB_KEYS);
  assert.deepEqual([job.to, job.from, job.status, job.title, job.cwd], ["tedy:pm", "cockpit", "running", "Gaps in epic 3 of the shop", w.root]);
  assert.match(readFileSync(file, "utf8"), /\n\nAdd the line hello to notes\.txt\.\n\n## User decisions\n/);
  const record = w.record(file);
  assert.deepEqual([record.file, record.role, record.cwd, record.agent_name, record.agent_id], [file, "pm", w.root, spec.name, undefined]);
  assert.ok(!existsSync(join(w.state, "jobs", "settings")));
  assert.deepEqual(w.calls(), []);
});

test("a job agent's name is its role, its job file's stamp and its title slug cut to 32 characters, and its description is the role and at most four title words", () => {
  const w = world();
  const spec = JSON.parse(w.run(["start", "devops", "--title", "Review the payment retry pull request again", "--body-file", w.body]).stdout);
  const [, day, time] = w.jobs()[0].match(/(\d{6})-(\d{4})-devops-/);
  assert.equal(spec.name, `devops-${day}${time}-review-the-pay`);
  assert.equal(spec.name.length, 32);
  assert.equal(spec.description, "devops Review the payment retry");
  assert.equal(JSON.parse(w.run(["start", "pm", "--title", "Deploy", "--body-file", w.body]).stdout).description, "pm Deploy");
});

test("start refuses, and leaves no job file or launch record, when an open job already uses its agent name; a closed job does not count", () => {
  const w = world();
  mkdirSync(join(w.root, "plans", "jobs"), { recursive: true });
  const taken = (status) => [Date.now(), Date.now() + 60_000].map((at) => {
    const file = join(w.root, "plans", "jobs", `${stamp(new Date(at))}-pm-fix-the-checkout-flow-on-mobile-chrome.md`);
    writeFileSync(file, `to: tedy:pm\nfrom: cockpit\nstatus: ${status}\ncreated: 2026-11-11T03:00:00.000Z\ntitle: x\ncwd: ${w.root}\n\n${BODY}`);
    return file;
  });
  const open = taken("running");
  const out = w.run(["start", "pm", "--title", "Fix the checkout flow on mobile safari", "--body-file", w.body]);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /^job: the agent name pm-\d{10}-fix-the-checkout-f is already used by the open job .*-pm-fix-the-checkout-flow-on-mobile-chrome\.md; close that job or start this one with a title whose first words differ; nothing was started\n$/);
  assert.deepEqual(w.jobs().sort(), open.sort());
  assert.ok(!existsSync(join(w.state, "jobs")) || readdirSync(join(w.state, "jobs")).length === 0);
  for (const file of open) writeFileSync(file, readFileSync(file, "utf8").replace("status: running", "status: closed"));
  const again = w.run(["start", "pm", "--title", "Fix the checkout flow on mobile safari", "--body-file", w.body]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(JSON.parse(again.stdout).name, /^pm-\d{10}-fix-the-checkout-f$/);
});

test("each role's prompt names the job file, the plugin root and jobs.md section Job; pm and review invoke their skill with the Skill tool, dev and devops get a file to read", () => {
  const w = world();
  const spec = (role) => JSON.parse(w.run(["start", role, "--title", "t", "--body-file", w.body]).stdout);
  const head = (role) => {
    const [file] = w.jobs().filter((path) => path.includes(`-${role}-`));
    return `Job file ${JSON.stringify(file)}. Plugin root: ${PLUGIN}; read <plugin> and \${CLAUDE_PLUGIN_ROOT} in kit files as that path. First read ${JOBS_DOC}, section "Job".`;
  };
  const pm = spec("pm");
  assert.equal(pm.prompt, `${head("pm")} Then invoke the Skill tool with skill "tedy:pm" and args ${JSON.stringify(`job ${w.jobs().find((path) => path.includes("-pm-"))}`)}, and do the job in the job file.`);
  const review = spec("review");
  assert.equal(review.prompt, `${head("review")} Then invoke the Skill tool with skill "tedy:review-pr" and args ${JSON.stringify(`job ${w.jobs().find((path) => path.includes("-review-"))}`)}, and do the job in the job file.`);
  const dev = spec("dev");
  assert.equal(dev.prompt, `${head("dev")} Then Read ${join(PLUGIN, "skills", "dev", "SKILL.md")} and follow it on the job in the job file; the Skill tool cannot invoke it.`);
  const devops = spec("devops");
  assert.equal(devops.prompt, `${head("devops")} Then do the job in the job file; devops has no skill.`);
  assert.ok(existsSync(join(PLUGIN, "skills", "dev", "SKILL.md")));
});

test("start refuses a map without jobs, an unknown role, a body without its sections, a repo it may not write and a flag it does not take", () => {
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
  for (const flag of ["--via", "--t3", "--json", "--permission-mode"]) {
    const out = w.run(["start", "dev", "--title", "x", "--body-file", w.body, flag, "print"]);
    assert.equal(out.status, 1, flag);
    assert.equal(out.stderr, `job: start takes only --title, --body-file, --repo and --branch, not ${flag}; nothing was started\n`);
  }
  assert.deepEqual(w.jobs(), []);
});

test("two concurrent identical starts write two job files with a record each and two agent names", async () => {
  const w = world();
  const args = ["start", "pm", "--title", "Gaps in epic 3", "--body-file", w.body];
  const outs = await Promise.all([w.runAsync(args), w.runAsync(args)]);
  const files = w.jobs();
  assert.equal(files.length, 2, outs.map((o) => o.stdout).join(""));
  for (const file of files) assert.equal(w.record(file).role, "pm");
  const [, day, time] = files[0].match(/(\d{6})-(\d{4})-pm-/);
  assert.deepEqual(outs.map((o) => JSON.parse(o.stdout).name).sort(), [`pm-${day}${time}-gaps-in-epic-3`, `pm-${day}${time}-gaps-in-epic-3-2`]);
});

test("jobs.md has the Job section every prompt names, and the skills point a jobs map at it", () => {
  const headings = readFileSync(JOBS_DOC, "utf8").split("\n").filter((line) => line.startsWith("## "));
  assert.deepEqual(headings, ["## Which agent this is", "## Cockpit", "## Job", "## Permissions"]);
  for (const skill of ["pm", "dev", "review-pr"]) {
    const text = readFileSync(join(PLUGIN, "skills", skill, "SKILL.md"), "utf8");
    assert.match(text, /When the map sets `jobs` or `sessions`, follow `\$\{CLAUDE_PLUGIN_ROOT\}\/shared\/jobs\.md` or `handoff\.md` instead of switching skills here\./, skill);
  }
});

test("every job agent keeps the Agent tool, so review and pm jobs can spawn the tedy:reviewer lenses their skills call for", () => {
  const front = (role) => readFileSync(join(PLUGIN, "agents", `${role}.md`), "utf8").split("---")[1];
  for (const role of ["pm", "dev", "review", "devops"]) assert.doesNotMatch(front(role), /^(tools|disallowedTools):/m, role);
});

test("jobs.md gives the cockpit its subagent rules, and no plugin file outside the tests names a removed launch adapter", () => {
  const doc = readFileSync(JOBS_DOC, "utf8");
  for (const rule of ["Spawn with Agent.", "Questions go through question cards.", "Answers and rework go through SendMessage.", "Never answer a job's permission card for the user.", "Jobs end when the cockpit session ends"]) assert.ok(doc.includes(rule), rule);
  const files = execFileSync("git", ["-C", PLUGIN, "ls-files"], { encoding: "utf8" }).split("\n").filter((file) => file && !file.startsWith("tests/"));
  assert.ok(files.includes("shared/jobs.md"));
  assert.deepEqual(files.filter((file) => /herdr|t3-instance|launchArgs|--via/.test(readFileSync(join(PLUGIN, file), "utf8"))), []);
});

test("a job file's header keys are only the ones start writes, and the test isolation scrubs no removed launcher's settings", () => {
  assert.deepEqual(FILE_KEYS, [...HANDOFF_KEYS, "cwd", "repo", "branch", "base", "worktree", "worktree_owner"]);
  assert.doesNotMatch(readFileSync(join(PLUGIN, "tests", "test-isolation.mjs"), "utf8"), /T3|HERDR/);
});

test("a job agent the hooks bind to a started job shows in list with its state", async () => {
  const w = world();
  const spec = JSON.parse(w.run(["start", "review", "--title", "Review 12", "--body-file", w.body]).stdout);
  const cockpit = await sleeper();
  try {
    agentEvent(w, spec.prompt, { role: "review", cockpit: { pid: cockpit.pid, start: cockpit.start } });
    assert.match(w.run(["list"]).stdout, /^review · Review 12 · running · 0m · /);
    handle({ hook_event_name: "Notification", notification_type: "permission_prompt", session_id: "s-cockpit", agent_id: "a1b2c3", agent_type: "tedy:review" }, { dir: w.state, claude: () => null });
    assert.match(w.run(["list"]).stdout, /^review · Review 12 · waiting: permission · 0m · /);
  } finally {
    cockpit.child.kill("SIGKILL");
  }
});

test("list reads only kit records: the file status when not running, else not started, lost once the cockpit's claude is gone, else the hook state", async () => {
  const w = world();
  const live = await sleeper();
  try {
    jobFile(w, { name: "unbound" });
    jobFile(w, { name: "no-record", record: null });
    jobFile(w, { name: "asking", record: bound(live, { state: "waiting: permission" }) });
    jobFile(w, { name: "busy", record: bound(live) });
    jobFile(w, { name: "resting", record: bound(live, { state: "idle" }) });
    jobFile(w, { name: "gone", record: bound({ pid: DEAD_PID, start: "1" }) });
    jobFile(w, { name: "reused", record: bound({ pid: live.pid, start: `${live.start}9` }) });
    jobFile(w, { name: "no-pid", record: bound({}) });
    jobFile(w, { name: "finished", status: "done", created: new Date(Date.now() - 26 * 3_600_000).toISOString(), record: bound({ pid: DEAD_PID, start: "1" }) });
    jobFile(w, { name: "old", status: "closed" });
    const out = w.run(["list"]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(out.stdout.trim().split("\n").map((line) => line.replace(/ · \/.*$/, "")).sort(), [
      "dev · unbound · not started · 3h 5m",
      "dev · no record · lost (no launch record) · 3h 5m",
      "dev · asking · waiting: permission · 3h 5m",
      "dev · busy · running · 3h 5m",
      "dev · resting · idle · 3h 5m",
      "dev · gone · lost (cockpit gone) · 3h 5m",
      "dev · reused · lost (cockpit gone) · 3h 5m",
      "dev · no pid · unknown (no cockpit pid recorded) · 3h 5m",
      "dev · finished · done · 1d 2h",
    ].sort());
    assert.deepEqual(w.calls(), []);
  } finally {
    live.child.kill("SIGKILL");
  }
});

test("a job in a project folder whose path holds a space or a quote binds from its launch prompt, for start and for a fresh resume", () => {
  for (const folder of ["My Projects", "O'Brien \"shop\""]) {
    const w = world(undefined, join(tempDir("tedy-job-"), folder, "shop"));
    const seen = [];
    for (const role of ["pm", "devops"]) {
      const { prompt } = JSON.parse(w.run(["start", role, "--title", "Add hello", "--body-file", w.body]).stdout);
      const [file] = w.jobs().filter((path) => path.includes(`-${role}-`));
      agentEvent(w, prompt, { id: `${role}1`, role });
      seen.push([role, w.record(file).agent_id ?? null]);
      const note = join(w.root, "note.md");
      writeFileSync(note, "more\n");
      const resumed = w.run(["resume", file, "--note-file", note]);
      assert.equal(resumed.status, 0, resumed.stderr);
      agentEvent(w, JSON.parse(resumed.stdout).prompt, { id: `${role}2`, role });
      seen.push([role, w.record(file).agent_id ?? null]);
    }
    assert.deepEqual(seen, [["pm", "pm1"], ["pm", "pm2"], ["devops", "devops1"], ["devops", "devops2"]], folder);
  }
});

test("stop only writes stopped with its reason and leaves the record as it was", async () => {
  const w = world();
  const live = await sleeper();
  try {
    const file = jobFile(w, { record: bound(live) });
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

test("close refuses while the job's agent still runs or waits in a live cockpit, and closes once it is idle, stopped or its cockpit has gone", async () => {
  const w = world();
  const live = await sleeper();
  try {
    for (const state of ["running", "waiting: permission"]) {
      const file = jobFile(w, { status: "done", name: `busy-${state.replace(/\W+/g, "-")}`, record: bound(live, { state }) });
      const before = { text: readFileSync(file, "utf8"), record: JSON.stringify(w.record(file)) };
      const out = w.run(["close", file, "--reason", "x"]);
      assert.equal(out.status, 1, state);
      assert.equal(out.stderr, `job: ${file}: its agent dev-busy-${state.replace(/\W+/g, "-")} (a1b2c3) is ${state} in cockpit session s-cockpit (claude pid ${live.pid}); stop it with TaskStop in that session, then close it again; nothing was closed\n`);
      assert.equal(readFileSync(file, "utf8"), before.text);
      assert.equal(JSON.stringify(w.record(file)), before.record);
    }
    for (const [name, record] of [["idle", bound(live, { state: "idle" })], ["stopped", bound(live, { state: "stopped" })], ["gone", bound({ pid: DEAD_PID, start: "1" })], ["reused", bound({ pid: live.pid, start: `${live.start}9` })]]) {
      const file = jobFile(w, { status: "done", name, record });
      const out = w.run(["close", file]);
      assert.equal(out.status, 0, `${name}: ${out.stderr}`);
      assert.equal(out.stdout, `closed: ${file}\n`);
      assert.equal(parse(readFileSync(file, "utf8")).status, "closed");
      assert.equal(existsSync(launchRecordPath(file, w.state)), false);
    }
    assert.equal(processInfo(live.pid).start, live.start);
  } finally {
    live.child.kill("SIGKILL");
  }
});

test("close refuses a job not started while the cockpit that started it runs, and a bound job whose record holds no cockpit pid; an unbound job with no cockpit pid closes and says nothing was signalled, and a job file with no launch record still closes", async () => {
  const w = world();
  const live = await sleeper();
  try {
    const starting = jobFile(w, { name: "starting", record: { cockpit_pid: live.pid, cockpit_pid_start: live.start } });
    const noPid = jobFile(w, { status: "done", name: "no-pid", record: { cockpit_pid: undefined, cockpit_pid_start: undefined } });
    const boundNoPid = jobFile(w, { status: "done", name: "bound-no-pid", record: bound({}, { state: "idle" }) });
    const refusals = [
      [starting, `job: ${starting}: its agent dev-starting has made no tool call yet while the cockpit that started it (claude pid ${live.pid}) still runs, so it may be starting; end that agent or the cockpit session, then close it again; nothing was closed\n`],
      [boundNoPid, `job: ${boundNoPid}: its launch record holds no cockpit claude pid, so the kit cannot tell whether its agent still runs; end that agent or the cockpit session, then close it again; nothing was closed\n`],
    ];
    const unbound = w.run(["close", noPid]);
    assert.equal(unbound.status, 0, unbound.stderr);
    assert.equal(unbound.stdout, `closed: ${noPid}\nnothing was bound to this job, so nothing was signalled\n`);
    assert.equal(existsSync(launchRecordPath(noPid, w.state)), false);
    for (const [file, message] of refusals) {
      const before = { text: readFileSync(file, "utf8"), record: JSON.stringify(w.record(file)) };
      const out = w.run(["close", file, "--reason", "x"]);
      assert.equal(out.status, 1, file);
      assert.equal(out.stderr, message);
      assert.deepEqual({ text: readFileSync(file, "utf8"), record: JSON.stringify(w.record(file)) }, before);
    }
    for (const file of [jobFile(w, { name: "never-spawned" }), jobFile(w, { status: "done", name: "no-record", record: null })]) {
      const out = w.run(["close", file, "--reason", "x"]);
      assert.equal(out.status, 0, `${file}: ${out.stderr}`);
      assert.equal(parse(readFileSync(file, "utf8")).status, "closed");
    }
  } finally {
    live.child.kill("SIGKILL");
  }
});

test("start records the claude process that ran it as the job's cockpit", async () => {
  const { start } = await import("../lib/job.mjs");
  const w = world();
  start(w.map, "pm", { title: "Gaps", body: BODY }, { caller: () => ({ pid: 4242, start: "777" }) });
  const record = readRecord(launchRecordPath(w.jobs()[0]));
  assert.deepEqual([record.cockpit_pid, record.cockpit_pid_start, record.agent_id], [4242, "777", undefined]);
  start(w.map, "devops", { title: "Deploy", body: BODY }, { caller: () => null });
  const unknown = readRecord(launchRecordPath(w.jobs().find((file) => file.includes("-devops-"))));
  assert.deepEqual([unknown.cockpit_pid, unknown.cockpit_pid_start], [undefined, undefined]);
});

test("close refuses a running job without a reason, stops it with one, refuses an unreadable record, a closed job and a file outside the jobs folder", () => {
  const w = world();
  const running = jobFile(w, { name: "running" });
  const refused = w.run(["close", running]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is still running; give --reason to stop it, or wait for job\.mjs done/);
  const runaway = w.run(["close", running, "--reason", "timeout"]);
  assert.equal(runaway.status, 0, runaway.stderr);
  assert.match(readFileSync(running, "utf8"), /^status: closed$/m);
  assert.match(readFileSync(running, "utf8"), /\n## Outcome\n\nStopped: timeout\n$/);
  assert.match(w.run(["close", running]).stderr, /is already closed/);
  const corrupt = jobFile(w, { status: "stopped", name: "corrupt" });
  writeFileSync(launchRecordPath(corrupt, w.state), "{ trunc");
  const unreadable = w.run(["close", corrupt]);
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.stderr, /^job: .*corrupt\.md: its launch record .* cannot be read, so the kit cannot tell whether its agent still runs; nothing was closed/);
  assert.equal(parse(readFileSync(corrupt, "utf8")).status, "stopped");
  const outside = join(w.root, "plans", "other.md");
  writeFileSync(outside, readFileSync(jobFile(w, { status: "done", name: "copied" }), "utf8"));
  assert.match(w.run(["close", outside]).stderr, /is not under .*plans\/jobs of this project/);
  assert.deepEqual(w.calls(), []);
});

test("close refuses an unknown flag or a --flag=value form before it writes anything", () => {
  const w = world();
  const file = jobFile(w, { status: "done", name: "forms" });
  const before = { text: readFileSync(file, "utf8"), record: JSON.stringify(w.record(file)) };
  for (const [form, flag] of [[["--if-ended"], "--if-ended"], [["--reason=why"], "--reason=why"], [["--force"], "--force"]]) {
    const out = w.run(["close", file, ...form]);
    assert.equal(out.status, 1, JSON.stringify(form));
    assert.equal(out.stderr, `job: close takes only --reason <text>, not ${flag}; nothing was closed\n`);
  }
  assert.equal(readFileSync(file, "utf8"), before.text);
  assert.equal(JSON.stringify(w.record(file)), before.record);
});

test("resume run from the cockpit that runs the job's agent appends the note, marks the record running and prints a SendMessage call to that agent", async () => {
  const { resume } = await import("../lib/job.mjs");
  const w = world();
  const live = await sleeper();
  try {
    const file = jobFile(w, { status: "done", record: bound(live, { state: "idle" }) });
    recordLaunch(file, w.record(file));
    const before = JSON.stringify({ ...readRecord(launchRecordPath(file)), state: "running" });
    const out = resume(w.map, file, "Also add the line world.\n", { caller: () => ({ pid: live.pid, start: live.start }) });
    assert.deepEqual(Object.keys(out), ["tool", "to", "message"]);
    assert.deepEqual([out.tool, out.to], ["SendMessage", "a1b2c3"]);
    assert.equal(out.message, `Job file ${JSON.stringify(file)} is resumed: the latest ## Note in the job file, quoted below, is the rework request. Go on with it and end with job.mjs done or stop.\n\nAlso add the line world.`);
    const text = readFileSync(file, "utf8");
    assert.equal(parse(text).status, "running");
    assert.match(text, /\n## Note \d{4}-\d{2}-\d{2}T[\d:.]+Z\n\nAlso add the line world\.\n$/);
    assert.equal(JSON.stringify(readRecord(launchRecordPath(file))), before);
    const elsewhere = jobFile(w, { status: "done", name: "elsewhere", record: bound(live, { state: "idle" }) });
    recordLaunch(elsewhere, w.record(elsewhere));
    const text2 = readFileSync(elsewhere, "utf8");
    assert.throws(() => resume(w.map, elsewhere, "x", { caller: () => ({ pid: process.pid, start: "1" }) }), new RegExp(`^Error: ${elsewhere}: its agent dev-elsewhere \\(a1b2c3\\) belongs to another live cockpit session, s-cockpit \\(claude pid ${live.pid}\\); resume it there with SendMessage; nothing was resumed$`));
    assert.equal(readFileSync(elsewhere, "utf8"), text2);
  } finally {
    live.child.kill("SIGKILL");
  }
});

test("resume of a job whose cockpit has gone, or whose agent never bound, appends the note, moves the old agent into earlier, records the resuming cockpit and prints a fresh Agent spec carrying the note", () => {
  const w = world();
  const file = jobFile(w, { status: "done", record: bound({ pid: DEAD_PID, start: "1" }, { state: "idle" }) });
  const note = join(w.root, "note.md");
  writeFileSync(note, "Also add the line world.\n");
  const out = w.run(["resume", file, "--note-file", note]);
  assert.equal(out.status, 0, out.stderr);
  const spec = JSON.parse(out.stdout);
  assert.deepEqual(Object.keys(spec), ["tool", "subagent_type", "run_in_background", "name", "description", "prompt"]);
  assert.deepEqual([spec.tool, spec.subagent_type, spec.run_in_background, spec.name, spec.description], ["Agent", "tedy:dev", true, "dev-add-hello", "dev add hello"]);
  assert.ok(spec.prompt.startsWith(`Job file ${JSON.stringify(file)}. `), spec.prompt);
  assert.ok(spec.prompt.endsWith(" The job is resumed: the latest ## Note in the job file, quoted below, is the rework request. Go on with it and end with job.mjs done or stop.\n\nAlso add the line world."), spec.prompt);
  const record = w.record(file);
  assert.deepEqual([record.agent_id, record.session_id, record.state, record.earlier, record.role, record.agent_name], [undefined, undefined, undefined, ["a1b2c3"], "dev", "dev-add-hello"]);
  assert.ok(Number.isInteger(record.cockpit_pid) && record.cockpit_pid !== DEAD_PID && typeof record.cockpit_pid_start === "string", JSON.stringify(record));
  assert.match(w.run(["list"]).stdout, /· not started ·/);
  const unbound = jobFile(w, { status: "done", name: "unbound" });
  const fresh = w.run(["resume", unbound, "--note-file", note]);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(JSON.parse(fresh.stdout).tool, "Agent");
  assert.equal(w.record(unbound).earlier, undefined);
  assert.deepEqual(w.calls(), []);
});

test("resume refuses a closed, unrecorded or tampered job and an empty note or unknown flag, without changing it", () => {
  const w = world();
  const note = join(w.root, "note.md");
  writeFileSync(note, "again\n");
  const cases = [
    [jobFile(w, { status: "closed", name: "closed" }), /is closed; start a new job instead/],
    [jobFile(w, { status: "done", name: "by-hand", record: null }), /has no launch record/],
  ];
  const tampered = jobFile(w, { status: "done", name: "tampered" });
  writeFileSync(tampered, readFileSync(tampered, "utf8").replace(/cwd: .*/, "cwd: /"));
  cases.push([tampered, /its cwd: \/ differs from the launch record/]);
  const renamed = jobFile(w, { role: "review", status: "done", name: "renamed" });
  writeFileSync(renamed, readFileSync(renamed, "utf8").replace("to: tedy:review", "to: tedy:dev"));
  cases.push([renamed, /its to: tedy:dev does not match the role review in its file name/]);
  for (const [file, message] of cases) {
    const before = readFileSync(file, "utf8");
    const out = w.run(["resume", file, "--note-file", note]);
    assert.equal(out.status, 1, file);
    assert.match(out.stderr, message);
    assert.equal(readFileSync(file, "utf8"), before);
  }
  const flagged = jobFile(w, { status: "done", name: "flagged" });
  assert.equal(w.run(["resume", flagged, "--note-file", note, "--via", "t3"]).stderr, "job: resume takes only --note-file, not --via; nothing was resumed\n");
  writeFileSync(note, "  \n");
  assert.match(w.run(["resume", jobFile(w, { status: "done", name: "empty" }), "--note-file", note]).stderr, /the note is empty/);
});

test("a hook that read a job's record before close deleted it, or before resume unbound it, does not write the old agent back", () => {
  const w = world();
  const closing = jobFile(w, { status: "done", name: "closing", record: bound({ pid: DEAD_PID, start: "1" }, { state: "idle", agent_id: "c1" }) });
  let closed;
  handle({ hook_event_name: "PostToolUse", tool_name: "Bash", session_id: "s-cockpit", agent_id: "c1", agent_type: "tedy:dev" }, { dir: w.state, claude: () => { closed = closed ?? w.run(["close", closing]); return { pid: process.pid, start: processInfo(process.pid).start }; } });
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(existsSync(launchRecordPath(closing, w.state)), false);
  const resumed = jobFile(w, { status: "done", name: "resumed", record: bound({ pid: DEAD_PID, start: "1" }, { state: "idle", agent_id: "c2" }) });
  const note = join(w.root, "note.md");
  writeFileSync(note, "more\n");
  let out;
  handle({ hook_event_name: "PostToolUse", tool_name: "Bash", session_id: "s-cockpit", agent_id: "c2", agent_type: "tedy:dev" }, { dir: w.state, claude: () => { out = out ?? w.run(["resume", resumed, "--note-file", note]); return { pid: process.pid, start: processInfo(process.pid).start }; } });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual([w.record(resumed).agent_id, w.record(resumed).cockpit_pid === DEAD_PID, w.record(resumed).earlier], [undefined, false, ["c2"]]);
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

test("the job code runs no claude, signals no process and keeps no launch adapter, settings file or T3 instance", () => {
  for (const name of ["job.mjs", "job-files.mjs", "job-session-hooks.mjs", "job-worktrees.mjs"]) {
    const source = readFileSync(join(PLUGIN, "lib", name), "utf8");
    for (const word of ["claude agents", "--bg", "claude stop", "claude rm", 'spawnSync("claude"', "process.kill(record.pid, name", "SIGTERM", "herdr", "t3", "--settings", "launchArgs"]) assert.ok(!source.includes(word), `${name} has ${word}`);
  }
  assert.deepEqual(readdirSync(join(PLUGIN, "lib")).filter((name) => name.startsWith("job")).sort(), ["job-files.mjs", "job-session-hooks.mjs", "job-worktrees.mjs", "job.mjs"]);
  const w = world();
  for (const command of [["settings", "dev"], ["t3-instance", "--all"]]) assert.equal(w.run(command).status, 2, command.join(" "));
});
