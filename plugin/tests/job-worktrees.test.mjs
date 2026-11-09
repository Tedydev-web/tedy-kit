import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "../lib/handoff.mjs";
import { JOB_KEYS, launchRecordPath, writeRecord } from "../lib/job-files.mjs";
import { linkedWorktree } from "../lib/job-worktrees.mjs";
import { tokenize } from "../lib/shell-segments.mjs";
import { world } from "./job-world-for-tests.mjs";

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const HEADER = ["to", "status", "cwd", "repo", "branch", "base", "worktree", "worktree_owner"];

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...IDENTITY }, stdio: ["ignore", "pipe", "pipe"] }).trim();

function gitWorld(mapExtra = {}) {
  const w = world({ jobs: true, ...mapExtra });
  const origin = join(w.root, "origin.git");
  git(w.root, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(w.root, "seed");
  git(w.root, "clone", "-q", origin, seed);
  writeFileSync(join(seed, ".gitignore"), "*.local.test.ts\n");
  writeFileSync(join(seed, "notes.txt"), "hi\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(w.root, "clone", "-q", origin, join(w.root, "fe"));
  const start = (args, extra) => w.run(["start", "dev", "--title", "Add hello", "--body-file", w.body, "--repo", "fe", ...args], { extra: { ...IDENTITY, ...extra } });
  const header = (file) => { const all = parse(readFileSync(file, "utf8"), JOB_KEYS); return Object.fromEntries(HEADER.filter((key) => all[key] !== undefined).map((key) => [key, all[key]])); };
  return { ...w, origin, seed, fe: join(w.root, "fe"), start, header };
}

test("a dev job started by print gets a core worktree beside its repository, on a job branch from the map's integration branch, and runs there", () => {
  const w = gitWorld();
  const out = w.start(["--json"]);
  assert.equal(out.status, 0, out.stderr);
  const spec = JSON.parse(out.stdout);
  const tree = join(w.root, ".worktrees", "fe-add-hello");
  assert.equal(spec.cwd, tree);
  assert.deepEqual(tokenize(spec.command).slice(0, 2), ["cd", tree]);
  assert.equal(git(tree, "rev-parse", "--abbrev-ref", "HEAD"), "feat/add-hello");
  assert.equal(git(tree, "rev-parse", "HEAD"), git(w.fe, "rev-parse", "origin/main"));
  assert.ok(linkedWorktree(tree));
  assert.ok(!linkedWorktree(w.fe));
  const [file] = w.jobs();
  assert.deepEqual(w.header(file), { to: "tedy:dev", status: "running", cwd: tree, repo: w.fe, branch: "feat/add-hello", base: "main", worktree: tree, worktree_owner: "core" });
  assert.deepEqual([w.record(file).cwd, w.record(file).repo], [tree, w.fe]);
});

test("the worktree root, the branch and the integration branch follow the map and --branch, and a bad branch writes nothing", () => {
  const w = gitWorld({ worktree_root: "trees", repos: [{ path: "fe", role: "FE", branch: "dev" }] });
  git(w.seed, "push", "-q", "origin", "HEAD:dev");
  git(w.fe, "fetch", "-q", "origin");
  const out = w.start(["--branch", "fix/hello-copy", "--json"]);
  assert.equal(out.status, 0, out.stderr);
  const tree = join(w.root, "trees", "fe-add-hello");
  assert.equal(JSON.parse(out.stdout).cwd, tree);
  assert.equal(git(tree, "rev-parse", "--abbrev-ref", "HEAD"), "fix/hello-copy");
  assert.equal(w.header(w.jobs()[0]).base, "dev");
  const bad = w.start(["--branch", "bad..name"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--branch bad\.\.name is not a valid branch name/);
  const taken = w.start(["--branch", "fix/hello-copy"]);
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, /git worktree add failed: .*fix\/hello-copy/);
  assert.equal(w.jobs().length, 1);
});

test("only a dev job with --repo gets a worktree", () => {
  const w = gitWorld();
  assert.equal(JSON.parse(w.run(["start", "dev", "--title", "x", "--body-file", w.body, "--json"]).stdout).cwd, w.root);
  assert.equal(JSON.parse(w.run(["start", "devops", "--title", "y", "--body-file", w.body, "--repo", "fe", "--json"]).stdout).cwd, w.fe);
  assert.equal(existsSync(join(w.root, ".worktrees")), false);
});

test("a dev job started in T3 hands the worktree to T3 through workspaceStrategy and makes none itself", () => {
  const w = gitWorld();
  const out = w.start(["--t3", "--json"]);
  assert.equal(out.status, 0, out.stderr);
  const spec = JSON.parse(out.stdout);
  assert.equal(spec.cwd, w.fe);
  assert.deepEqual(spec.t3.workspaceStrategy, { type: "worktree", baseRef: "origin/main", branch: "feat/add-hello", startFromOrigin: true });
  assert.equal(existsSync(join(w.root, ".worktrees")), false);
  const header = w.header(w.jobs()[0]);
  assert.deepEqual([header.worktree_owner, header.branch, header.base, header.worktree], ["t3", "feat/add-hello", "main", undefined]);
});

test("a dev job inside herdr gets its worktree and pane from herdr worktree create, and falls back to a core worktree when that fails", () => {
  const w = gitWorld();
  const herdrTree = join(w.root, "herdr-trees", "fe-add-hello");
  const out = w.start(["--json"], { HERDR_ENV: "1", FAKE_HERDR_WORKTREE: herdrTree });
  assert.equal(out.status, 0, out.stderr);
  const spec = JSON.parse(out.stdout);
  const [create, start] = w.herdrCalls();
  assert.deepEqual(create, ["worktree", "create", "--cwd", w.fe, "--branch", "feat/add-hello", "--base", "origin/main", "--label", "dev acme-shop add-hello", "--no-focus"]);
  assert.deepEqual(start.slice(0, 7), ["agent", "start", spec.herdr.name, "--kind", "claude", "--pane", "w1:p8"]);
  assert.equal(spec.cwd, herdrTree);
  const header = w.header(w.jobs()[0]);
  assert.deepEqual([header.worktree_owner, header.worktree, header.cwd], ["herdr", herdrTree, herdrTree]);
  const fallback = w.run(["start", "dev", "--title", "Other", "--body-file", w.body, "--repo", "fe", "--json"], { extra: { ...IDENTITY, HERDR_ENV: "1", FAKE_HERDR_FAIL: "worktree create:not_a_repository" } });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stderr, /^warning: herdr worktree create failed \(not_a_repository: fake failure\); run the command below in any terminal/m);
  assert.equal(JSON.parse(fallback.stdout).cwd, join(w.root, ".worktrees", "fe-other"));
  assert.ok(linkedWorktree(join(w.root, ".worktrees", "fe-other")));
});

test("resume trusts a worktree job by its recorded repository and runs in its worktree", () => {
  const w = gitWorld();
  w.start([]);
  const [file] = w.jobs();
  const tree = w.header(file).worktree;
  const done = join(w.root, "outcome.md");
  writeFileSync(done, "ok\n");
  assert.equal(w.run(["done", file, "--outcome-file", done]).status, 0);
  writeRecord(launchRecordPath(file, w.state), { ...w.record(file), session_id: "s-1", bound_at: "t" });
  const note = join(w.root, "note.md");
  writeFileSync(note, "more\n");
  const out = w.run(["resume", file, "--note-file", note, "--json"]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).cwd, tree);
  execFileSync("git", ["-C", w.fe, "worktree", "remove", tree]);
  writeRecord(launchRecordPath(file, w.state), { ...w.record(file), session_id: "s-2", bound_at: "t" });
  const gone = w.run(["resume", file, "--note-file", note]);
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /its folder .* no longer exists; close it and start a new job/);
});
