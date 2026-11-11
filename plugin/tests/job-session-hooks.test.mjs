import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchRecordPath, recordLaunch } from "../lib/job-files.mjs";
import { alive, claudeProcess, handle, processInfo } from "../lib/job-session-hooks.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const PLUGIN = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const HOOK = join(PLUGIN, "scripts", "job-session-hooks.mjs");

function world(names = ["261111-1000-dev-add-hello"]) {
  const root = tempDir("tedy-job-hooks-");
  const state = join(root, "state");
  mkdirSync(join(root, "plans", "jobs"), { recursive: true });
  const files = names.map((name) => {
    const file = join(root, "plans", "jobs", `${name}.md`);
    writeFileSync(file, `to: tedy:${name.split("-")[2]}\nfrom: cockpit\nstatus: running\ncreated: 2026-11-11T03:00:00.000Z\ntitle: t\n\nbody\n`);
    recordLaunch(file, { role: name.split("-")[2], cwd: root, agent_name: `${name.split("-")[2]}-t` }, state);
    return file;
  });
  const main = join(root, "projects", "s-1.jsonl");
  mkdirSync(dirname(main), { recursive: true });
  writeFileSync(main, "");
  const record = (file = files[0]) => JSON.parse(readFileSync(launchRecordPath(file, state), "utf8"));
  const claude = () => ({ pid: 4242, start: "777" });
  const fire = (input, now = "2026-11-11T04:00:00.000Z") => handle({ session_id: "s-1", transcript_path: main, ...input }, { dir: state, now, claude });
  const agent = (content, { id = "a1b2c3", role = "dev", event = "PostToolUse", session = "s-1" } = {}) => {
    const transcript = join(root, "projects", session, "subagents", `agent-${id}.jsonl`);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, `${JSON.stringify({ type: "user", isSidechain: true, agentId: id, message: { role: "user", content } })}\n`);
    return { hook_event_name: event, tool_name: "Bash", session_id: session, transcript_path: join(root, "projects", `${session}.jsonl`), agent_id: id, agent_type: `tedy:${role}` };
  };
  return { root, state, files, record, fire, agent, main };
}

const launch = (file) => `Job file ${JSON.stringify(file)}. Plugin root: /k/plugin. First read /k/plugin/shared/jobs.md, section "Job".`;

test("a job agent's first tool event binds its agent id, the cockpit's session and the cockpit's claude pid from the launch form in the agent's own transcript", () => {
  const w = world();
  const input = w.agent(launch(w.files[0]));
  assert.deepEqual(w.fire(input), []);
  const record = w.record();
  assert.equal(record.agent_id, "a1b2c3");
  assert.equal(record.session_id, "s-1");
  assert.equal(record.transcript_path, join(w.root, "projects", "s-1", "subagents", "agent-a1b2c3.jsonl"));
  assert.deepEqual([record.cockpit_pid, record.cockpit_pid_start], [4242, "777"]);
  assert.equal(record.state, "running");
  assert.equal(record.bound_at, "2026-11-11T04:00:00.000Z");
  assert.equal(record.last_event_at, "2026-11-11T04:00:00.000Z");
  assert.equal(record.agent_name, "dev-t");
});

test("SubagentStop binds from its agent_transcript_path and marks the job idle", () => {
  const w = world();
  const input = w.agent(launch(w.files[0]), { id: "f00d", event: "SubagentStop" });
  const moved = join(w.root, "elsewhere", "agent-f00d.jsonl");
  mkdirSync(dirname(moved), { recursive: true });
  writeFileSync(moved, readFileSync(join(w.root, "projects", "s-1", "subagents", "agent-f00d.jsonl")));
  writeFileSync(join(w.root, "projects", "s-1", "subagents", "agent-f00d.jsonl"), "");
  w.fire({ ...input, tool_name: undefined, agent_transcript_path: moved, last_assistant_message: "done" });
  assert.deepEqual([w.record().agent_id, w.record().transcript_path, w.record().state], ["f00d", moved, "idle"]);
});

