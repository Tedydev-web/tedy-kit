import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { launchRecordPath } from "../lib/job-files.mjs";
import { resume, resumeRefusal } from "../lib/job.mjs";
import { withLockSync } from "../lib/record-lock.mjs";
import { STATE_DIR } from "../lib/state-dir.mjs";
import { BODY, bound, jobFile, PLUGIN, sleeper, v0225Job, world } from "./job-world-for-tests.mjs";

const ME = { pid: 1, start: "the caller" };
const here = () => ({ ...world(), state: STATE_DIR });
const edit = (file, from, to) => writeFileSync(file, readFileSync(file, "utf8").replace(from, to));

function refusedBy(w, file, note, caller = ME) {
  try {
    resume(w.map, file, note, { caller: () => caller });
  } catch (error) {
    return error;
  }
  return null;
}

const body = (source, head) => {
  const from = source.indexOf(head);
  assert.ok(from >= 0, head);
  return source.slice(from, source.indexOf("\n}\n", from));
};

test("resume throws only through the refusal path, so every refusal it can give is the one resumeRefusal gives", () => {
  const source = readFileSync(join(PLUGIN, "lib", "job.mjs"), "utf8");
  const throws = [body(source, "export function resume("), body(source, "function resumeWrites(")].flatMap((text) => text.match(/\bthrow\b[^;]*/g) ?? []);
  assert.ok(throws.length > 0);
  for (const statement of throws) assert.match(statement, /^throw (refused|asRefusal)\(/, statement);
});

test("resumeRefusal gives the exact reason and kind resume refuses with, on every refusal path", async () => {
  const cockpit = await sleeper();
  try {
    const cases = [];
    const add = (name, kind, build, note = "go on") => cases.push({ name, kind, build, note });
    add("an empty note", "busy", (w) => jobFile(w, { role: "pm", name: "quiet", status: "done" }), "  \n");
    add("a job file that does not exist", "permanent", (w) => join(w.root, "plans", "jobs", "261106-0900-pm-missing.md"));
    add("a job file outside the jobs folder", "permanent", (w) => {
      mkdirSync(join(w.root, "elsewhere"), { recursive: true });
      const file = join(w.root, "elsewhere", "261106-0900-pm-outside.md");
      writeFileSync(file, `to: tedy:pm\nfrom: cockpit\nstatus: done\ncreated: c\ntitle: outside\ncwd: ${w.root}\n\n${BODY}`);
      return file;
    });
    add("a to: line that disagrees with the file name", "permanent", (w) => {
      const file = jobFile(w, { role: "dev", name: "lied", status: "done" });
      edit(file, "to: tedy:dev", "to: tedy:pm");
      return file;
    });
    add("a cwd header that drifted from the launch record", "permanent", (w) => {
      const file = jobFile(w, { role: "pm", name: "drift", status: "done" });
      edit(file, `cwd: ${w.root}`, `cwd: ${join(w.root, "fe")}`);
      return file;
    });
    add("a read-only repository", "permanent", (w) => jobFile(w, { role: "dev", name: "readonly", status: "done", header: [`repo: ${join(w.root, "be")}`], record: { repo: join(w.root, "be") } }));
    add("a removed repository", "permanent", (w) => {
      const file = jobFile(w, { role: "dev", name: "removed", status: "done", header: [`repo: ${join(w.root, "fe")}`], record: { repo: join(w.root, "fe") } });
      rmSync(join(w.root, "fe"), { recursive: true, force: true });
      return file;
    });
    add("a closed job", "permanent", (w) => jobFile(w, { role: "pm", name: "closed", status: "closed" }));
    add("no launch record", "permanent", (w) => jobFile(w, { role: "pm", name: "bare", status: "done", record: null }));
    add("a folder that no longer exists", "permanent", (w) => jobFile(w, { role: "pm", name: "gone", status: "done", header: [`cwd: ${join(w.root, "gone")}`], record: { cwd: join(w.root, "gone") } }));
    add("a bound agent with no cockpit pid recorded", "permanent", (w) => jobFile(w, { role: "pm", name: "nopid", status: "done", record: { agent_id: "a1b2c3", cockpit_pid: undefined, cockpit_pid_start: undefined, state: "idle" } }));
    add("a launch record that cannot be read", "busy", (w) => {
      const file = jobFile(w, { role: "pm", name: "garbled", status: "done" });
      writeFileSync(launchRecordPath(realpathSync(file)), "{not json\n");
      return file;
    });
    add("an older kit's worktree check that fails", "busy", (w) => {
      mkdirSync(join(w.root, "older-tree"), { recursive: true });
      return v0225Job(w, { sessionCwd: join(w.root, "older-tree") });
    });
    add("an older kit's session still open", "busy", (w) => v0225Job(w, { session: { pid: cockpit.pid, start: cockpit.start } }));
    add("an agent still running in a live cockpit", "busy", (w) => jobFile(w, { role: "pm", name: "running", status: "done", record: bound(cockpit, { state: "running" }) }));
    add("an agent not started while its cockpit lives", "busy", (w) => jobFile(w, { role: "pm", name: "starting", status: "done", record: { cockpit_pid: cockpit.pid, cockpit_pid_start: cockpit.start } }));
    add("an idle agent of another live cockpit", "busy", (w) => jobFile(w, { role: "pm", name: "elsewhere", status: "done", record: bound(cockpit, { state: "idle" }) }));
    for (const { name, kind, build, note } of cases) {
      const w = here();
      const file = build(w);
      const refusal = resumeRefusal(w.map, file, { cockpit: ME }, note);
      const thrown = refusedBy(w, file, note);
      assert.ok(thrown, name);
      assert.equal(thrown.kind, kind, name);
      assert.equal(refusal?.kind, kind, name);
      assert.equal(thrown.message, refusal.reason, name);
    }
    const w = here();
    const fine = jobFile(w, { role: "pm", name: "fine", status: "done", record: bound(cockpit, { state: "idle" }) });
    assert.equal(resumeRefusal(w.map, fine, { cockpit: { pid: cockpit.pid, start: cockpit.start } }), null);
    assert.equal(resumeRefusal(w.map, fine, { session: "s-cockpit", cockpit: null }), null);
    assert.equal(resumeRefusal(w.map, fine, { cockpit: null }).kind, "busy");
  } finally {
    cockpit.child.kill();
    await cockpit.exited;
  }
});

test("a write that fails inside resume comes out as a busy refusal", { skip: process.getuid?.() === 0 }, async () => {
  const cockpit = await sleeper();
  const w = here();
  const file = jobFile(w, { role: "pm", name: "locked-out", status: "done", record: bound(cockpit, { state: "idle" }) });
  chmodSync(dirname(file), 0o500);
  try {
    const thrown = refusedBy(w, file, "go on", { pid: cockpit.pid, start: cockpit.start });
    assert.equal(thrown?.kind, "busy", thrown?.message);
    assert.match(thrown.message, /the resume did not finish, run it again$/);
  } finally {
    chmodSync(dirname(file), 0o755);
    cockpit.child.kill();
    await cockpit.exited;
  }
});

test("two resumes of one idle job at once send it once, and the other is refused as busy", async () => {
  const cockpit = await sleeper();
  const w = here();
  const file = jobFile(w, { role: "pm", name: "raced", status: "done", record: bound(cockpit, { state: "idle" }) });
  const record = launchRecordPath(realpathSync(file));
  const code = `const { resume } = await import(${JSON.stringify(pathToFileURL(join(PLUGIN, "lib", "job.mjs")).href)});
try { console.log(JSON.stringify(resume(${JSON.stringify(w.map)}, ${JSON.stringify(file)}, "go on", { caller: () => (${JSON.stringify({ pid: cockpit.pid, start: cockpit.start })}) }))); }
catch (error) { console.log(JSON.stringify({ kind: error.kind ?? "none", reason: error.message })); }`;
  const children = [];
  try {
    withLockSync(`launch-record:${record}`, () => {
      for (let n = 0; n < 2; n += 1) children.push(spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] }));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }, { state: dirname(dirname(record)) });
    const outputs = await Promise.all(children.map(async (child) => {
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      await once(child, "exit");
      return JSON.parse(out);
    }));
    assert.equal(outputs.filter((output) => output.tool === "SendMessage").length, 1, JSON.stringify(outputs));
    assert.deepEqual(outputs.filter((output) => !output.tool).map((output) => output.kind), ["busy"], JSON.stringify(outputs));
  } finally {
    cockpit.child.kill();
    await cockpit.exited;
  }
});

test("the resume command prints each refusal after busy: or refused:", async () => {
  const cockpit = await sleeper();
  const w = world();
  const note = join(w.root, "note.md");
  writeFileSync(note, "more\n");
  try {
    const closed = w.run(["resume", jobFile(w, { role: "pm", name: "shut", status: "closed" }), "--note-file", note]);
    assert.equal(closed.status, 1);
    assert.match(closed.stderr, /^refused: .* is closed; start a new job instead\n$/);
    const starting = w.run(["resume", jobFile(w, { role: "pm", name: "early", status: "done", record: { cockpit_pid: cockpit.pid, cockpit_pid_start: cockpit.start } }), "--note-file", note]);
    assert.equal(starting.status, 1);
    assert.match(starting.stderr, /^busy: .*may be starting/);
    const empty = join(w.root, "empty.md");
    writeFileSync(empty, "\n");
    assert.match(w.run(["resume", jobFile(w, { role: "pm", name: "blank", status: "done" }), "--note-file", empty]).stderr, /^busy: .*the note is empty/);
  } finally {
    cockpit.child.kill();
    await cockpit.exited;
  }
});
