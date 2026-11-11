import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "../lib/handoff.mjs";
import { readJob } from "../lib/job-files.mjs";
import { v0224Job, v0225Job, world } from "./job-world-for-tests.mjs";

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
