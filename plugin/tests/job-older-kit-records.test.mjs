import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { launchRecordPath, parse, readJob } from "../lib/job-files.mjs";
import { processInfo } from "../lib/job-session-hooks.mjs";
import { commitFile, git } from "./git-sibling-for-tests.mjs";
import { PLUGIN, sleeper, v0224Job, v0225Job, world } from "./job-world-for-tests.mjs";

const note = (w) => {
  const file = join(w.root, "note.md");
  writeFileSync(file, "go on with the second screen\n");
  return file;
};

test("job files that v0.2.24 and v0.2.25 wrote read their whole header, whatever older keys it holds", () => {
  const w = world();
  const fe = join(w.root, "fe");
  const tree = join(w.root, ".worktrees", "fe-old-hello");
  const files = {
    v0224: v0224Job(w, { mode: "default" }),
    v0225: v0225Job(w, { mode: "acceptEdits", tree }),
    t3: v0225Job(w, { name: "old-t3", via: "t3", tree, mode: "default" }),
    herdr: v0225Job(w, { name: "old-herdr", via: "herdr", tree }),
  };
  const read = (file) => {
    const { cwd, repo, branch, base, worktree, worktree_owner: owner, permission_mode: mode, session_id: session } = readJob(file);
    return { cwd, repo, branch, base, worktree, owner, mode, session };
  };
  assert.deepEqual(read(files.v0224), { cwd: w.root, repo: undefined, branch: undefined, base: undefined, worktree: undefined, owner: undefined, mode: "default", session: "4f0c2a7e-0224" });
  assert.deepEqual(read(files.v0225), { cwd: tree, repo: fe, branch: "feat/old-hello", base: "main", worktree: tree, owner: "core", mode: "acceptEdits", session: undefined });
  assert.deepEqual(read(files.t3), { cwd: fe, repo: fe, branch: "feat/old-hello", base: "main", worktree: undefined, owner: "t3", mode: "default", session: undefined });
  assert.deepEqual(read(files.herdr), { cwd: tree, repo: fe, branch: "feat/old-hello", base: "main", worktree: tree, owner: "herdr", mode: undefined, session: undefined });
});

