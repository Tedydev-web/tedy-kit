import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { card, cardCheck, cardNote, finishedJobs, waitingText } from "../lib/pending.mjs";
import { readCard } from "../lib/pending-cards.mjs";
import { heldElsewhere, jobBusy } from "../lib/job.mjs";
import { recordLaunch } from "../lib/job-files.mjs";
import { STATE_DIR } from "../lib/state-dir.mjs";
import { bound, jobFile, sleeper, world } from "./job-world-for-tests.mjs";

const SCRIPTS = new URL("../scripts/", import.meta.url).pathname.replace(/\/$/, "");
const PENDING = join(SCRIPTS, "pending.mjs");
const FAKE_COCKPIT = new URL("./fake-cockpit-for-tests.mjs", import.meta.url).pathname;

const here = () => ({ ...world(), state: STATE_DIR });
const question = (w, job, title) => card(w.map, "question", { title, job, body: `${title}?\n- Yes: go on\n- No: stop here\n` });
const status = (w, job, title, id) => card(w.map, "publish", { title, job, preview: "run", body: `### 1\nnode ${SCRIPTS}/openproject.mjs set ${id} --status "In Review" --job ${job}\n- #${id} Task ${id}\n` });

test("list --job prints only that job's line and cards, and nothing from another job, the drafts or git", () => {
  const w = world();
  const mine = jobFile(w, { name: "add-hello", status: "done" });
  const other = jobFile(w, { name: "fix-toast", status: "done" });
  const own = question(w, mine, "Which toast");
  const foreign = question(w, other, "Which colour");
  mkdirSync(join(w.root, "plans", "drafts"), { recursive: true });
  writeFileSync(join(w.root, "plans", "drafts", "loose-note.md"), "a draft with no card header\n");
  const list = (args) => spawnSync(process.execPath, [PENDING, "list", ...args], { cwd: w.root, encoding: "utf8", env: w.env() });
  const filtered = list(["--job", mine]);
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.match(filtered.stdout, new RegExp(`^Jobs:\n- dev: add hello \\(done, [^)]+\\) ${mine}$`, "m"));
  assert.match(filtered.stdout, new RegExp(`^Questions:\n- Which toast ${own}$`, "m"));
  assert.doesNotMatch(filtered.stdout, new RegExp(`${foreign}|fix-toast|loose-note|Unpushed|Draft PRs`));
  const everything = list(["--offline"]);
  assert.match(everything.stdout, /Which colour/);
  assert.match(everything.stdout, /loose-note/);
  assert.match(list(["--job", join(w.root, "plans", "jobs", "missing.md")]).stderr, /the job file .*missing\.md does not exist/);
  assert.equal(list(["--job"]).status, 2);
});

test("the ask list holds a question of a job whose agent ended its turn, even when its file still says running, and leaves out one whose agent still runs", async () => {
  const cockpit = await sleeper();
  try {
    const w = here();
    const waiting = jobFile(w, { name: "add-hello", record: bound(cockpit, { state: "idle" }) });
    const working = jobFile(w, { name: "fix-toast", record: bound(cockpit, { agent_id: "d4e5f6", state: "running" }) });
    const asked = question(w, waiting, "Which toast");
    const parked = question(w, working, "Which colour");
    const text = waitingText(w.map, { ask: true });
    assert.equal(text, `Questions:\n- Which toast ${asked}`);
    assert.match(waitingText(w.map, { offline: true }), new RegExp(`^- Which colour \\(job running\\) ${parked}$`, "m"));
  } finally {
    cockpit.child.kill();
    await cockpit.exited;
  }
});

test("the ask list holds a publish card only once its job file is not running, and a held one only when asked to", () => {
  const w = here();
  const running = jobFile(w, { name: "add-hello" });
  const finished = jobFile(w, { name: "fix-toast", status: "done" });
  status(w, running, "Status of 12", 12);
  const ready = status(w, finished, "Status of 13", 13);
  assert.equal(waitingText(w.map, { ask: true }), `To publish:\n- Status of 13 (run, 1 command) ${ready}`);
  cardNote(ready, "Not yet");
  assert.equal(waitingText(w.map, { ask: true, held: false }), "");
  assert.equal(waitingText(w.map, { ask: true }), `To publish:\n- Status of 13 (run, 1 command, held: Not yet) ${ready}`);
});

