import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tokenize } from "../lib/shell-segments.mjs";
import { jobFile, world } from "./job-world-for-tests.mjs";

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

test("t3-instance prints the instance name, the Launch arguments with the absolute settings file and the env lines to paste into T3, and writes no T3 config", () => {
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

test("list adds herdr's state for a job herdr runs, unless the kit's own record says it waits", () => {
  const w = world();
  jobFile(w, { name: "working", record: { session_id: "s-1", bound_at: "t", state: "running", herdr: { name: "dev-abc123", pane: "w1:p7" } } });
  jobFile(w, { name: "asking", record: { session_id: "s-2", bound_at: "t", state: "waiting: question", herdr: { name: "dev-def456", pane: "w1:p8" } } });
  jobFile(w, { name: "plain", record: { session_id: "s-3", bound_at: "t", state: "idle" } });
  const lines = (extra) => w.run(["list"], { extra }).stdout.trim().split("\n").map((line) => line.split(" · ").slice(1, 3).join(" · ")).sort();
  assert.deepEqual(lines({ FAKE_HERDR_STATUS: "blocked" }), ["asking · waiting: question", "plain · idle", "working · running (herdr: blocked)"]);
  assert.deepEqual(w.herdrCalls(), [["agent", "get", "dev-abc123"]]);
  assert.deepEqual(lines({}), ["asking · waiting: question", "plain · idle", "working · running (herdr: agent_not_found)"]);
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
