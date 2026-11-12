import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "../lib/job-files.mjs";
import { bound, jobFile, sleeper, world } from "./job-world-for-tests.mjs";

const status = (file) => parse(readFileSync(file, "utf8")).status;
const fakeGh = (w, body) => {
  writeFileSync(join(w.bin, "gh"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(w.bin, "gh"), 0o755);
};
const question = (w, job) => {
  mkdirSync(join(w.root, "plans", "drafts"), { recursive: true });
  writeFileSync(join(w.root, "plans", "drafts", "261106-0915-question-which-toast.md"), `kind: question\ntitle: Which toast\njob: ${job}\n\nWhich toast text?\n- Short: one line\n- Long: two lines\n`);
};

test("close --if-finished closes every done job no open card names, and leaves running jobs and jobs with an open card", () => {
  const w = world();
  const finished = jobFile(w, { role: "pm", name: "gaps", status: "done" });
  const waiting = jobFile(w, { role: "pm", name: "toast", status: "done" });
  const running = jobFile(w, { role: "review", name: "pr-12" });
  question(w, waiting);
  const out = w.run(["close", "--if-finished"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`^closed: ${finished}$`, "m"));
  assert.deepEqual([status(finished), status(waiting), status(running)], ["closed", "done", "running"]);
  const one = w.run(["close", running, "--if-finished"]);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(one.stdout, `kept ${running}: it is not done, or a card still names it\n`);
  assert.equal(w.run(["close", "--if-finished", "--reason", "x"]).status, 1);
});

test("a done dev job stays open while its recorded branch has an open PR, or the read fails, and closes once no PR from that branch is open", () => {
  const w = world();
  const log = join(w.root, "gh.log");
  const repo = join(w.root, "fe");
  const dev = jobFile(w, { role: "dev", name: "add-hello", status: "done", record: { repo, branch: "feat/add-hello" } });
  fakeGh(w, `echo "$PWD|$*" >> "${log}"; echo https://github.com/o/r/pull/7`);
  assert.equal(w.run(["close", dev, "--if-finished"]).stdout, `kept ${dev}: its branch feat/add-hello has an open PR (https://github.com/o/r/pull/7); it closes once that PR is merged or closed, or when the user asks\n`);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [`${repo}|pr list --head feat/add-hello --state open --json url --jq .[].url`]);
  fakeGh(w, 'echo "HTTP 502" >&2; exit 1');
  assert.match(w.run(["close", dev, "--if-finished"]).stdout, new RegExp(`^kept ${dev}: the open PRs of its branch feat/add-hello could not be read \\(.*HTTP 502.*\\), so it stays open$`, "m"));
  assert.equal(status(dev), "done");
  fakeGh(w, "true");
  assert.match(w.run(["close", dev, "--if-finished"]).stdout, new RegExp(`^closed: ${dev}$`, "m"));
  assert.equal(status(dev), "closed");
});

test("a done dev job whose launch record names no repository or branch stays open, whatever its outcome says, and a job of another role needs no PR read", () => {
  const w = world();
  fakeGh(w, 'echo "gh must not run" >&2; exit 1');
  const dev = jobFile(w, { role: "dev", name: "report-only", status: "done" });
  appendFileSync(dev, "\n## Outcome\n\nNo PR; report plans/reports/dev.md\n");
  const review = jobFile(w, { role: "review", name: "pr-7", status: "done" });
  appendFileSync(review, "\n## Outcome\n\nReviewed https://github.com/o/r/pull/7\n");
  const out = w.run(["close", "--if-finished"]);
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes(`kept ${dev}: its launch record names no repository and branch, so the kit cannot tell whether a PR from it is open; close it with plain job.mjs close when the user asks`), out.stdout);
  assert.deepEqual([status(dev), status(review)], ["done", "closed"]);
});

test("close --if-finished closes nothing while a card cannot be read, and says why", { skip: process.getuid?.() === 0 }, () => {
  const w = world();
  const finished = jobFile(w, { role: "pm", name: "gaps", status: "done" });
  mkdirSync(join(w.root, "plans", "drafts"), { recursive: true });
  const unreadable = join(w.root, "plans", "drafts", "261106-0915-question-locked.md");
  writeFileSync(unreadable, `kind: question\ntitle: Locked\njob: ${finished}\n\nWhich?\n- A: a\n- B: b\n`);
  chmodSync(unreadable, 0o000);
  try {
    const out = w.run(["close", "--if-finished"]);
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stderr, new RegExp(`^job: a card could not be read \\(.*261106-0915-question-locked\\.md: EACCES\\), so no job was closed$`, "m"));
    assert.equal(status(finished), "done");
  } finally {
    chmodSync(unreadable, 0o644);
  }
});

test("close --if-finished keeps a done job whose agent still runs in a live cockpit, with close's own refusal", async () => {
  const cockpit = await sleeper();
  try {
    const w = world();
    const busy = jobFile(w, { role: "pm", name: "gaps", status: "done", record: bound(cockpit, { state: "running" }) });
    const out = w.run(["close", "--if-finished"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`^kept ${busy}: .*its agent pm-gaps \\(a1b2c3\\) is running in cockpit session s-cockpit .*nothing was closed$`, "m"));
    assert.equal(status(busy), "done");
  } finally {
    cockpit.child.kill();
    await cockpit.exited;
  }
});

test("a done job that a started or refused card still names is not closed", () => {
  const w = world();
  const started = jobFile(w, { role: "pm", name: "started", status: "done" });
  const refused = jobFile(w, { role: "pm", name: "refused", status: "done" });
  mkdirSync(join(w.root, "plans", "drafts"), { recursive: true });
  writeFileSync(join(w.root, "plans", "drafts", "261106-0915-question-started.md"), `kind: question\ntitle: Started\njob: ${started}\nstatus: started\nstarted: 2026-11-12T01:00:00.000Z\n\nWhich?\n- A: a\n- B: b\n`);
  writeFileSync(join(w.root, "plans", "drafts", "261106-0916-question-refused.md"), `kind: question\ntitle: Refused\njob: ${refused}\nstatus: refused\nrefused: redo it\n\nWhich?\n- A: a\n- B: b\n`);
  const out = w.run(["close", "--if-finished"]);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual([status(started), status(refused)], ["done", "done"], out.stdout);
});
