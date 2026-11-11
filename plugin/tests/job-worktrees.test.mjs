import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "../lib/handoff.mjs";
import { JOB_KEYS, launchRecordPath, writeRecord } from "../lib/job-files.mjs";
import { linkedWorktree } from "../lib/job-worktrees.mjs";
import { bound, DEAD_PID, sleeper, v0225Job, world } from "./job-world-for-tests.mjs";

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t" };
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

test("a dev job with a repository gets a core worktree beside it, on a job branch from the map's integration branch, and its job file names that folder", () => {
  const w = gitWorld();
  const out = w.start([]);
  assert.equal(out.status, 0, out.stderr);
  const spec = JSON.parse(out.stdout);
  const tree = join(w.root, ".worktrees", "fe-add-hello");
  assert.equal(Object.hasOwn(spec, "cwd"), false);
  assert.equal(git(tree, "rev-parse", "--abbrev-ref", "HEAD"), "feat/add-hello");
  assert.equal(git(tree, "rev-parse", "HEAD"), git(w.fe, "rev-parse", "origin/main"));
  assert.ok(linkedWorktree(tree));
  assert.ok(!linkedWorktree(w.fe));
  const [file] = w.jobs();
  assert.deepEqual(w.header(file), { to: "tedy:dev", status: "running", cwd: tree, repo: w.fe, branch: "feat/add-hello", base: "main", worktree: tree, worktree_owner: "core" });
  const record = w.record(file);
  assert.deepEqual([record.cwd, record.repo, record.branch, record.base, record.worktree, record.worktree_owner], [tree, w.fe, "feat/add-hello", "main", tree, "core"]);
});