test("the cockpit, another plugin's agent, another role's agent, a launch form later in the prompt, and a missing, unrecorded or closed job file bind nothing", () => {
  const w = world();
  const named = w.files[0];
  const unrecorded = join(w.root, "plans", "jobs", "261111-1001-dev-by-hand.md");
  writeFileSync(unrecorded, "to: tedy:dev\nfrom: cockpit\nstatus: running\n\nbody\n");
  const closed = join(w.root, "plans", "jobs", "261111-1002-dev-closed.md");
  writeFileSync(closed, "to: tedy:dev\nfrom: cockpit\nstatus: closed\n\nbody\n");
  recordLaunch(closed, { role: "dev", cwd: w.root }, w.state);
  const cases = [
    { ...w.agent(launch(named)), agent_id: undefined },
    { ...w.agent(launch(named)), agent_type: "general-purpose" },
    { ...w.agent(launch(named)), agent_type: "other:dev" },
    w.agent(launch(named), { role: "pm" }),
    w.agent(`Please look. ${launch(named)}`),
    w.agent(launch(join(w.root, "plans", "jobs", "261111-1003-dev-missing.md"))),
    w.agent(launch(unrecorded)),
    w.agent(launch(closed)),
    w.agent([{ type: "tool_result", content: launch(named) }]),
  ];
  for (const input of cases) assert.deepEqual(w.fire(input), [], JSON.stringify(input));
  assert.equal(w.record().agent_id, undefined);
  assert.equal(JSON.parse(readFileSync(launchRecordPath(closed, w.state), "utf8")).agent_id, undefined);
});

test("a second agent naming a bound job file does not rebind it and only returns a warning for stderr", () => {
  const w = world();
  w.fire(w.agent(launch(w.files[0])));
  const warnings = w.fire(w.agent(launch(w.files[0]), { id: "b2" }));
  assert.deepEqual(warnings, [`${w.files[0]} is already bound to agent a1b2c3; agent b2 is not tracked as that job`]);
  assert.equal(w.record().agent_id, "a1b2c3");
});

test("the record's state follows the job agent: running after a tool, waiting on its permission notification, idle when it stops, and the cockpit's own events change nothing", () => {
  const w = world();
  const input = w.agent(launch(w.files[0]));
  w.fire(input);
  const steps = [
    [{ ...input, hook_event_name: "Notification", notification_type: "permission_prompt" }, "waiting: permission"],
    [{ ...input, hook_event_name: "PostToolUse" }, "running"],
    [{ hook_event_name: "Notification", notification_type: "permission_prompt" }, "running"],
    [{ hook_event_name: "Stop" }, "running"],
    [{ hook_event_name: "PostToolUse", tool_name: "Bash" }, "running"],
    [{ ...input, hook_event_name: "Notification", notification_type: "idle_prompt" }, "running"],
    [{ ...input, hook_event_name: "SubagentStop" }, "idle"],
  ];
  for (const [step, state] of steps) {
    w.fire(step, "2026-11-11T05:00:00.000Z");
    assert.equal(w.record().state, state, JSON.stringify(step));
  }
});

test("the cockpit's TaskStop of a job agent by its exact agent id marks the job stopped; a TaskStop naming its agent name, part of its id or anything else changes nothing", () => {
  const w = world(["261111-1000-dev-add-hello", "261111-1000-pm-gaps"]);
  w.fire(w.agent(launch(w.files[0])));
  w.fire(w.agent(launch(w.files[1]), { id: "c3", role: "pm" }));
  for (const task_id of ["b-other", "pm-t", "dev-t", "a1b2c"]) w.fire({ hook_event_name: "PostToolUse", tool_name: "TaskStop", tool_input: { task_id } });
  assert.deepEqual([w.record(w.files[0]).state, w.record(w.files[1]).state], ["running", "running"]);
  w.fire({ hook_event_name: "PostToolUse", tool_name: "TaskStop", tool_input: { task_id: "a1b2c3" } });
  w.fire({ hook_event_name: "PostToolUse", tool_name: "TaskStop", tool_input: { task_id: "c3" } });
  assert.deepEqual([w.record(w.files[0]).state, w.record(w.files[1]).state], ["stopped", "stopped"]);
  w.fire({ ...w.agent(launch(w.files[0])), hook_event_name: "PostToolUse", agent_id: "zz", agent_type: "tedy:dev" });
  assert.equal(w.record(w.files[0]).state, "stopped");
});

test("a TaskStop marks stopped only the job agent of the cockpit session that ran it", () => {
  const w = world(["261111-1000-dev-add-hello", "261111-1001-dev-add-hello"]);
  w.fire(w.agent(launch(w.files[0]), { id: "a1" }));
  w.fire(w.agent(launch(w.files[1]), { id: "b1", session: "s-2" }));
  assert.equal(w.record(w.files[1]).session_id, "s-2");
  w.fire({ hook_event_name: "PostToolUse", tool_name: "TaskStop", session_id: "s-2", tool_input: { task_id: "b1" } });
  assert.deepEqual([w.record(w.files[0]).state, w.record(w.files[1]).state], ["running", "stopped"]);
  w.fire({ hook_event_name: "PostToolUse", tool_name: "TaskStop", session_id: "s-2", tool_input: { task_id: "a1" } });
  assert.equal(w.record(w.files[0]).state, "running");
});