test("the ask list leaves out answered, refused, started and notice cards, and a card with no job counts as not running", () => {
  const w = here();
  const finished = jobFile(w, { name: "fix-toast", status: "done" });
  cardNote(question(w, finished, "Answered one"), "Yes");
  cardNote(question(w, finished, "Refused one"), "redo it", { refuse: true });
  card(w.map, "notify", { title: "CI is green", body: "All checks passed." });
  const loose = question(w, "none", "Loose one");
  assert.equal(waitingText(w.map, { ask: true }), `Questions:\n- Loose one ${loose}`);
});

test("a done job's card is not asked or run while its agent still writes, nor a card whose job another live cockpit runs", async () => {
  const cockpit = await sleeper();
  try {
    const w = here();
    const writing = jobFile(w, { name: "add-hello", status: "done", record: bound(cockpit, { state: "running" }) });
    const elsewhere = jobFile(w, { name: "fix-toast", status: "done", record: bound(cockpit, { agent_id: "d4e5f6", session_id: "s-other", state: "idle" }) });
    const late = question(w, writing, "Which toast");
    const theirs = question(w, elsewhere, "Which colour");
    const run = status(w, writing, "Status of 12", 12);
    assert.equal(waitingText(w.map, { ask: true, caller: { session: "s-other" } }), `Questions:\n- Which colour ${theirs}`);
    assert.equal(waitingText(w.map, { ask: true, caller: { session: "s-cockpit" } }), "");
    assert.match(waitingText(w.map, { offline: true }), new RegExp(`^- Which toast \\(job running\\) ${late}$`, "m"));
    assert.throws(() => cardCheck(run, w.map), /its job .* is still running and may rewrite the draft/);
  } finally {
    cockpit.child.kill();
    await cockpit.exited;
  }
});

test("card --job resolves against the project root and refuses a job file that does not exist, and a hand-written card naming a missing job is refused", () => {
  const w = here();
  const job = jobFile(w, { name: "add-hello", status: "done" });
  const relative = job.slice(w.root.length + 1);
  const file = card(w.map, "question", { title: "Which toast", job: relative, body: "Which?\n- A: a\n- B: b\n" });
  assert.match(readFileSync(file, "utf8"), new RegExp(`^job: ${job}$`, "m"));
  assert.throws(() => card(w.map, "question", { title: "Lost", job: "plans/jobs/261106-0900-dev-missing.md", body: "Which?\n- A: a\n- B: b\n" }), /card refused: its job file .*261106-0900-dev-missing\.md does not exist/);
  const hand = join(w.root, "plans", "drafts", "261106-0930-question-hand.md");
  writeFileSync(hand, `kind: question\ntitle: Hand\njob: ${join(w.root, "plans", "jobs", "261106-0900-dev-gone.md")}\n\nWhich?\n- A: a\n- B: b\n`);
  assert.match(waitingText(w.map, { offline: true }), /^Refused cards:\n- Hand: its job file .*261106-0900-dev-gone\.md does not exist /m);
});

test("card-check and the ask list treat a job whose agent another live cockpit runs as busy", async () => {
  const cockpit = await sleeper();
  try {
    const w = world();
    const job = jobFile(w, { name: "add-hello", status: "done", record: bound(cockpit, { state: "idle" }) });
    const run = card(w.map, "publish", { title: "Status of 12", job, preview: "run", body: `### 1\nnode ${SCRIPTS}/openproject.mjs set 12 --status "In Review" --job ${job}\n- #12 Task 12\n` });
    const pending = (args) => spawnSync(process.execPath, [FAKE_COCKPIT, PENDING, ...args], { cwd: w.root, encoding: "utf8", env: w.env(), argv0: "claude" });
    const checked = pending(["card-check", run]);
    assert.equal(checked.status, 1, checked.stdout);
    assert.match(checked.stderr, /card refused: its job .* is still running and may rewrite the draft, or another live cockpit runs it/);
    assert.match(pending(["list", "--offline"]).stdout, /^- Status of 12 \(run, 1 command, job running\) /m);
  } finally {
    cockpit.child.kill();
    await cockpit.exited;
  }
});