test("the worktree root, the branch and the integration branch follow the map and --branch, and a bad branch writes nothing", () => {
  const w = gitWorld({ worktree_root: "trees", repos: [{ path: "fe", role: "FE", branch: "dev" }] });
  git(w.seed, "push", "-q", "origin", "HEAD:dev");
  git(w.fe, "fetch", "-q", "origin");
  const out = w.start(["--branch", "fix/hello-copy"]);
  assert.equal(out.status, 0, out.stderr);
  const tree = join(w.root, "trees", "fe-add-hello");
  assert.equal(w.header(w.jobs()[0]).cwd, tree);
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

test("a core worktree starts from the integration branch as origin has it now, not as the repository last fetched it", () => {
  const w = gitWorld();
  writeFileSync(join(w.seed, "notes.txt"), "newer\n");
  git(w.seed, "commit", "-q", "-am", "newer");
  git(w.seed, "push", "-q", "origin", "HEAD:main");
  const tip = git(w.seed, "rev-parse", "HEAD");
  assert.notEqual(git(w.fe, "rev-parse", "origin/main"), tip);
  const out = w.start([]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(git(w.header(w.jobs()[0]).cwd, "rev-parse", "HEAD"), tip);
});

test("only a dev job with --repo gets a worktree", () => {
  const w = gitWorld();
  assert.equal(w.run(["start", "dev", "--title", "x", "--body-file", w.body]).status, 0);
  assert.equal(w.run(["start", "devops", "--title", "y", "--body-file", w.body, "--repo", "fe"]).status, 0);
  assert.equal(w.header(w.jobs().find((path) => path.includes("-dev-x"))).cwd, w.root);
  assert.equal(w.header(w.jobs().find((path) => path.includes("-devops-y"))).cwd, w.fe);
  assert.equal(existsSync(join(w.root, ".worktrees")), false);
});

test("resume trusts a worktree job by its recorded repository, keeps its worktree as the folder, and refuses once that folder is gone", () => {
  const w = gitWorld();
  w.start([]);
  const [file] = w.jobs();
  const tree = w.header(file).worktree;
  const done = join(w.root, "outcome.md");
  writeFileSync(done, "ok\n");
  assert.equal(w.run(["done", file, "--outcome-file", done]).status, 0);
  const note = join(w.root, "note.md");
  writeFileSync(note, "more\n");
  const out = w.run(["resume", file, "--note-file", note]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).tool, "Agent");
  assert.equal(w.header(file).cwd, tree);
  execFileSync("git", ["-C", w.fe, "worktree", "remove", tree]);
  const gone = w.run(["resume", file, "--note-file", note]);
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /its folder .* no longer exists; close it and start a new job/);
});

function pruneWorld() {
  const w = gitWorld();
  const make = (title, { status, record, edit } = {}) => {
    assert.equal(w.start(["--title", title]).status, 0);
    const file = w.jobs().find((path) => path.endsWith(`-dev-${title}.md`));
    const tree = w.header(file).worktree;
    if (status) writeFileSync(file, readFileSync(file, "utf8").replace("status: running", `status: ${status}`));
    if (record) writeRecord(launchRecordPath(file, w.state), { ...w.record(file), ...record });
    if (edit) edit(tree);
    return tree;
  };
  return { w, make };
}

const DAY = 86_400_000;

test("prune removes the core worktrees of closed jobs, of finished jobs whose branch is merged, and of jobs idle past the limit, and keeps the rest with the reason", () => {
  const { w, make } = pruneWorld();
  const closed = make("closed", { status: "closed" });
  const merged = make("merged", { status: "done" });
  const ignored = make("ignored", { status: "closed", edit: (tree) => writeFileSync(join(tree, "a.local.test.ts"), "x\n") });
  const idle = make("idle", { record: { session_id: "s-1", bound_at: "t", last_event_at: new Date(Date.now() - 11 * DAY).toISOString() } });
  const active = make("active");
  const dirty = make("dirty", { status: "closed", edit: (tree) => writeFileSync(join(tree, "new.txt"), "x\n") });
  const unpushed = make("unpushed", { status: "closed", edit: (tree) => { writeFileSync(join(tree, "notes.txt"), "changed\n"); git(tree, "commit", "-q", "-am", "local"); } });
  const ahead = make("ahead", { status: "done", edit: (tree) => { writeFileSync(join(tree, "notes.txt"), "pushed\n"); git(tree, "commit", "-q", "-am", "pushed"); git(tree, "push", "-q", "origin", "HEAD:refs/heads/feat/ahead"); } });
  const dry = w.run(["prune", "--dry-run"], { extra: IDENTITY });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`^would remove ${closed} \\(the job is closed\\)$`, "m"));
  for (const tree of [closed, merged, ignored, idle]) assert.ok(existsSync(tree), tree);
  const out = w.run(["prune"], { extra: IDENTITY });
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.trim().split("\n").sort();
  assert.deepEqual(lines, [
    `kept ${active}: the job is running and was active within 10 days`,
    `kept ${ahead}: the job is done, its branch is not merged into origin/main and it was active within 10 days`,
    `kept ${dirty}: it has uncommitted changes`,
    `kept ${unpushed}: it has 1 commit on no remote`,
    `removed ${closed} (the job is closed)`,
    `removed ${idle} (idle for 11 days)`,
    `kept ${ignored}: it holds ignored files that removing it would delete: a.local.test.ts`,
    `removed ${merged} (its branch is merged into origin/main)`,
  ].sort());
  for (const tree of [closed, merged, idle]) assert.ok(!existsSync(tree), tree);
  for (const tree of [active, ahead, dirty, unpushed, ignored]) assert.ok(existsSync(tree), tree);
  assert.equal(git(w.fe, "rev-parse", "--verify", "feat/unpushed").length > 0, true);
});

test("a core worktree holding an ignored local test file is kept with its path, and one whose ignored files all sit in regenerable folders is removed", () => {
  const { w, make } = pruneWorld();
  writeFileSync(join(w.fe, ".git", "info", "exclude"), "*.test.mjs\nnode_modules/\ndist/\n");
  const local = make("local", { status: "closed", edit: (tree) => { mkdirSync(join(tree, "tests")); writeFileSync(join(tree, "tests", "only-here.test.mjs"), "x\n"); mkdirSync(join(tree, "node_modules")); writeFileSync(join(tree, "node_modules", "x"), "x\n"); } });
  const built = make("built", { status: "closed", edit: (tree) => { mkdirSync(join(tree, "node_modules")); writeFileSync(join(tree, "node_modules", "x"), "x\n"); mkdirSync(join(tree, "dist")); writeFileSync(join(tree, "dist", "a.js"), "x\n"); } });
  const hidden = w.run(["prune", "--dry-run"], { extra: { ...IDENTITY, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "status.showUntrackedFiles", GIT_CONFIG_VALUE_0: "no" } });
  assert.deepEqual(hidden.stdout.trim().split("\n").sort(), [`kept ${local}: it holds ignored files that removing it would delete: tests/only-here.test.mjs`, `would remove ${built} (the job is closed)`].sort());
  const out = w.run(["prune"], { extra: IDENTITY });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.stdout.trim().split("\n").sort(), [`kept ${local}: it holds ignored files that removing it would delete: tests/only-here.test.mjs`, `removed ${built} (the job is closed)`].sort());
  assert.ok(existsSync(join(local, "tests", "only-here.test.mjs")));
  assert.ok(!existsSync(built));
});

