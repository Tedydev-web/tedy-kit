import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "./profile-guard-gate.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const GATE_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "profile-guard-gate.mjs");

function places() {
  const profile = tempDir("tedy-guard-profile-");
  const release = tempDir("tedy-guard-release-");
  writeFileSync(join(profile, "config.json"), "{}");
  writeFileSync(join(profile, "rules.md"), "# rules\n");
  return { profile, release };
}

test("writes to the profile config or rules and checkouts in the release worktree ask", () => {
  const { profile, release } = places();
  const check = (tool_name, tool_input, cwd = "/") => evaluate({ tool_name, tool_input, cwd }, { profile, release });
  for (const tool of ["Edit", "Write", "MultiEdit"]) {
    assert.ok(check(tool, { file_path: join(profile, "config.json") }), tool);
    assert.ok(check(tool, { file_path: join(profile, "rules.md") }), tool);
  }
  assert.ok(check("NotebookEdit", { notebook_path: join(profile, "rules.md") }));
  assert.ok(check("Edit", { file_path: "rules.md" }, profile));
  for (const command of [
    `cd ${profile} && jq . config.json > x && mv x config.json`,
    `sed -i s/a/b/ ${join(profile, "rules.md")}`,
    `git -C ${release} checkout v0.0.9`,
    `git -C ${release} switch x`,
    `git -C ${release} reset --hard x`,
    `cd ${release} && git checkout v0.0.9`,
    `git -C ${release} pull`,
  ]) {
    assert.ok(check("Bash", { command }), command);
  }
});

test("reads, other profile files and read-only git in the release worktree pass", () => {
  const { profile, release } = places();
  const check = (tool_name, tool_input) => evaluate({ tool_name, tool_input, cwd: "/" }, { profile, release });
  assert.equal(check("Read", { file_path: join(profile, "config.json") }), null);
  assert.equal(check("Edit", { file_path: join(profile, "projects", "x.md") }), null);
  for (const command of [`git -C ${release} describe --exact-match`, `git -C ${release} fetch --tags`, `git -C ${release} status`, "git checkout main", `ls ${profile}`]) {
    assert.equal(check("Bash", { command }), null, command);
  }
});

test("the guard entry asks through the hook output", () => {
  const { profile, release } = places();
  const input = JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(profile, "config.json"), content: "{}" }, cwd: "/" });
  const out = execFileSync("node", [GATE_ENTRY], { input, encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: profile, TEDY_RELEASE_DIR: release, TEDY_STATE_DIR: tempDir("tedy-state-") } });
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

test("the guard entry fails closed and asks when the check itself throws", () => {
  const { profile, release } = places();
  const stateDir = tempDir("tedy-state-");
  const input = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "x" }, cwd: 123 });
  const out = execFileSync("node", [GATE_ENTRY], { input, encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: profile, TEDY_RELEASE_DIR: release, TEDY_STATE_DIR: stateDir } });
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
  const log = readFileSync(join(stateDir, "gate-log.jsonl"), "utf8");
  assert.match(log, /"decision":"ask-on-error"/);
});
