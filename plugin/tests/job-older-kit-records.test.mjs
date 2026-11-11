import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "../lib/handoff.mjs";
import { launchRecordPath, readJob } from "../lib/job-files.mjs";
import { processInfo } from "../lib/job-session-hooks.mjs";
import { sleeper, v0224Job, v0225Job, world } from "./job-world-for-tests.mjs";

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
      assert.equal(existsSync(launchRecordPath(file, w.state)), false, file);
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
    assert.equal(refused.stderr, `job: ${file}: the session an older kit recorded for this job (claude pid ${session.pid}) is still open; end that session first, then resume it again; nothing was resumed\n`);
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