test("a core worktree with a file flagged assume-unchanged or skip-worktree is kept with its paths, since git status hides an edit to it", () => {
  const { w, make } = pruneWorld();
  const flagged = (flags) => (tree) => {
    for (const flag of flags) git(tree, "update-index", flag, "notes.txt");
    writeFileSync(join(tree, "notes.txt"), "local only\n");
    assert.equal(git(tree, "status", "--porcelain"), "");
  };
  const assumed = make("assumed", { status: "closed", edit: flagged(["--assume-unchanged"]) });
  const skipped = make("skipped", { status: "closed", edit: flagged(["--skip-worktree"]) });
  const both = make("both", { status: "closed", edit: flagged(["--assume-unchanged", "--skip-worktree"]) });
  const clean = make("clean", { status: "closed" });
  const reason = (tree) => `kept ${tree}: it has files flagged assume-unchanged or skip-worktree, so git status hides their edits and removing it could lose them: notes.txt`;
  const out = w.run(["prune"], { extra: IDENTITY });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.stdout.trim().split("\n").sort(), [reason(assumed), reason(skipped), reason(both), `removed ${clean} (the job is closed)`].sort());
  for (const tree of [assumed, skipped, both]) assert.equal(readFileSync(join(tree, "notes.txt"), "utf8"), "local only\n");
});

test("an ignored file counts as regenerable only inside a whole top-level ignored folder with a regenerable name, so a tracked build folder, a nested build or out folder, or a regenerable name holding only ignored files keeps the tree", () => {
  const { w, make } = pruneWorld();
  const quiet = join(w.root, "no-excludes");
  writeFileSync(quiet, "");
  const env = { ...IDENTITY, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: quiet };
  mkdirSync(join(w.seed, "build"));
  writeFileSync(join(w.seed, "build", "webpack.config.js"), "x\n");
  git(w.seed, "add", "build");
  git(w.seed, "commit", "-q", "-m", "build config");
  git(w.seed, "push", "-q", "origin", "HEAD:main");
  writeFileSync(join(w.fe, ".git", "info", "exclude"), "*.local.test.js\n*.local.test.mjs\n*.local.md\nnode_modules/\ndist/\nbuild/\nout/\n");
  const put = (tree, path) => { mkdirSync(join(tree, path, ".."), { recursive: true }); writeFileSync(join(tree, path), "x\n"); };
  const tracked = make("tracked", { status: "closed", edit: (tree) => put(tree, "build/webpack.local.test.js") });
  const nested = make("nested", { status: "closed", edit: (tree) => { put(tree, "scripts/build/release.local.test.mjs"); put(tree, "src/out/notes.local.md"); put(tree, "pkg/dist/a.js"); } });
  const named = make("named", { status: "closed", edit: (tree) => put(tree, "target/only.local.test.js") });
  const whole = make("whole", { status: "closed", edit: (tree) => { put(tree, "node_modules/x/index.js"); put(tree, "dist/a.js"); } });
  const out = w.run(["prune"], { extra: env });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.stdout.trim().split("\n").sort(), [
    `kept ${tracked}: it holds ignored files that removing it would delete: build/webpack.local.test.js`,
    `kept ${nested}: it holds ignored files that removing it would delete: pkg/dist/, scripts/build/, src/out/`,
    `kept ${named}: it holds ignored files that removing it would delete: target/only.local.test.js`,
    `removed ${whole} (the job is closed)`,
  ].sort());
  for (const path of ["build/webpack.local.test.js"].map((rel) => join(tracked, rel)).concat(["scripts/build/release.local.test.mjs", "src/out/notes.local.md"].map((rel) => join(nested, rel)), join(named, "target/only.local.test.js"))) assert.ok(existsSync(path), path);
  assert.ok(!existsSync(whole));
});

