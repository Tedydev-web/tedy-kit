import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchRecordPath, recordLaunch } from "../lib/job-files.mjs";
import { alive, claudeProcess, handle, processInfo } from "../lib/job-session-hooks.mjs";
import { fakeHerdr } from "./job-world-for-tests.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const PLUGIN = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const HOOK = join(PLUGIN, "scripts", "job-session-hooks.mjs");

function world(names = ["261109-1000-dev-add-hello"]) {
  const root = tempDir("tedy-job-hooks-");
  const state = join(root, "state");
  mkdirSync(join(root, "plans", "jobs"), { recursive: true });
  const files = names.map((name) => {
    const file = join(root, "plans", "jobs", `${name}.md`);
    writeFileSync(file, `to: tedy:${name.split("-")[2]}\nfrom: cockpit\nstatus: running\ncreated: 2026-11-09T03:00:00.000Z\ntitle: t\n\nbody\n`);
    recordLaunch(file, { role: name.split("-")[2], cwd: root }, state);
    return file;
  });
  const record = (file = files[0]) => JSON.parse(readFileSync(launchRecordPath(file, state), "utf8"));
  const claude = () => ({ pid: 4242, start: "777" });
  const fire = (input, now = "2026-11-09T04:00:00.000Z") => handle({ session_id: "s-1", ...input }, { dir: state, now, claude });
  const prompt = (content, { session = "s-1", event = "PreToolUse", extra = [] } = {}) => {
    const transcript = join(root, `${session}.jsonl`);
    const lines = [{ type: "user", message: { role: "user", content } }, ...extra].map((entry) => JSON.stringify(entry));
    writeFileSync(transcript, `${lines.join("\n")}\n`);
    return { hook_event_name: event, tool_name: "Bash", session_id: session, transcript_path: transcript, agent_type: "tedy:dev" };
  };
  return { root, state, files, record, fire, prompt };
}

const slash = (file) => `<command-message>tedy:dev</command-message>\n<command-name>/tedy:dev</command-name>\n<command-args>job ${file}. First read the jobs doc, section "Job".</command-args>`;

test("a job session's first event after a prompt naming its job file binds the session, its transcript and its claude pid into the launch record", () => {
  for (const [content, event] of [[(file) => slash(file), "PreToolUse"], [(file) => [{ type: "text", text: `Job file ${file}. Read the jobs doc.` }], "Notification"], [(file) => `/tedy:dev job ${file}. First read the jobs doc.`, "SessionStart"]]) {
    const w = world();
    const input = w.prompt(content(w.files[0]), { event });
    assert.deepEqual(w.fire(input), []);
    const record = w.record();
    assert.equal(record.session_id, "s-1", event);
    assert.equal(record.transcript_path, input.transcript_path);
    assert.equal(record.pid, 4242);
    assert.equal(record.pid_start, "777");
    assert.equal(record.last_event_at, "2026-11-09T04:00:00.000Z");
    assert.equal(record.role, "dev");
  }
});

test("the cockpit, a subagent, another role's session, a tool result or a reply naming the file, and a missing or unrecorded job file bind nothing", () => {
  const w = world();
  const unrecorded = join(w.root, "plans", "jobs", "261109-1001-dev-by-hand.md");
  writeFileSync(unrecorded, "to: tedy:dev\nfrom: cockpit\nstatus: running\n\nbody\n");
  const named = w.files[0];
  const inputs = [
    { ...w.prompt(slash(named)), agent_type: undefined },
    { ...w.prompt(slash(named)), agent_id: "a-1" },
    { ...w.prompt(slash(named)), agent_type: "tedy:pm" },
    { ...w.prompt(slash(named)), transcript_path: join(w.root, "none.jsonl") },
    w.prompt(slash(join(w.root, "plans", "jobs", "261109-1002-dev-missing.md"))),
    w.prompt(slash(unrecorded)),
    w.prompt("see plans/jobs/261109-1000-dev-add-hello.md"),
    w.prompt("hello", { extra: [{ type: "assistant", message: { content: [{ type: "text", text: named }] } }, { type: "user", message: { content: [{ type: "tool_result", content: named }] } }] }),
  ];
  for (const input of inputs) {
    assert.deepEqual(w.fire(input), []);
    assert.equal(w.record().session_id, undefined, JSON.stringify(input));
  }
});

test("binding reads only the kit's launch form at the start of the first user prompt, never another job path the prompt or a later prompt names", () => {
  const w = world(["261109-1000-dev-add-hello", "261109-1005-dev-other"]);
  const [mine, other] = w.files;
  const inputs = [
    w.prompt(`Go on with ${mine}`),
    w.prompt(`Same fix as in ${other}, please.\n\n/tedy:dev job ${mine}. First read the jobs doc.`),
    w.prompt([{ type: "text", text: `See ${other}` }, { type: "text", text: `Job file ${mine}.` }]),
    w.prompt("hello", { extra: [{ type: "user", message: { content: slash(mine) } }] }),
  ];
  for (const input of inputs) {
    assert.deepEqual(w.fire(input), []);
    assert.deepEqual([w.record(mine).session_id, w.record(other).session_id], [undefined, undefined], JSON.stringify(input));
  }
  w.fire(w.prompt(`${slash(mine)} Same fix as in ${other}, please.`));
  assert.deepEqual([w.record(mine).session_id, w.record(other).session_id], ["s-1", undefined]);
});

