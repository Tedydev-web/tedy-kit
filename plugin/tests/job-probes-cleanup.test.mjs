import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LEGACY, WORKSPACE, cleanupTargets, commandOutcome, shortIdOf } from "../evals/probes/job-probes.mjs";

test("the job probes say they measure the legacy --bg launch, which job.mjs no longer uses", () => {
  assert.match(LEGACY, /^\[legacy\] .*claude --bg.*job\.mjs no longer launches/);
});

test("job probe reads a background session's short id from the launch line", () => {
  assert.equal(shortIdOf("backgrounded · b81fdaf2 · probe job one"), "b81fdaf2");
  assert.equal(shortIdOf("backgrounded · 3af3da0e"), "3af3da0e");
  assert.equal(shortIdOf("Workspace not trusted"), null);
  assert.equal(shortIdOf("backgrounded · not-an-id"), null);
});

test("job probe cleanup acts only on recorded background sessions under the probe workspace", () => {
  const rows = [
    { kind: "background", id: "a1", sessionId: "u1", cwd: WORKSPACE },
    { kind: "background", id: "a2", sessionId: "u2", cwd: `${WORKSPACE}/.claude/worktrees/x` },
    { kind: "background", id: "b1", sessionId: "decoy", cwd: WORKSPACE },
    { kind: "interactive", sessionId: "u3", cwd: WORKSPACE },
    { kind: "background", id: "c1", sessionId: "u4", cwd: `${WORKSPACE}-other` },
    { kind: "background", id: "c2", sessionId: "u5", cwd: "/srv/project" },
  ];
  assert.deepEqual(cleanupTargets(rows, [], WORKSPACE), []);
  assert.deepEqual(cleanupTargets(rows, ["u1", "u2", "u3", "u4", "u5"], WORKSPACE).map((row) => row.id), ["a1", "a2"]);
  assert.deepEqual(cleanupTargets(rows, ["u1"], "/tmp"), []);
});

test("job probe reads a command's outcome from the transcript", () => {
  const use = { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", input: { command: "echo tedy-ask-probe-1" } }] } };
  const ran = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "tedy-ask-probe-1" }] } };
  const denied = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Permission to use Bash was denied" }] } };
  assert.equal(commandOutcome([], "tedy-ask-probe"), "not-called");
  assert.equal(commandOutcome([use], "tedy-ask-probe"), "pending");
  assert.equal(commandOutcome([use, ran], "tedy-ask-probe"), "ran");
  assert.equal(commandOutcome([use, denied], "tedy-ask-probe"), "auto-denied");
  assert.equal(commandOutcome([{ type: "user", message: { content: "plain text" } }], "x"), "not-called");
});