test("close keeps a core worktree whose ignored file sits in a tracked build folder", () => {
  const { w, make } = pruneWorld();
  mkdirSync(join(w.seed, "build"));
  writeFileSync(join(w.seed, "build", "webpack.config.js"), "x\n");
  writeFileSync(join(w.seed, ".gitignore"), "*.local.test.ts\n*.local.test.js\n");
  git(w.seed, "add", ".");
  git(w.seed, "commit", "-q", "-m", "build config");
  git(w.seed, "push", "-q", "origin", "HEAD:main");
  const tree = make("vue", { status: "done", edit: (dir) => writeFileSync(join(dir, "build", "webpack.local.test.js"), "x\n") });
  const file = w.jobs().find((path) => path.endsWith("-dev-vue.md"));
  const out = w.run(["close", file], { extra: IDENTITY });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`^kept ${tree}: it holds ignored files that removing it would delete: build/webpack\\.local\\.test\\.js$`, "m"));
  assert.ok(existsSync(join(tree, "build", "webpack.local.test.js")));
});

test("prune --days moves the idle limit and refuses a bad value", () => {
  const { w, make } = pruneWorld();
  const idle = make("idle", { record: { session_id: "s-1", bound_at: "t", last_event_at: new Date(Date.now() - 11 * DAY).toISOString() } });
  assert.equal(w.run(["prune", "--days", "30"], { extra: IDENTITY }).stdout.trim(), `kept ${idle}: the job is running and was active within 30 days`);
  assert.match(w.run(["prune", "--days", "0"]).stderr, /--days needs a whole number of days above 0/);
});

test("close removes its own job's clean core worktree and keeps a dirty one with the reason", () => {
  const { w, make } = pruneWorld();
  const clean = make("clean", { status: "done" });
  const dirty = make("dirty", { status: "done", edit: (tree) => writeFileSync(join(tree, "new.txt"), "x\n") });
  const job = (title) => w.jobs().find((path) => path.endsWith(`-dev-${title}.md`));
  const closedClean = w.run(["close", job("clean")], { extra: IDENTITY });
  assert.equal(closedClean.status, 0, closedClean.stderr);
  assert.match(closedClean.stdout, new RegExp(`^removed ${clean} \\(the job is closed\\)$`, "m"));
  assert.ok(!existsSync(clean));
  const closedDirty = w.run(["close", job("dirty")], { extra: IDENTITY });
  assert.match(closedDirty.stdout, new RegExp(`^kept ${dirty}: it has uncommitted changes$`, "m"));
  assert.ok(existsSync(dirty));
  assert.equal(parse(readFileSync(job("dirty"), "utf8"), JOB_KEYS).status, "closed");
  assert.equal(existsSync(launchRecordPath(job("clean"), w.state)), false);
  const kept = w.record(job("dirty"));
  assert.deepEqual([kept.worktree, kept.session_id, kept.pid], [dirty, undefined, undefined]);
  rmSync(join(dirty, "new.txt"));
  assert.equal(w.run(["prune"], { extra: IDENTITY }).stdout.trim(), `removed ${dirty} (the job is closed)`);
  assert.ok(!existsSync(dirty));
  assert.equal(existsSync(launchRecordPath(job("dirty"), w.state)), false);
});

test("prune keeps the worktree of a job whose agent still runs in a live cockpit, even when its file says closed, and close refuses that job and keeps its tree", async () => {
  const { w, make } = pruneWorld();
  const live = await sleeper();
  try {
    const tree = make("live", { status: "closed", record: bound(live) });
    assert.match(w.run(["prune"], { extra: IDENTITY }).stdout.trim(), new RegExp(`^kept ${tree}: its agent dev-\\d{10}-live \\(a1b2c3\\) is running in cockpit session s-cockpit \\(claude pid ${live.pid}\\)$`));
    assert.ok(existsSync(tree));
    const busy = make("busy", { status: "done", record: bound(live, { state: "waiting: permission" }) });
    const file = w.jobs().find((path) => path.endsWith("-dev-busy.md"));
    const out = w.run(["close", file], { extra: IDENTITY });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /its agent dev-\d{10}-busy \(a1b2c3\) is waiting: permission in cockpit session s-cockpit/);
    assert.ok(existsSync(busy));
    writeRecord(launchRecordPath(file, w.state), { ...w.record(file), state: "idle" });
    const closed = w.run(["close", file], { extra: IDENTITY });
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(closed.stdout, `closed: ${file}\nremoved ${busy} (the job is closed)\n`);
  } finally {
    live.child.kill("SIGKILL");
  }
});