test("a second session naming a bound job file does not rebind it and only returns a warning for stderr", () => {
  const w = world();
  w.fire(w.prompt(slash(w.files[0])));
  const warnings = w.fire(w.prompt(slash(w.files[0]), { session: "s-2" }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /is already bound to session s-1; this session is not tracked as that job/);
  assert.equal(w.record().session_id, "s-1");
  assert.equal(w.record().pid, 4242);
});

test("a job file whose status is closed binds no session, even when its record has none, and the session does not bind a later job file it names", () => {
  const w = world(["261109-1000-dev-add-hello", "261109-1005-dev-other"]);
  writeFileSync(w.files[0], readFileSync(w.files[0], "utf8").replace("status: running", "status: closed"));
  assert.deepEqual(w.fire(w.prompt(`${slash(w.files[0])} then ${w.files[1]}`)), []);
  assert.equal(w.record(w.files[0]).session_id, undefined);
  assert.equal(w.record(w.files[0]).pid, undefined);
  assert.equal(w.record(w.files[1]).session_id, undefined);
});

test("a session bound to one job does not bind a second job file it names", () => {
  const w = world(["261109-1000-dev-add-hello", "261109-1005-dev-other"]);
  w.fire(w.prompt(slash(w.files[0])));
  w.fire(w.prompt(slash(w.files[1])));
  assert.equal(w.record(w.files[0]).session_id, "s-1");
  assert.equal(w.record(w.files[1]).session_id, undefined);
});

test("the record's state follows the hooks: permission and idle notifications, AskUserQuestion, tool results and the end of a turn", () => {
  const w = world();
  w.fire(w.prompt(slash(w.files[0])));
  const steps = [
    [{ hook_event_name: "Notification", notification_type: "permission_prompt" }, "waiting: permission"],
    [{ hook_event_name: "PostToolUse", tool_name: "Bash" }, "running"],
    [{ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }, "waiting: question"],
    [{ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion" }, "running"],
    [{ hook_event_name: "Stop" }, "idle"],
    [{ hook_event_name: "Notification", notification_type: "idle_prompt" }, "waiting: input"],
    [{ hook_event_name: "Notification", notification_type: "auth_success" }, "waiting: input"],
    [{ hook_event_name: "PostToolUse", tool_name: "Read" }, "running"],
  ];
  steps.forEach(([input, state], index) => {
    const now = `2026-11-09T05:0${index}:00.000Z`;
    w.fire(input, now);
    assert.equal(w.record().state, state, JSON.stringify(input));
    assert.equal(w.record().last_event_at, now);
  });
  const before = w.record();
  w.fire({ hook_event_name: "Stop", session_id: "s-other" });
  assert.deepEqual(w.record(), before);
});

test("inside herdr a job that starts waiting raises one herdr notification, and outside herdr or on a failed call nothing breaks", () => {
  const w = world();
  const bin = tempDir("tedy-herdr-bin-");
  const herdrCalls = fakeHerdr(bin);
  const env = (extra = {}) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, HERDR_ENV: "1", ...extra });
  const fire = (input, extra) => handle({ session_id: "s-1", ...input }, { dir: w.state, now: "2026-11-09T05:00:00.000Z", claude: () => null, env: env(extra) });
  fire(w.prompt(slash(w.files[0])));
  assert.deepEqual(fire({ hook_event_name: "Notification", notification_type: "permission_prompt" }), []);
  fire({ hook_event_name: "Notification", notification_type: "permission_prompt" });
  assert.deepEqual(herdrCalls(), [["notification", "show", "tedy dev job: waiting: permission", "--body", "261109-1000-dev-add-hello.md", "--sound", "request"]]);
  fire({ hook_event_name: "PostToolUse", tool_name: "Bash" });
  fire({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }, { HERDR_ENV: "" });
  assert.equal(herdrCalls().length, 1);
  fire({ hook_event_name: "Stop" });
  const warnings = fire({ hook_event_name: "Notification", notification_type: "idle_prompt" }, { FAKE_HERDR_FAIL: "notification show:server_unavailable" });
  assert.deepEqual(warnings, ["herdr notification show failed (server_unavailable: fake failure); the job is waiting: input"]);
  assert.equal(w.record().state, "waiting: input");
});

test("SessionStart of a bound session records its claude pid again", () => {
  const w = world();
  w.fire(w.prompt(slash(w.files[0])));
  w.fire({ hook_event_name: "Stop" });
  handle({ hook_event_name: "SessionStart", source: "resume", session_id: "s-1" }, { dir: w.state, now: "2026-11-09T06:00:00.000Z", claude: () => ({ pid: 5151, start: "888" }) });
  assert.equal(w.record().pid, 5151);
  assert.equal(w.record().pid_start, "888");
  assert.equal(w.record().state, "running");
});

test("a corrupt record of another job does not stop the hook from updating this job", () => {
  const w = world();
  w.fire(w.prompt(slash(w.files[0])));
  writeFileSync(join(w.state, "jobs", "0".repeat(32) + ".json"), "{ trunc");
  w.fire({ hook_event_name: "Stop" });
  assert.equal(w.record().state, "idle");
});

test("the hook script walks its parents to the nearest claude process, records that pid with its start time, and prints nothing", { skip: process.platform !== "linux" }, () => {
  const w = world();
  const bin = tempDir("tedy-claude-bin-");
  const input = join(bin, "input.json");
  writeFileSync(input, JSON.stringify(w.prompt(slash(w.files[0]), { session: "s-9", event: "Notification" })));
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nnode "${HOOK}" < "${input}"\nstatus=$?\nexit $status\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const run = spawnSync(join(bin, "claude"), [], { encoding: "utf8", env: { ...process.env, TEDY_STATE_DIR: w.state } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(w.record().session_id, "s-9");
  assert.equal(w.record().pid, run.pid);
  assert.match(w.record().pid_start, /^\d+$/);
  assert.equal(alive(w.record()), false);
});

test("alive needs the recorded pid to be a claude process with the recorded start time, so a reused or forged pid is not taken for the job", { skip: process.platform !== "linux" }, async () => {
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
