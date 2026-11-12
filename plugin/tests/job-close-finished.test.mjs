import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "../lib/job-files.mjs";
import { bound, jobFile, sleeper, world } from "./job-world-for-tests.mjs";

const status = (file) => parse(readFileSync(file, "utf8")).status;
const withPr = (file, url = "https://github.com/o/r/pull/7") => appendFileSync(file, `\n## Outcome\n\nDraft PR ${url}, report plans/reports/dev.md\n`);
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

test("a done dev job stays open while its PR is open or its state cannot be read, and closes once the PR is merged or closed", () => {
  const w = world();
  const dev = jobFile(w, { role: "dev", name: "add-hello", status: "done" });
  withPr(dev);
  fakeGh(w, 'echo OPEN');
  assert.equal(w.run(["close", dev, "--if-finished"]).stdout, `kept ${dev}: its PR https://github.com/o/r/pull/7 is open; it closes once the PR is merged or closed, or when the user asks\n`);
  fakeGh(w, 'echo "HTTP 502" >&2; exit 1');
  assert.match(w.run(["close", dev, "--if-finished"]).stdout, new RegExp(`^kept ${dev}: the state of its PR https://github\\.com/o/r/pull/7 could not be read \\(.*HTTP 502.*\\), so it stays open$`, "m"));
  assert.equal(status(dev), "done");
  fakeGh(w, 'echo MERGED');
  assert.match(w.run(["close", dev, "--if-finished"]).stdout, new RegExp(`^closed: ${dev}$`, "m"));
  assert.equal(status(dev), "closed");
});

test("a PR named outside the job's outcome, or by a job that is not dev, does not keep it open", () => {
  const w = world();
  fakeGh(w, "echo OPEN");
  const review = jobFile(w, { role: "review", name: "pr-7", status: "done" });
  withPr(review);
  const dev = jobFile(w, { role: "dev", name: "report-only", status: "done" });
  writeFileSync(dev, readFileSync(dev, "utf8").replace("Add the line hello", "Rework https://github.com/o/r/pull/9: add the line hello"));
  const out = w.run(["close", "--if-finished"]);
  assert.deepEqual([status(review), status(dev)], ["closed", "closed"], out.stdout + out.stderr);
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

test("every outcome section counts up to the next note or outcome, whatever headings it holds, and a PR named as o/r#n, #n or on another host keeps the dev job open", () => {
  const w = world();
  const log = join(w.root, "gh.log");
  fakeGh(w, `echo "$PWD|$*" >> "${log}"; echo OPEN`);
  const nested = jobFile(w, { role: "dev", name: "nested", status: "done" });
  appendFileSync(nested, "\n## Outcome\n\nDone.\n\n## PR\n\nDraft PR https://github.com/o/r/pull/7\n");
  const short = jobFile(w, { role: "dev", name: "short", status: "done" });
  appendFileSync(short, "\n## Outcome\n\nOpened o/r#8 for OP#21298.\n");
  const bare = jobFile(w, { role: "dev", name: "bare", status: "done" });
  appendFileSync(bare, "\n## Outcome\n\nOpened #9, task OP#21298.\n\n## Note 2026-11-12T01:00:00.000Z\n\nsee https://github.com/o/r/pull/99\n");
  const hosted = jobFile(w, { role: "dev", name: "hosted", status: "done" });
  appendFileSync(hosted, "\n## Outcome\n\nPR https://git.example.com/team/app/pull/3\n");
  const out = w.run(["close", "--if-finished"]);
  assert.equal(out.status, 0, out.stderr);
  for (const [file, ref] of [[nested, "https://github.com/o/r/pull/7"], [short, "o/r#8"], [bare, "#9"], [hosted, "https://git.example.com/team/app/pull/3"]]) {
    assert.ok(out.stdout.includes(`kept ${file}: its PR ${ref} is open;`), `${ref}\n${out.stdout}`);
    assert.equal(status(file), "done");
  }
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  assert.ok(calls.includes(`${w.root}|pr view 8 --repo o/r --json state --jq .state`), calls.join("\n"));
  assert.ok(calls.includes(`${w.root}|pr view 9 --json state --jq .state`), calls.join("\n"));
  assert.ok(!calls.some((call) => /21298|pull\/99/.test(call)), calls.join("\n"));
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