test("prune keeps the core worktree of a finished job whose agent is idle or stopped in a live cockpit, which SendMessage can still resume, and removes it once that cockpit has gone or the job is closed", async () => {
  const { w, make } = pruneWorld();
  const live = await sleeper();
  let idle;
  let stopped;
  try {
    idle = make("idle", { status: "done", record: bound(live, { state: "idle" }) });
    stopped = make("stopped", { status: "stopped", record: bound(live, { state: "stopped" }) });
    const closed = make("closed", { status: "closed", record: bound(live, { state: "idle" }) });
    const out = w.run(["prune"], { extra: IDENTITY });
    assert.equal(out.status, 0, out.stderr);
    const lines = out.stdout.trim().split("\n");
    for (const [tree, state] of [[idle, "idle"], [stopped, "stopped"]]) {
      assert.ok(lines.some((line) => new RegExp(`^kept ${tree}: its agent dev-\\d{10}-${state} \\(a1b2c3\\) is ${state} in cockpit session s-cockpit \\(claude pid ${live.pid}\\), which can still resume it with SendMessage$`).test(line)), out.stdout);
      assert.ok(existsSync(tree), tree);
    }
    assert.ok(lines.includes(`removed ${closed} (the job is closed)`), out.stdout);
  } finally {
    live.child.kill("SIGKILL");
  }
  await live.exited;
  const after = w.run(["prune"], { extra: IDENTITY });
  assert.equal(after.status, 0, after.stderr);
  for (const tree of [idle, stopped]) {
    assert.ok(after.stdout.includes(`removed ${tree} (its branch is merged into origin/main)`), after.stdout);
    assert.ok(!existsSync(tree), tree);
  }
});

test("prune keeps the worktree of every job close would refuse: not started while its cockpit runs, a bound agent with no cockpit pid, and an agent a resume set running", async () => {
  const { w, make } = pruneWorld();
  const live = await sleeper();
  try {
    const starting = make("starting", { status: "closed", record: { cockpit_pid: live.pid, cockpit_pid_start: live.start } });
    const unknown = make("unknown", { status: "closed", record: bound({}, { state: "idle" }) });
    const resumed = make("resumed", { status: "running", record: bound(live, { state: "running", last_event_at: new Date(Date.now() - 11 * DAY).toISOString() }) });
    const name = w.record(w.jobs().find((path) => path.endsWith("-dev-starting.md"))).agent_name;
    const out = w.run(["prune"], { extra: IDENTITY });
    assert.equal(out.status, 0, out.stderr);
    const lines = out.stdout.trim().split("\n");
    assert.ok(lines.includes(`kept ${starting}: its agent ${name} has made no tool call yet while the cockpit that started it (claude pid ${live.pid}) still runs, so it may be starting`), out.stdout);
    assert.ok(lines.includes(`kept ${unknown}: its launch record holds no cockpit claude pid, so the kit cannot tell whether its agent still runs`), out.stdout);
    assert.ok(lines.some((line) => line.startsWith(`kept ${resumed}: its agent dev-`) && line.endsWith(`(a1b2c3) is running in cockpit session s-cockpit (claude pid ${live.pid})`)), out.stdout);
    assert.equal(lines.length, 3, out.stdout);
    for (const tree of [starting, unknown, resumed]) assert.ok(existsSync(tree), tree);
  } finally {
    live.child.kill("SIGKILL");
  }
});