test("resume of a job that v0.2.24 or v0.2.25 wrote prints a fresh Agent spec carrying the note, and never a false difference from its launch record", () => {
  const w = world();
  const files = [v0224Job(w, { mode: "default" }), v0224Job(w, { role: "review", name: "old-review", session: undefined }), v0225Job(w, { mode: "default" }), v0225Job(w, { role: "pm", name: "old-pm", via: "t3", session: false })];
  for (const file of files) {
    const out = w.run(["resume", file, "--note-file", note(w)]);
    assert.equal(out.status, 0, `${file}: ${out.stderr}`);
    const spec = JSON.parse(out.stdout);
    assert.equal(spec.tool, "Agent", file);
    assert.equal(spec.run_in_background, true, file);
    assert.ok(spec.prompt.startsWith(`Job file ${JSON.stringify(file)}`), file);
    assert.match(spec.prompt, /\n\ngo on with the second screen$/, file);
    const text = readFileSync(file, "utf8");
    assert.equal(parse(text).status, "running", file);
    assert.match(text, /\n## Note [^\n]+\n\ngo on with the second screen\n$/, file);
  }
  assert.deepEqual(w.calls(), []);
});

test("resume of a T3 dev job v0.2.25 started sends every fresh agent to the worktree its session recorded, and to the job file's folder when that path is no worktree of its repository", () => {
  const w = world();
  const fe = join(w.root, "fe");
  git(w.root, "init", "-q", "-b", "main", fe);
  commitFile(fe, "notes.txt", "start\n");
  const t3Tree = join(w.root, ".t3-worktrees", "fe-old-hello");
  git(fe, "worktree", "add", "-q", "-b", "feat/old-hello", t3Tree);
  commitFile(t3Tree, "notes.txt", "start\nhello\n", "work done by the T3 job");
  const plain = join(w.root, "elsewhere");
  mkdirSync(plain);
  const file = v0225Job(w, { via: "t3", tree: t3Tree, sessionCwd: t3Tree });
  const other = v0225Job(w, { name: "old-plain", via: "t3", tree: t3Tree, sessionCwd: plain });
  const folder = `Work in ${JSON.stringify(t3Tree)}: the older kit's session worked this job there, so its branch and commits are there, not in the folder the job file's cwd names.`;
  for (const round of [1, 2]) {
    const out = w.run(["resume", file, "--note-file", note(w)]);
    assert.equal(out.status, 0, `${round}: ${out.stderr}`);
    const spec = JSON.parse(out.stdout);
    assert.equal(spec.tool, "Agent", `${round}`);
    assert.ok(spec.prompt.startsWith(`Job file ${JSON.stringify(file)}`), `${round}`);
    assert.ok(spec.prompt.includes(` ${folder} The job is resumed:`), `${round}: ${spec.prompt}`);
  }
  assert.equal(readJob(file).cwd, fe);
  const plainSpec = JSON.parse(w.run(["resume", other, "--note-file", note(w)]).stdout);
  assert.ok(!plainSpec.prompt.includes("Work in "), plainSpec.prompt);
  assert.deepEqual(w.calls(), []);
});

const OLDER_KIT = "this job came from an older kit; nothing was signalled, and any session it had (a T3 thread, a terminal pane or a claude session) is the user's to end";

test("close closes a job that v0.2.24 or v0.2.25 wrote without signalling its session, says so, and leaves a worktree another tool made", async () => {
  const w = world();
  const session = await sleeper();
  try {
    const tree = join(w.root, ".worktrees", "fe-old-hello");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "work.txt"), "x\n");
    const files = [
      v0224Job(w, { mode: "default" }),
      v0224Job(w, { role: "review", name: "old-review", session: undefined }),
      v0225Job(w, { mode: "default" }),
      v0225Job(w, { name: "old-open", session: { pid: session.pid, start: session.start } }),
      v0225Job(w, { name: "old-t3", via: "t3", tree }),
      v0225Job(w, { name: "old-herdr", via: "herdr", tree }),
      v0225Job(w, { role: "pm", name: "old-unbound", session: false }),
    ];
    for (const file of files) {
      const out = w.run(["close", file]);
      assert.equal(out.status, 0, `${file}: ${out.stderr}`);
      assert.equal(out.stdout, `closed: ${file}\n${OLDER_KIT}\n`, file);
      assert.equal(parse(readFileSync(file, "utf8")).status, "closed", file);
      assert.deepEqual([w.record(file).state, w.record(file).agents], ["closed", {}], file);
    }
    assert.equal(readFileSync(join(tree, "work.txt"), "utf8"), "x\n");
    assert.equal(processInfo(session.pid).start, session.start);
    const running = v0225Job(w, { name: "old-running", status: "running" });
    assert.match(w.run(["close", running]).stderr, /is still running; give --reason to stop it/);
    const stopped = w.run(["close", running, "--reason", "upgraded the kit"]);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(stopped.stdout, `closed: ${running}\n${OLDER_KIT}\n`);
    assert.match(readFileSync(running, "utf8"), /\n## Outcome\n\nStopped: upgraded the kit\n$/);
  } finally {
    session.child.kill("SIGKILL");
  }
  assert.deepEqual(w.calls(), []);
});

test("a job that v0.2.25 wrote, once resumed, keeps its agent name in its record and closes as a job of this kit", () => {
  const w = world();
  const file = v0225Job(w);
  const spec = JSON.parse(w.run(["resume", file, "--note-file", note(w)]).stdout);
  assert.equal(spec.name, "dev-2611101000-old-hello");
  const record = w.record(file);
  assert.deepEqual([record.agent_name, record.agent_id, record.session_id, record.state], [spec.name, undefined, undefined, undefined]);
  assert.ok(Number.isInteger(record.cockpit_pid), JSON.stringify(record));
  const out = w.run(["close", file, "--reason", "done by hand"]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, `closed: ${file}\n`);
});

