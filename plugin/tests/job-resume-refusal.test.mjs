import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { resume, resumeRefusal } from "../lib/job.mjs";
import { STATE_DIR } from "../lib/state-dir.mjs";
import { BODY, bound, jobFile, sleeper, v0225Job, world } from "./job-world-for-tests.mjs";

const ME = { pid: 1, start: "the caller" };
const here = () => ({ ...world(), state: STATE_DIR });
const edit = (file, from, to) => writeFileSync(file, readFileSync(file, "utf8").replace(from, to));

function refusedBy(w, file) {
  try {
    resume(w.map, file, "go on", { caller: () => ME });
  } catch (error) {
    return error.message;
  }
  return null;
}

test("resumeRefusal gives the exact reason resume refuses with, on every refusal path, and sorts each as busy or permanent", async () => {
  const cockpit = await sleeper();
  try {
    const cases = [];
    const add = (name, kind, build) => cases.push({ name, kind, build });
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
    add("an older kit's session still open", "busy", (w) => v0225Job(w, { session: { pid: cockpit.pid, start: cockpit.start } }));
    add("an agent still running in a live cockpit", "busy", (w) => jobFile(w, { role: "pm", name: "running", status: "done", record: bound(cockpit, { state: "running" }) }));
    add("an agent not started while its cockpit lives", "busy", (w) => jobFile(w, { role: "pm", name: "starting", status: "done", record: { cockpit_pid: cockpit.pid, cockpit_pid_start: cockpit.start } }));
    add("an idle agent of another live cockpit", "busy", (w) => jobFile(w, { role: "pm", name: "elsewhere", status: "done", record: bound(cockpit, { state: "idle" }) }));
    for (const { name, kind, build } of cases) {
      const w = here();
      const file = build(w);
      const refusal = resumeRefusal(w.map, file, { cockpit: ME });
      const thrown = refusedBy(w, file);
      assert.ok(thrown, name);
      assert.equal(refusal?.reason, thrown, name);
      assert.equal(refusal.kind, kind, name);
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
