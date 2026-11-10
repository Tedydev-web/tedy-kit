import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { launchRecordPath, recordLaunch } from "../lib/job-files.mjs";
import { tokenize } from "../lib/shell-segments.mjs";
import { DEAD_PID, jobFile, PLUGIN, sleeper, world } from "./job-world-for-tests.mjs";

const inHerdr = (w, extra = {}) => ({ extra: { HERDR_ENV: "1", ...extra } });
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;

test("with no --t3 and HERDR_ENV unset the print adapter is chosen and nothing but the command is printed", () => {
  const w = world();
  const spec = JSON.parse(w.run(["start", "pm", "--title", "Gaps", "--body-file", w.body, "--json"]).stdout);
  assert.equal(spec.via, "print");
  assert.equal(spec.t3, undefined);
  assert.equal(spec.herdr, undefined);
  assert.deepEqual(w.herdrCalls(), []);
  assert.deepEqual(w.calls(), []);
});

test("--t3 picks the t3 adapter over herdr, and its spec names the role's T3 instance, the title and the prompt as the thread's first message", () => {
  const w = world();
  const out = w.run(["start", "review", "--title", "Review 12", "--body-file", w.body, "--t3", "--json"], inHerdr(w));
  assert.equal(out.status, 0, out.stderr);
  const spec = JSON.parse(out.stdout);
  assert.equal(spec.via, "t3");
  assert.deepEqual(spec.t3, { instanceId: "tedy-review", title: "review acme-shop review-12", message: spec.prompt });
  assert.ok(spec.command.startsWith(`cd '${w.root}' && claude --agent tedy:review`));
  assert.deepEqual(w.herdrCalls(), []);
  const plain = w.run(["start", "review", "--title", "Review 13", "--body-file", w.body, "--t3"]);
  assert.equal(plain.stdout.trim().split("\n").length, 1);
  assert.match(plain.stdout, /^cd '/);
});

test("--via overrides detection, and a forced adapter that cannot run is an error naming why, with no job file written", () => {
  const w = world();
  assert.equal(JSON.parse(w.run(["start", "pm", "--title", "a", "--body-file", w.body, "--via", "print", "--json"], inHerdr(w)).stdout).via, "print");
  assert.deepEqual(w.herdrCalls(), []);
  const before = w.jobs().length;
  const cases = [
    [["--via", "t3"], {}, /--via t3 needs --t3, which the cockpit passes when its tools list t3_thread_launch/],
    [["--via", "herdr"], {}, /--via herdr cannot run: HERDR_ENV is not 1, so this session does not run inside herdr/],
    [["--via", "herdr"], { HERDR_ENV: "1", PATH: join(w.root, "nowhere") }, /--via herdr cannot run: herdr is not on PATH/],
    [["--via", "tmux"], {}, /--via tmux is not an adapter; use t3, herdr or print/],
  ];
  for (const [args, extra, message] of cases) {
    const out = w.run(["start", "pm", "--title", "b", "--body-file", w.body, ...args], { extra });
    assert.equal(out.status, 1, args.join(" "));
    assert.match(out.stderr, message);
  }
  assert.equal(w.jobs().length, before);
});

test("t3-instance without --write prints the instance name, the Launch arguments with the absolute settings file and the env lines, and leaves T3's settings alone", () => {
  const w = world();
  const out = w.run(["t3-instance", "dev"], { extra: { TEDY_JOB_PLUGIN_DIR: "/opt/kit/plugin" } });
  assert.equal(out.status, 0, out.stderr);
  const settings = join(w.state, "jobs", "settings", "dev.json");
  assert.equal(out.stdout, [
    "Instance name: tedy-dev",
    `Launch arguments: --agent tedy:dev --settings ${settings} --plugin-dir /opt/kit/plugin`,
    "Environment:",
    `TEDY_STATE_DIR=${w.state}`,
    `TEDY_PROFILE_DIR=${w.profile}`,
    "",
  ].join("\n"));
  assert.ok(JSON.parse(readFileSync(settings, "utf8")).permissions.allow.includes("Edit"));
  assert.match(w.run(["t3-instance", "qa"]).stderr, /unknown role qa/);
  assert.equal(existsSync(dirname(w.t3Settings)), false);
});

const T3_TEXT = `${JSON.stringify({ storageCleanup: { worktreeAfterDays: 10 }, providerInstances: { codex: { driver: "codex", displayName: "Codex", enabled: true, environment: [{ name: "A", value: "1" }] } }, worktreesDir: "/w", theme: null }, null, 2)}\n`;

function t3World(text = T3_TEXT) {
  const w = world();
  mkdirSync(dirname(w.t3Settings), { recursive: true });
  writeFileSync(w.t3Settings, text);
  const backups = () => readdirSync(dirname(w.t3Settings)).filter((name) => name.startsWith("settings.json.bak-")).sort();
  return { ...w, backups, t3: () => JSON.parse(readFileSync(w.t3Settings, "utf8")) };
}

const instance = (role, settings, extra = "") => ({ driver: "claudeAgent", displayName: `tedy ${role}`, enabled: true, config: { launchArgs: `--agent tedy:${role} --settings ${settings}${extra}` } });

test("t3-instance --write backs up T3's settings and upserts the role's instance, keeping every other key and the file's key order", () => {
  const w = t3World();
  const out = w.run(["t3-instance", "pm", "--write"], { extra: { TEDY_JOB_PLUGIN_DIR: "/opt/kit/plugin" } });
  assert.equal(out.status, 0, out.stderr);
  const settings = join(w.state, "jobs", "settings", "pm.json");
  const [backup] = w.backups();
  assert.match(backup, /^settings\.json\.bak-\d{6}-\d{4}-tedy$/);
  assert.equal(readFileSync(join(dirname(w.t3Settings), backup), "utf8"), T3_TEXT);
  const before = JSON.parse(T3_TEXT);
  const after = w.t3();
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.deepEqual({ ...after, providerInstances: null }, { ...before, providerInstances: null });
  assert.deepEqual(after.providerInstances, { ...before.providerInstances, "tedy-pm": instance("pm", settings, " --plugin-dir /opt/kit/plugin") });
  assert.equal(out.stdout, [`backed up ${w.t3Settings} to ${join(dirname(w.t3Settings), backup)}`, `tedy-pm: added (Launch arguments: --agent tedy:pm --settings ${settings} --plugin-dir /opt/kit/plugin)`, `wrote ${w.t3Settings}; T3 Code loads it without a restart`, ""].join("\n"));
  assert.ok(readFileSync(w.t3Settings, "utf8").endsWith("}\n"));
});

test("t3-instance --write again changes nothing and makes no backup, and --all upserts the four role instances in one write", () => {
  const w = t3World();
  assert.equal(w.run(["t3-instance", "dev", "--write"]).status, 0);
  const written = readFileSync(w.t3Settings, "utf8");
  const again = w.run(["t3-instance", "dev", "--write"]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^tedy-dev: unchanged \(Launch arguments: --agent tedy:dev --settings .*\)\n.* already holds these instances; nothing was written\n$/);
  assert.equal(readFileSync(w.t3Settings, "utf8"), written);
  assert.equal(w.backups().length, 1);
  const all = w.run(["t3-instance", "--all", "--write"], { extra: { TEDY_JOB_PLUGIN_DIR: "/opt/kit/plugin" } });
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(all.stdout.split("\n").filter((line) => line.startsWith("tedy-")).map((line) => line.split(" (")[0]), ["tedy-pm: added", "tedy-dev: updated", "tedy-review: added", "tedy-devops: added"]);
  assert.deepEqual(Object.keys(w.t3().providerInstances), ["codex", "tedy-dev", "tedy-pm", "tedy-review", "tedy-devops"]);
  for (const role of ["pm", "dev", "review", "devops"]) assert.deepEqual(w.t3().providerInstances[`tedy-${role}`], instance(role, join(w.state, "jobs", "settings", `${role}.json`), " --plugin-dir /opt/kit/plugin"));
  assert.equal(w.backups().length, 2);
  assert.match(w.run(["t3-instance", "--all", "pm", "--write"]).stderr, /usage: job\.mjs/);
});

test("t3-instance --write merges into an existing role instance, setting only its driver, enabled and Launch arguments, and keeps the file's mode", () => {
  const mine = { driver: "claudeAgent", displayName: "my pm", enabled: false, environment: [{ name: "B", value: "2" }], config: { launchArgs: "--old", model: "x" } };
  const w = t3World(`${JSON.stringify({ providerInstances: { "tedy-pm": mine } }, null, 2)}\n`);
  chmodSync(w.t3Settings, 0o600);
  const out = w.run(["t3-instance", "pm", "--write"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^tedy-pm: updated /m);
  const launchArgs = `--agent tedy:pm --settings ${join(w.state, "jobs", "settings", "pm.json")}`;
  assert.deepEqual(w.t3().providerInstances["tedy-pm"], { ...mine, enabled: true, config: { launchArgs, model: "x" } });
  assert.equal(statSync(w.t3Settings).mode & 0o777, 0o600);
  assert.match(w.run(["t3-instance", "pm", "--write"]).stdout, /^tedy-pm: unchanged /m);
  assert.equal(w.backups().length, 1);
});

test("t3-instance --write refuses a T3 settings file it does not recognise and writes nothing", () => {
  for (const [text, message] of [
    ["{ not json", /is not JSON .*; T3's settings format may have changed, so nothing was written/],
    ["[]\n", /has no providerInstances object; T3's settings format may have changed, so nothing was written/],
    ['{"providerInstances":[]}\n', /has no providerInstances object/],
    ['{"providerInstances":null}\n', /has no providerInstances object/],
    ['{"theme":"dark"}\n', /has no providerInstances object/],
  ]) {
    const w = t3World(text);
    const out = w.run(["t3-instance", "review", "--write"]);
    assert.equal(out.status, 1, text);
    assert.match(out.stderr, message);
    assert.equal(readFileSync(w.t3Settings, "utf8"), text);
    assert.deepEqual(w.backups(), []);
  }
  const w = world();
  const missing = w.run(["t3-instance", "pm", "--write"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /does not exist, so T3 Code is not set up here; nothing was written/);
  assert.equal(existsSync(dirname(w.t3Settings)), false);
  const spaced = t3World();
  const out = spaced.run(["t3-instance", "pm", "--write"], { extra: { TEDY_JOB_PLUGIN_DIR: "/opt/my kit" } });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /holds a space/);
  assert.equal(readFileSync(spaced.t3Settings, "utf8"), T3_TEXT);
});

test("inside herdr, start opens a tab in the job's folder and starts claude there as a named herdr agent with the role, settings and prompt as separate arguments", () => {
  const w = world();
  const out = w.run(["start", "review", "--title", "Review 12", "--body-file", w.body, "--json"], inHerdr(w, { HERDR_WORKSPACE_ID: "w1" }));
  assert.equal(out.status, 0, out.stderr);
  const spec = JSON.parse(out.stdout);
  const [file] = w.jobs();
  const settings = join(w.state, "jobs", "settings", "review.json");
  assert.equal(spec.via, "herdr");
  assert.match(spec.herdr.name, /^review-[0-9a-f]{6}$/);
  assert.match(spec.herdr.name, NAME);
  assert.equal(spec.herdr.pane, "w1:p7");
  const [tab, start, ...rest] = w.herdrCalls();
  assert.deepEqual(rest, []);
  assert.deepEqual(tab, ["tab", "create", "--workspace", "w1", "--cwd", w.root, "--label", "review acme-shop review-12", "--no-focus"]);
  assert.deepEqual(start, ["agent", "start", spec.herdr.name, "--kind", "claude", "--pane", "w1:p7", "--", "--agent", "tedy:review", "--settings", settings, spec.prompt]);
  assert.ok(spec.prompt.includes(file));
  assert.deepEqual(w.record(file).herdr, { name: spec.herdr.name, pane: "w1:p7" });
  assert.equal(w.record(file).via, "herdr");
  const plain = w.run(["start", "pm", "--title", "Gaps", "--body-file", w.body], inHerdr(w));
  assert.match(plain.stdout.trim(), /^herdr agent pm-[0-9a-f]{6} started in pane w1:p7$/);
  assert.equal(w.herdrCalls()[2].includes("--workspace"), false);
  assert.deepEqual(w.calls(), []);
});

test("a herdr agent blocked at startup keeps its pane; a failed herdr call falls back to the printed command with a warning", () => {
  const w = world();
  const blocked = w.run(["start", "dev", "--title", "a", "--body-file", w.body, "--json"], inHerdr(w, { FAKE_HERDR_FAIL: "agent start:agent_not_ready" }));
  assert.equal(blocked.status, 0, blocked.stderr);
  const spec = JSON.parse(blocked.stdout);
  assert.equal(spec.via, "herdr");
  assert.match(blocked.stderr, new RegExp(`^warning: herdr agent ${spec.herdr.name} waits at a prompt in pane w1:p7 \\(agent_not_ready\\); answer it there`, "m"));
  for (const fail of ["agent start:agent_kind_unavailable", "tab create:workspace_not_found"]) {
    const out = w.run(["start", "dev", "--title", fail.split(":")[1], "--body-file", w.body], inHerdr(w, { FAKE_HERDR_FAIL: fail }));
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stderr, new RegExp(`^warning: herdr ${fail.split(":")[0]} failed \\(${fail.split(":")[1]}: fake failure\\); run the command below in any terminal`, "m"));
    assert.match(out.stdout.trim(), /^cd '.*' && claude --agent tedy:dev /);
  }
  const files = w.jobs().sort();
  assert.equal(files.length, 3);
  assert.deepEqual(files.map((file) => w.record(file).via).sort(), ["herdr", "print", "print"]);
  const forced = w.run(["start", "dev", "--title", "c", "--body-file", w.body, "--via", "herdr"], inHerdr(w, { FAKE_HERDR_FAIL: "tab create:workspace_not_found" }));
  assert.equal(forced.status, 1);
  assert.match(forced.stderr, /^job: herdr tab create failed \(workspace_not_found: fake failure\)/m);
  assert.equal(w.jobs().length, 3);
});

test("list adds herdr's state for a job herdr runs, unless the kit's own record says it waits", async () => {
  const w = world();
  const session = await sleeper();
  try {
    const live = { pid: session.pid, pid_start: session.start };
    jobFile(w, { name: "working", record: { session_id: "s-1", bound_at: "t", ...live, state: "running", herdr: { name: "dev-abc123", pane: "w1:p7" } } });
    jobFile(w, { name: "asking", record: { session_id: "s-2", bound_at: "t", ...live, state: "waiting: question", herdr: { name: "dev-def456", pane: "w1:p8" } } });
    jobFile(w, { name: "plain", record: { session_id: "s-3", bound_at: "t", ...live, state: "idle" } });
    const lines = (extra) => w.run(["list"], { extra }).stdout.trim().split("\n").map((line) => line.split(" · ").slice(1, 3).join(" · ")).sort();
    assert.deepEqual(lines({ FAKE_HERDR_STATUS: "blocked" }), ["asking · waiting: question", "plain · idle", "working · running (herdr: blocked)"]);
    assert.deepEqual(w.herdrCalls(), [["agent", "get", "dev-abc123"]]);
    assert.deepEqual(lines({}), ["asking · waiting: question", "plain · idle", "working · running (herdr: agent_not_found)"]);
  } finally {
    session.child.kill("SIGKILL");
  }
});

test("the docs describe each adapter and the worktree owners, and no doc still sends jobs to --bg or agent view", () => {
  const read = (path) => readFileSync(join(PLUGIN, "..", path), "utf8");
  const jobs = read("plugin/shared/jobs.md");
  for (const phrase of ["t3_thread_launch", "job.mjs t3-instance", "--via", "--t3", "herdr agent start", "herdr worktree create", "workspaceStrategy", "job.mjs prune", "orchestrator_capabilities"]) assert.ok(jobs.includes(phrase), `jobs.md lacks ${phrase}`);
  const readme = read("README.md");
  for (const phrase of ["job.mjs t3-instance", "--via", "job.mjs prune", "herdr"]) assert.ok(readme.includes(phrase), `README lacks ${phrase}`);
  const setup = read("plugin/shared/setup-flow.md");
  for (const [name, text] of [["jobs.md", jobs], ["README", readme], ["setup-flow.md", setup]]) {
    assert.ok(text.includes("job.mjs t3-instance --all --write"), `${name} lacks the T3 instance write`);
    assert.ok(!/never writes T3 config/.test(text), `${name} still says the kit never writes T3 config`);
  }
  for (const text of [jobs, setup]) assert.match(text, /`t3\.header`[\s\S]*`t3\.write`[\s\S]*~\/\.t3\/userdata\/settings\.json[\s\S]*`orchestrator_capabilities`/);
  assert.ok(read("plugin/skills/dev/SKILL.md").includes("A job: `jobs.md` Job 5."), "the dev skill does not point a job at its worktree rule");
  assert.ok(jobs.includes("git rev-parse --path-format=absolute --git-dir --git-common-dir"), "jobs.md lacks the linked-worktree check");
  assert.match(jobs, /`worktree_owner: t3` or `herdr`[^.]*push the branch with `git push -u origin <branch>` right after the first commit/);
  assert.ok(read("plugin/shared/project-map-schema.md").includes("`worktree_root`"));
  for (const path of ["plugin/skills/review-pr/references/checkout.md", "plugin/shared/decision-points.md", "docs/canon/surface-fit.json"]) {
    const text = read(path);
    for (const word of ["--bg", "agent view", "bgIsolation"]) assert.ok(!text.includes(word), `${path} still has ${word}`);
  }
});

test("every role may run the linked-worktree check", async () => {
  const { allowRules } = await import("../lib/job.mjs");
  for (const role of ["pm", "dev", "review", "devops"]) {
    const rules = allowRules(role, { plugin: "/k/plugin", root: "/w/shop", profile: "/p/tedy" });
    assert.ok(rules.includes("Bash(git rev-parse --path-format=absolute --git-dir --git-common-dir)"), role);
  }
  assert.ok(allowRules("dev", { plugin: "/k/plugin", root: "/w/shop", profile: "/p/tedy" }).includes("Bash(git -C * rev-parse --path-format=absolute --git-dir --git-common-dir)"));
});

test("resume inside herdr opens a new tab and starts the resumed session under a new agent name", () => {
  const w = world();
  const file = jobFile(w, { status: "done", record: { session_id: "s-1", bound_at: "t", via: "herdr", herdr: { name: "dev-abc123", pane: "w1:p2" } } });
  const note = join(w.root, "note.md");
  writeFileSync(note, "Also add world.\n");
  const out = w.run(["resume", file, "--note-file", note, "--json"], inHerdr(w));
  assert.equal(out.status, 0, out.stderr);
  const spec = JSON.parse(out.stdout);
  assert.equal(spec.via, "herdr");
  assert.notEqual(spec.herdr.name, "dev-abc123");
  assert.match(spec.herdr.name, /^dev-[0-9a-f]{6}$/);
  const [, start] = w.herdrCalls();
  assert.deepEqual(start.slice(0, 11), ["agent", "start", spec.herdr.name, "--kind", "claude", "--pane", "w1:p7", "--", "--resume", "s-1", "--agent"]);
  assert.equal(start.at(-1), spec.prompt);
  assert.deepEqual(w.record(file).herdr, spec.herdr);
  const t3 = JSON.parse(w.run(["resume", jobFile(w, { status: "done", name: "t3-job", record: { session_id: "s-2", bound_at: "t" } }), "--note-file", note, "--t3", "--json"]).stdout);
  assert.equal(t3.via, "t3");
  assert.deepEqual(t3.t3, { instanceId: "tedy-dev", title: "dev acme-shop t3-job", message: t3.prompt });
  assert.deepEqual(tokenize(t3.command).slice(3, 6), ["claude", "--resume", "s-2"]);
});

const PANE = { name: "dev-abc123", pane: "w1:p7" };

test("close ends the job's session first, then closes the herdr pane the kit opened for it; stop and a job with no kit pane make no herdr call", async () => {
  const w = world();
  const live = await sleeper();
  const done = jobFile(w, { status: "done", record: { session_id: "s-1", pid: live.pid, pid_start: live.start, via: "herdr", herdr: PANE } });
  const out = w.run(["close", done]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout.trim(), /^closed: .*\nended session s-1 \(pid \d+\)\nclosed herdr pane w1:p7$/);
  assert.deepEqual(await live.exited, [null, "SIGTERM"]);
  assert.deepEqual(w.herdrCalls(), [["pane", "get", "w1:p7"], ["pane", "close", "w1:p7"]]);
  const stopped = jobFile(w, { name: "runaway", record: { session_id: "s-2", pid: DEAD_PID, pid_start: "1", via: "herdr", herdr: { name: "dev-def456", pane: "w1:p9" } } });
  assert.equal(w.run(["stop", stopped, "--reason", "runaway"]).stdout, `stopped: ${stopped}\n`);
  assert.equal(w.herdrCalls().length, 2);
  assert.match(w.run(["close", stopped]).stdout, /\nclosed herdr pane w1:p9\n$/);
  assert.deepEqual(w.herdrCalls().slice(2), [["pane", "get", "w1:p9"], ["pane", "close", "w1:p9"]]);
  const printed = jobFile(w, { status: "done", name: "printed", record: { session_id: "s-3", pid: DEAD_PID, pid_start: "1", via: "print" } });
  assert.equal(w.run(["close", printed]).stdout.trim(), `closed: ${printed}`);
  assert.equal(w.herdrCalls().length, 4);
});

test("a kit pane stays open when the caller runs in it, when it now runs another session, or when herdr is missing or fails, and close still succeeds", async () => {
  const w = world();
  const job = (name) => jobFile(w, { status: "done", name, record: { session_id: "s-1", pid: DEAD_PID, pid_start: "1", via: "herdr", herdr: PANE } });
  const closeWith = (extra) => w.run(["close", job(`j${w.jobs().length}`)], { extra });
  const inside = closeWith({ HERDR_PANE_ID: "w1:p7" });
  assert.equal(inside.status, 0, inside.stderr);
  assert.match(inside.stdout, /\nleft herdr pane w1:p7 open: this command runs inside it\n$/);
  assert.deepEqual(w.herdrCalls(), []);
  assert.match(closeWith({ FAKE_HERDR_PANE_SESSION: "s-other" }).stdout, /\nkept herdr pane w1:p7: it now runs session s-other, not this job's s-1\n$/);
  assert.deepEqual(w.herdrCalls(), [["pane", "get", "w1:p7"]]);
  assert.match(closeWith({ FAKE_HERDR_PANE_SESSION: "s-1" }).stdout, /\nclosed herdr pane w1:p7\n$/);
  assert.match(closeWith({ FAKE_HERDR_FAIL: "pane get:pane_not_found" }).stdout, /\nherdr pane w1:p7 is already closed\n$/);
  const failed = closeWith({ FAKE_HERDR_FAIL: "pane close:server_error" });
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.stdout, /\nwarning: herdr pane close failed \(server_error: fake failure\); close pane w1:p7 by hand\n$/);
  const missing = closeWith({ PATH: join(w.root, "nowhere") });
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /\nwarning: herdr is not on PATH, so pane w1:p7 was left open\n$/);
  assert.ok(w.jobs().every((file) => readFileSync(file, "utf8").includes("status: closed")));
  const { close } = await import("../lib/job.mjs");
  const own = await sleeper();
  try {
    const mine = jobFile(w, { name: "mine", record: { session_id: "s-9", pid: own.pid, pid_start: own.start, via: "herdr", herdr: PANE } });
    recordLaunch(mine, JSON.parse(readFileSync(launchRecordPath(mine, w.state), "utf8")));
    const before = w.herdrCalls().length;
    assert.doesNotMatch(close(w.map, mine, "blocked", { own: () => ({ pid: own.pid }), env: w.env() }), /herdr/);
    assert.equal(w.herdrCalls().length, before);
  } finally {
    own.child.kill("SIGKILL");
  }
});