test("a git failure while close checks the worktree keeps the tree with the reason and its record without the agent, and still closes the job", () => {
  const { w, make } = pruneWorld();
  const tree = make("broken", { status: "done", record: bound({ pid: DEAD_PID, start: "1" }, { state: "idle" }) });
  const file = w.jobs().find((path) => path.endsWith("-dev-broken.md"));
  writeFileSync(join(git(tree, "rev-parse", "--absolute-git-dir"), "index"), "not an index");
  const out = w.run(["close", file], { extra: IDENTITY });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`^closed: ${file}\\nkept ${tree}: git ls-files -v -z failed in ${tree}: .+$`, "m"));
  assert.ok(existsSync(tree));
  assert.equal(parse(readFileSync(file, "utf8"), JOB_KEYS).status, "closed");
  const kept = w.record(file);
  assert.deepEqual([kept.worktree, kept.agent_id, kept.session_id, kept.cockpit_pid, kept.state], [tree, undefined, undefined, undefined, undefined]);
});

test("close run from inside the job's own worktree keeps that worktree and its record, and says so", () => {
  const { w, make } = pruneWorld();
  const tree = make("inside", { status: "done" });
  const file = w.jobs().find((path) => path.endsWith("-dev-inside.md"));
  mkdirSync(join(tree, "sub"));
  const out = w.run(["close", file], { extra: IDENTITY, cwd: join(tree, "sub") });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`^kept ${tree}: this command runs inside it; run job\\.mjs prune from elsewhere to remove it$`, "m"));
  assert.ok(existsSync(tree));
  assert.equal(parse(readFileSync(file, "utf8"), JOB_KEYS).status, "closed");
  assert.equal(w.record(file).worktree, tree);
});

test("close and prune remove a core worktree only when it is a registered worktree of the recorded repository on the recorded branch", () => {
  const { w, make } = pruneWorld();
  const job = (title) => w.jobs().find((path) => path.endsWith(`-dev-${title}.md`));
  const other = join(w.root, "other");
  git(w.root, "clone", "-q", w.origin, other);
  const foreign = join(w.root, "foreign-tree");
  git(other, "worktree", "add", "-q", "-b", "feat/foreign", foreign, "origin/main");
  const sibling = join(w.root, "sibling-tree");
  git(w.fe, "worktree", "add", "-q", "-b", "feat/sibling", sibling, "origin/main");
  const own = make("own", { status: "done" });
  make("elsewhere", { status: "done", record: { worktree: foreign } });
  make("branch", { status: "closed", record: { worktree: sibling } });
  const closed = w.run(["close", job("elsewhere")], { extra: IDENTITY });
  assert.equal(closed.status, 0, closed.stderr);
  assert.match(closed.stdout, new RegExp(`^kept ${foreign}: it is not a worktree of ${w.fe} on feat/elsewhere$`, "m"));
  const pruned = w.run(["prune"], { extra: IDENTITY });
  assert.match(pruned.stdout, new RegExp(`^kept ${sibling}: it is not a worktree of ${w.fe} on feat/branch$`, "m"));
  assert.match(pruned.stdout, new RegExp(`^removed ${own} \\(its branch is merged into origin/main\\)$`, "m"));
  for (const tree of [foreign, sibling]) assert.ok(existsSync(tree), tree);
  assert.ok(!existsSync(own));
});

test("close and prune remove the worktree, and judge the branch and base, that the launch record holds, so an edited job file header changes nothing they remove", () => {
  const { w, make } = pruneWorld();
  const other = join(w.root, "users-own-tree");
  git(w.fe, "worktree", "add", "-q", "-b", "feat/users-own", other, "origin/main");
  const job = (title) => w.jobs().find((path) => path.endsWith(`-dev-${title}.md`));
  const point = (title, edits) => writeFileSync(job(title), Object.entries(edits).reduce((text, [key, value]) => text.replace(new RegExp(`^${key}: .*$`, "m"), `${key}: ${value}`), readFileSync(job(title), "utf8")));
  const closing = make("closing", { status: "done" });
  point("closing", { worktree: other });
  const closed = w.run(["close", job("closing")], { extra: IDENTITY });
  assert.equal(closed.status, 0, closed.stderr);
  assert.match(closed.stdout, new RegExp(`^removed ${closing} \\(the job is closed\\)$`, "m"));
  const pruned = make("pruned", { status: "closed" });
  point("pruned", { worktree: other, worktree_owner: "t3" });
  const ahead = make("ahead", { status: "done", edit: (tree) => { writeFileSync(join(tree, "notes.txt"), "pushed\n"); git(tree, "commit", "-q", "-am", "pushed"); git(tree, "push", "-q", "origin", "HEAD:refs/heads/feat/ahead"); } });
  point("ahead", { branch: "main" });
  const out = w.run(["prune"], { extra: IDENTITY });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.stdout.trim().split("\n").sort(), [`kept ${ahead}: the job is done, its branch is not merged into origin/main and it was active within 10 days`, `removed ${pruned} (the job is closed)`].sort());
  assert.ok(existsSync(other));
  for (const tree of [closing, pruned]) assert.ok(!existsSync(tree), tree);
});