test("a card longer than the header prefix is still read whole, and a large draft with no card header is listed as a draft", () => {
  const w = here();
  const job = jobFile(w, { name: "add-hello", status: "done" });
  const long = card(w.map, "question", { title: "Long one", job, body: `${"Context line.\n".repeat(600)}Which?\n- A: a\n- B: b\n` });
  const big = join(w.root, "plans", "drafts", "big-notes.md");
  writeFileSync(big, `# notes\n\n${"x".repeat(2_000_000)}\n`);
  assert.equal(waitingText(w.map, { ask: true }), `Questions:\n- Long one ${long}`);
  assert.match(waitingText(w.map, { offline: true }), new RegExp(`^Drafts waiting on the user:\\n- ${big}$`, "m"));
});

test("a card whose header holds more than the prefix before its kind line is still a card, so its job is not closed", () => {
  const w = here();
  const job = jobFile(w, { role: "pm", name: "gaps", status: "done" });
  const long = join(w.root, "plans", "drafts", "261106-0915-question-long-title.md");
  mkdirSync(join(w.root, "plans", "drafts"), { recursive: true });
  writeFileSync(long, `title: ${"t".repeat(5000)}\nkind: question\njob: ${job}\n\nWhich?\n- A: a\n- B: b\n`);
  assert.equal(readCard(readFileSync(long, "utf8"))?.kind, "question");
  assert.match(waitingText(w.map, { ask: true }), new RegExp(`^- t{119}… ${long}$`, "m"));
  assert.deepEqual(finishedJobs(w.map).map((item) => item.path), []);
});

test("a caller that cannot be identified finds a job bound to a live cockpit busy", async () => {
  const cockpit = await sleeper();
  try {
    const w = here();
    const job = jobFile(w, { name: "add-hello", status: "done", record: bound(cockpit, { state: "idle" }) });
    assert.equal(jobBusy(job, { cockpit: null }), true);
    assert.equal(jobBusy(job, { session: "s-cockpit", cockpit: null }), false);
    assert.equal(jobBusy(job), false);
  } finally {
    cockpit.child.kill();
    await cockpit.exited;
  }
});

test("a card whose job can never be resumed is refused with the reason and never asked, and a publish card of a closed job is refused too", () => {
  const w = here();
  const closed = jobFile(w, { role: "pm", name: "closed", status: "closed" });
  const bare = jobFile(w, { role: "pm", name: "bare", status: "done", record: null });
  const gone = jobFile(w, { role: "pm", name: "gone", status: "done", record: { cwd: join(w.root, "no-such-folder") } });
  const asked = [closed, bare, gone].map((job, n) => question(w, job, `Question ${n}`));
  const publish = status(w, closed, "Status of 12", 12);
  assert.equal(waitingText(w.map, { ask: true }), "");
  const list = waitingText(w.map, { offline: true });
  assert.match(list, new RegExp(`^- Question 0: its job is closed; start a new job ${asked[0]}$`, "m"));
  assert.match(list, new RegExp(`^- Question 1: its job has no launch record, so an answer cannot reach it; start a new job ${asked[1]}$`, "m"));
  assert.match(list, new RegExp(`^- Question 2: its job's folder .*no-such-folder no longer exists; start a new job ${asked[2]}$`, "m"));
  assert.match(list, new RegExp(`^- Status of 12: its job is closed; start a new job ${publish}$`, "m"));
});

test("card --job and a hand-written card need a job file inside the jobs folder", () => {
  const w = here();
  writeFileSync(join(w.root, "README.md"), "to: tedy:pm\nfrom: cockpit\nstatus: done\n");
  mkdirSync(join(w.root, "plans", "jobs"), { recursive: true });
  writeFileSync(join(w.root, "plans", "jobs", "notes.md"), "not a job\n");
  const body = "Which?\n- A: a\n- B: b\n";
  assert.throws(() => card(w.map, "question", { title: "Outside", job: "README.md", body }), /card refused: its job file .*README\.md is not in .*plans\/jobs/);
  assert.throws(() => card(w.map, "question", { title: "Not a job", job: "plans/jobs/notes.md", body }), /card refused: its job file .*notes\.md is not a job file/);
});

test("an unidentified caller finds a job held by a live cockpit held elsewhere, as the busy check does", async () => {
  const cockpit = await sleeper();
  try {
    const w = here();
    const job = jobFile(w, { name: "add-hello", status: "done", record: bound(cockpit, { state: "idle" }) });
    assert.equal(heldElsewhere(job, { cockpit: null }), "s-cockpit");
    assert.equal(heldElsewhere(job, { session: "s-cockpit", cockpit: null }), null);
  } finally {
    cockpit.child.kill();
    await cockpit.exited;
  }
});