test("resume of a job an older kit started refuses and writes nothing while the claude session it recorded is still open, and prints a fresh Agent spec once that session has ended", async () => {
  const w = world();
  const session = await sleeper();
  const file = v0225Job(w, { name: "old-open", status: "running", session: { pid: session.pid, start: session.start } });
  const reused = v0225Job(w, { name: "old-reused", session: { pid: session.pid, start: `${session.start}9` } });
  const text = readFileSync(file, "utf8");
  const record = readFileSync(launchRecordPath(file, w.state), "utf8");
  try {
    const refused = w.run(["resume", file, "--note-file", note(w)]);
    assert.equal(refused.status, 1, refused.stdout);
    assert.equal(refused.stdout, "");
    assert.equal(refused.stderr, `busy: ${file}: the session an older kit recorded for this job (claude pid ${session.pid}) is still open; end that session first, then resume it again; nothing was resumed\n`);
    assert.equal(readFileSync(file, "utf8"), text);
    assert.equal(readFileSync(launchRecordPath(file, w.state), "utf8"), record);
    const other = w.run(["resume", reused, "--note-file", note(w)]);
    assert.equal(other.status, 0, other.stderr);
    assert.equal(JSON.parse(other.stdout).tool, "Agent");
  } finally {
    session.child.kill("SIGKILL");
    await session.exited;
  }
  const out = w.run(["resume", file, "--note-file", note(w)]);
  assert.equal(out.status, 0, out.stderr);
  const spec = JSON.parse(out.stdout);
  assert.equal(spec.tool, "Agent");
  assert.match(spec.prompt, /\n\ngo on with the second screen$/);
  assert.equal(w.record(file).agent_name, spec.name);
  assert.deepEqual(w.calls(), []);
});

const PENDING = join(PLUGIN, "scripts", "pending.mjs");

test("list and the pending listing show a running job an older kit started as older kit, with (session open) while its recorded session runs, and a finished one by its status", async () => {
  const w = world();
  const session = await sleeper();
  const jobs = join(w.root, "plans", "jobs");
  try {
    v0224Job(w, { status: "running" });
    v0225Job(w, { name: "old-gone", status: "running" });
    v0225Job(w, { name: "old-open", status: "running", session: { pid: session.pid, start: session.start } });
    v0225Job(w, { name: "old-reused", status: "running", session: { pid: session.pid, start: `${session.start}9` } });
    v0225Job(w, { name: "old-finished", session: { pid: session.pid, start: session.start } });
    const out = w.run(["list"]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(out.stdout.trim().split("\n").map((line) => line.replace(/ · [^·]+ · \/.*$/, "")), [
      "dev · old finished · done",
      "dev · old gone · older kit",
      "dev · old open · older kit (session open)",
      "dev · old reused · older kit",
      "pm · old gaps · older kit",
    ]);
    const pending = spawnSync(process.execPath, [PENDING, "list", "--offline"], { cwd: w.root, encoding: "utf8", env: w.env() });
    assert.equal(pending.status, 0, pending.stderr);
    const listed = pending.stdout.match(/^Jobs:\n((?:- .*\n)+)/m)?.[1].trim().split("\n").map((line) => line.replace(/, [^,)]+\) \/.*$/, ")"));
    assert.deepEqual(listed, [
      "- dev: old finished (done)",
      "- dev: old gone (older kit)",
      "- dev: old open (older kit (session open))",
      "- dev: old reused (older kit)",
      "- pm: old gaps (older kit)",
    ]);
    assert.match(pending.stdout, new RegExp(`^- dev: old finished \\(done, \\d+d \\d+h\\) ${join(jobs, "261110-1000-dev-old-finished.md")}$`, "m"));
    writeFileSync(launchRecordPath(join(jobs, "261110-1000-dev-old-gone.md"), w.state), "{not json");
    const unread = spawnSync(process.execPath, [PENDING, "list", "--offline"], { cwd: w.root, encoding: "utf8", env: w.env() });
    assert.equal(unread.status, 0, unread.stderr);
    assert.match(unread.stdout, /^- dev: old gone \(running, /m);
    assert.match(unread.stdout, /^Could not check:\n(?:- .*\n)*- jobs: the launch record \S+ cannot be read /m);
  } finally {
    session.child.kill("SIGKILL");
    await session.exited;
  }
  assert.deepEqual(w.calls(), []);
});