test("close removes a clean core worktree whose git ls-files output passes 1 MiB", () => {
  const { w, make } = pruneWorld();
  const deep = join(w.seed, ...Array.from({ length: 4 }, () => "d".repeat(200)));
  mkdirSync(deep, { recursive: true });
  for (let n = 0; n < 1500; n += 1) writeFileSync(join(deep, `f${n}.txt`), "x\n");
  git(w.seed, "add", ".");
  git(w.seed, "commit", "-q", "-m", "many files");
  git(w.seed, "push", "-q", "origin", "HEAD:main");
  const tree = make("large", { status: "done" });
  assert.ok(execFileSync("git", ["-C", tree, "ls-files", "-v", "-z"], { maxBuffer: 1 << 26 }).length > 1 << 20);
  const out = w.run(["close", w.jobs().find((path) => path.endsWith("-dev-large.md"))], { extra: IDENTITY });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`^removed ${tree} \\(the job is closed\\)$`, "m"));
  assert.ok(!existsSync(tree));
});


test("close of a dev job v0.2.25 started with a core worktree removes that tree only through the prune checks, and keeps a dirty one with the reason", () => {
  const w = gitWorld();
  const tree = (name) => {
    const path = join(w.root, ".worktrees", `fe-${name}`);
    git(w.fe, "worktree", "add", "-q", "--no-track", "-b", `feat/${name}`, path, "origin/main");
    return path;
  };
  const clean = tree("old-clean");
  const dirty = tree("old-dirty");
  writeFileSync(join(dirty, "new.txt"), "x\n");
  const files = [v0225Job(w, { name: "old-clean", tree: clean, branch: "feat/old-clean" }), v0225Job(w, { name: "old-dirty", tree: dirty, branch: "feat/old-dirty" })];
  const [removed, kept] = files.map((file) => w.run(["close", file], { extra: IDENTITY }));
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, new RegExp(`^removed ${clean} \\(the job is closed\\)$`, "m"));
  assert.ok(!existsSync(clean));
  assert.equal(existsSync(launchRecordPath(files[0], w.state)), false);
  assert.match(kept.stdout, new RegExp(`^kept ${dirty}: it has uncommitted changes$`, "m"));
  assert.ok(existsSync(dirty));
  assert.equal(w.record(files[1]).worktree, dirty);
  for (const file of files) assert.equal(parse(readFileSync(file, "utf8"), JOB_KEYS).status, "closed");
});

test("close and prune keep the core worktree of a job v0.2.25 started while the session it recorded is still open, and prune removes it once that session ends", async () => {
  const w = gitWorld();
  const tree = join(w.root, ".worktrees", "fe-old-open");
  git(w.fe, "worktree", "add", "-q", "--no-track", "-b", "feat/old-open", tree, "origin/main");
  const session = await sleeper();
  const file = v0225Job(w, { name: "old-open", tree, branch: "feat/old-open", session: { pid: session.pid, start: session.start } });
  const open = `kept ${tree}: the session an older kit recorded for this job (claude pid ${session.pid}) is still open`;
  try {
    const out = w.run(["close", file], { extra: IDENTITY });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`^${open.replace(/[()]/g, "\\$&")}$`, "m"));
    assert.equal(parse(readFileSync(file, "utf8"), JOB_KEYS).status, "closed");
    assert.equal(w.run(["prune"], { extra: IDENTITY }).stdout.trim(), open);
    assert.ok(existsSync(tree));
  } finally {
    session.child.kill("SIGKILL");
    await session.exited;
  }
  assert.equal(w.run(["prune"], { extra: IDENTITY }).stdout.trim(), `removed ${tree} (the job is closed)`);
  assert.ok(!existsSync(tree));
});
