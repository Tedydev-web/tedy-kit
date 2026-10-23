import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-dir-for-tests.mjs";

const PLUGIN = fileURLToPath(new URL("../", import.meta.url));
const GATES = ["git-gate", "role-gate", "no-comments-gate", "tracker-token-gate", "profile-guard-gate"];
const HOOKS = ["push-report", "publish-approval-ticket", "session-hooks"];
const CLIS = ["doc-comment-file", "draft-lint", "edit-rate", "figma-comments", "figma-read", "gdoc-comments", "github-write", "handoff", "labels", "memory-stats", "merged-sweep", "openproject", "pending", "prd-section", "prior-art-verify", "profile", "project-map", "project-state", "public-scan", "task-lint"];

const NO_FAILURE_PATH = ["edit-rate", "labels"];

const home = tempDir("tedy-shim-parity-");
const profile = join(home, "profile");
mkdirSync(profile);
writeFileSync(join(profile, "rules.md"), "r\n");
mkdirSync(join(profile, "projects"));
writeFileSync(join(profile, "projects", "w.md"), `\`\`\`json\n${JSON.stringify({ name: "w", paths: [home] })}\n\`\`\`\n`);
writeFileSync(join(home, "body.txt"), "ok text\n");
writeFileSync(join(home, "drafts.json"), "[]\n");
mkdirSync(join(home, "tree"));
const PASSING = {
  "draft-lint": ["doc-comment", join(home, "body.txt")],
  "edit-rate": [],
  labels: [],
  profile: ["path", "rules.md"],
  "public-scan": ["tree", join(home, "tree")],
  "task-lint": [join(home, "drafts.json")],
};
const env = { ...process.env, TEDY_PROFILE_DIR: profile };
const run = (dir, name, args, input = "") => {
  const state = tempDir("tedy-shim-state-");
  const { status, stdout, stderr } = spawnSync("node", [join(PLUGIN, dir, `${name}.mjs`), ...args], { cwd: home, env: { ...env, TEDY_STATE_DIR: state }, input, encoding: "utf8", timeout: 20000 });
  const frames = (text) => text.replaceAll(state, "<state>").replace(/^ {4}at .*\n/gm, "");
  return { status, stdout: frames(stdout), stderr: frames(stderr) };
};
const home_ = (name) => (GATES.includes(name) || name === "publish-quote-gate" ? "gates" : "lib");

test("every shim in scripts/ names a module that exists, and every guarded module has a shim", () => {
  const shims = readdirSync(join(PLUGIN, "scripts")).map((file) => file.replace(/\.mjs$/, "")).sort();
  assert.deepEqual(shims, [...GATES, ...HOOKS, ...CLIS].sort());
});

test("each hooked gate shim prints the same non-empty decision as the gate on unreadable input", () => {
  for (const gate of GATES) {
    const shim = run("scripts", gate, [], "not json");
    assert.notEqual(shim.stdout, "", gate);
    assert.deepEqual(shim, run("gates", gate, [], "not json"), gate);
  }
});

test("each hook shim matches its module on an empty event", () => {
  for (const hook of HOOKS) assert.deepEqual(run("scripts", hook, [], "{}"), run(home_(hook), hook, [], "{}"), hook);
});

test("each command-line shim matches its module on failure, and on success where a local call succeeds", () => {
  for (const cli of CLIS) {
    const failing = run("scripts", cli, ["zz-unknown-command"]);
    if (!NO_FAILURE_PATH.includes(cli)) assert.notEqual(failing.status, 0, cli);
    assert.deepEqual(failing, run(home_(cli), cli, ["zz-unknown-command"]), cli);
    if (!PASSING[cli]) continue;
    const passing = run("scripts", cli, PASSING[cli]);
    assert.equal(passing.status, 0, `${cli}: ${passing.stderr}`);
    assert.deepEqual(passing, run(home_(cli), cli, PASSING[cli]), cli);
  }
});

test("a shim reached through a symlinked plugin root still runs its module", async () => {
  const { symlinkSync } = await import("node:fs");
  const link = join(tempDir("tedy-shim-link-"), "plugin");
  symlinkSync(PLUGIN, link);
  const direct = spawnSync("node", [join(PLUGIN, "scripts", "labels.mjs")], { encoding: "utf8", env });
  const linked = spawnSync("node", [join(link, "scripts", "labels.mjs")], { encoding: "utf8", env });
  assert.equal(linked.status, 0);
  assert.notEqual(linked.stdout, "");
  assert.equal(linked.stdout, direct.stdout);
});