test("a tool event whose transcript_path is the agent's own transcript binds from it", () => {
  const w = world();
  const input = w.agent(launch(w.files[0]), { id: "e5" });
  w.fire({ ...input, transcript_path: join(w.root, "projects", "s-1", "subagents", "agent-e5.jsonl") });
  assert.equal(w.record().agent_id, "e5");
});

test("an event that carries a bound agent_id without agent_type still moves that job's state", () => {
  const w = world();
  w.fire(w.agent(launch(w.files[0])));
  w.fire({ hook_event_name: "Notification", notification_type: "permission_prompt", agent_id: "a1b2c3" });
  assert.equal(w.record().state, "waiting: permission");
  w.fire({ hook_event_name: "PostToolUse", tool_name: "Bash", agent_id: "zz-unbound" });
  assert.equal(w.record().state, "waiting: permission");
});

test("an event of a bound job agent takes the cockpit's claude pid again only once the recorded one has ended", { skip: process.platform !== "linux" }, async () => {
  const w = world();
  const first = spawn("sleep", ["30"], { argv0: "claude" });
  try {
    const live = { pid: first.pid, start: processInfo(first.pid).start };
    handle({ ...w.agent(launch(w.files[0])), transcript_path: w.main }, { dir: w.state, claude: () => live });
    handle({ ...w.agent(launch(w.files[0])), transcript_path: w.main }, { dir: w.state, claude: () => ({ pid: 5151, start: "9" }) });
    assert.equal(w.record().cockpit_pid, first.pid);
  } finally {
    first.kill("SIGKILL");
  }
  await new Promise((resolve) => first.once("exit", resolve));
  handle({ ...w.agent(launch(w.files[0])), transcript_path: w.main }, { dir: w.state, claude: () => ({ pid: 5151, start: "9" }) });
  assert.deepEqual([w.record().cockpit_pid, w.record().cockpit_pid_start], [5151, "9"]);
});

test("a corrupt record of another job does not stop the hook from updating this job", () => {
  const w = world();
  const input = w.agent(launch(w.files[0]));
  w.fire(input);
  writeFileSync(join(w.state, "jobs", "0".repeat(32) + ".json"), "{ trunc");
  w.fire({ ...input, hook_event_name: "SubagentStop" });
  assert.equal(w.record().state, "idle");
});

test("the hook script walks its parents to the nearest claude process, records that pid with its start time as the cockpit's, and prints nothing", { skip: process.platform !== "linux" }, () => {
  const w = world();
  const bin = tempDir("tedy-claude-bin-");
  const input = join(bin, "input.json");
  writeFileSync(input, JSON.stringify(w.agent(launch(w.files[0]), { id: "d4" })));
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nnode "${HOOK}" < "${input}"\nstatus=$?\nexit $status\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const run = spawnSync(join(bin, "claude"), [], { encoding: "utf8", env: { ...process.env, TEDY_STATE_DIR: w.state } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(w.record().agent_id, "d4");
  assert.equal(w.record().cockpit_pid, run.pid);
  assert.match(w.record().cockpit_pid_start, /^\d+$/);
});

test("alive needs the recorded pid to be a claude process with the recorded start time, so a reused or forged pid is not taken for the cockpit", { skip: process.platform !== "linux" }, async () => {
  const child = spawn("sleep", ["30"], { argv0: "claude" });
  const plain = spawn("sleep", ["30"]);
  try {
    const info = processInfo(child.pid);
    assert.equal(info.ppid, process.pid);
    assert.equal(alive({ pid: child.pid, pid_start: info.start }), true);
    assert.equal(alive({ pid: child.pid, pid_start: `${info.start}0` }), false);
    assert.equal(alive({ pid: undefined }), false);
    assert.equal(alive({ pid: plain.pid, pid_start: processInfo(plain.pid).start }), false);
    assert.equal(alive({ pid: process.pid, pid_start: processInfo(process.pid).start }), false);
    assert.notEqual(claudeProcess(plain.pid)?.pid, plain.pid);
  } finally {
    child.kill("SIGKILL");
    plain.kill("SIGKILL");
  }
});
