import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const GATES = ["no-comments-gate", "role-gate", "git-gate", "tracker-token-gate", "profile-guard-gate", "reviewer-gate", "review-run-gate"];

test("the seven PreToolUse gates block the tool call when their hook fails", () => {
  const hooks = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8")).hooks.PreToolUse.flatMap((entry) => entry.hooks);
  const gates = hooks.filter((hook) => GATES.some((gate) => hook.command.includes(`/${gate}.mjs`)));
  assert.deepEqual(gates.map((hook) => GATES.find((gate) => hook.command.includes(`/${gate}.mjs`))).sort(), [...GATES].sort());
  for (const hook of gates) assert.equal(hook.onFailure, "block", hook.command);
});

for (const [gate, tools] of [["git-gate", ["Bash"]], ["review-run-gate", ["Bash"]], ["push-report", ["Bash"]], ["role-gate", ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]], ["profile-guard-gate", ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]]]) {
  test(`${gate} runs on its tools and on context-mode shell tools under any install name`, () => {
    const { PreToolUse, PostToolUse } = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8")).hooks;
    const entry = [...PreToolUse, ...PostToolUse].find((item) => item.hooks.some((hook) => hook.command.includes(`/${gate}.mjs`)));
    const matcher = new RegExp(entry.matcher);
    for (const tool of [...tools, "mcp__plugin_context-mode_context-mode__ctx_execute", "mcp__plugin_context-mode_context-mode__ctx_execute_file", "mcp__plugin_context-mode_context-mode__ctx_batch_execute", "mcp__context-mode__ctx_execute", "mcp__plugin_tedy_context-mode__ctx_batch_execute", "mcp__context_mode__ctx_execute", "mcp__ctx__ctx_execute", "mcp__other__ctx_execute"]) {
      assert.ok(matcher.test(tool), tool);
    }
    for (const tool of ["NotebookBash", "BashOutput", "Read", "EditX", "mcp__plugin_context-mode_context-mode__ctx_search", "mcp__plugin_context-mode_context-mode__ctx_index", "mcp__plugin_context-mode_context-mode__ctx_execute_files", "mcp__x__ctx_execute_extra", "ctx_execute"]) {
      assert.ok(!matcher.test(tool), tool);
    }
  });
}

test("every PreToolUse gate that reads a Bash command also runs on Monitor, which runs a command as Bash does", () => {
  const { PreToolUse } = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8")).hooks;
  for (const gate of ["role-gate", "git-gate", "profile-guard-gate", "tracker-token-gate", "reviewer-gate", "review-run-gate"]) {
    const entry = PreToolUse.find((item) => item.hooks.some((hook) => hook.command.includes(`/${gate}.mjs`)));
    const matcher = new RegExp(entry.matcher);
    assert.ok(matcher.test("Bash"), `${gate} Bash`);
    assert.ok(matcher.test("Monitor"), `${gate} Monitor`);
    if (gate !== "tracker-token-gate") for (const tool of ["MonitorX", "XMonitor", "BashOutput"]) assert.ok(!matcher.test(tool), `${gate} ${tool}`);
  }
});

test("role-gate also runs before a subagent spawn, so a forked job records its role before the subagent's first call", () => {
  const { PreToolUse } = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8")).hooks;
  const entry = PreToolUse.find((item) => item.hooks.some((hook) => hook.command.includes("/role-gate.mjs")));
  const matcher = new RegExp(entry.matcher);
  assert.ok(matcher.test("Agent"));
  for (const tool of ["AgentX", "SubAgent", "mcp__x__Agent", "Read"]) assert.ok(!matcher.test(tool), tool);
});

test("the publish-approval ticket hook runs after AskUserQuestion only", () => {
  const { PostToolUse } = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8")).hooks;
  const entry = PostToolUse.find((item) => item.hooks.some((hook) => hook.command.includes("/publish-approval-ticket.mjs")));
  const matcher = new RegExp(entry.matcher);
  assert.ok(matcher.test("AskUserQuestion"));
  for (const tool of ["Bash", "AskUserQuestionX", "mcp__x__AskUserQuestion"]) assert.ok(!matcher.test(tool), tool);
});

test("the job status hook runs after every tool, on the permission notification and when a tedy job agent stops, never blocking and never on a per-prompt or subagent-start event", () => {
  const { hooks } = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
  const entries = Object.entries(hooks).flatMap(([event, list]) => list.filter((item) => item.hooks.some((hook) => hook.command.includes("/job-session-hooks.mjs"))).map((item) => [event, item]));
  assert.deepEqual(entries.map(([event, item]) => [event, item.matcher]).sort(), [["Notification", "permission_prompt"], ["PostToolUse", undefined], ["SubagentStop", "^tedy:(pm|dev|review|devops)$"]].sort());
  for (const [, item] of entries) for (const hook of item.hooks) assert.equal(hook.onFailure, undefined, hook.command);
  const stop = new RegExp(entries.find(([event]) => event === "SubagentStop")[1].matcher);
  for (const agent of ["tedy:pm", "tedy:dev", "tedy:review", "tedy:devops"]) assert.ok(stop.test(agent), agent);
  for (const agent of ["tedy:reviewer", "", "Explore", "other:tedy:pm", "tedy:pmx"]) assert.ok(!stop.test(agent), agent);
});

test("the ask-cards hook runs on every prompt in a plain command group, never blocking, with a short timeout", () => {
  const { hooks } = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
  assert.deepEqual(hooks.UserPromptSubmit, [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-hooks.mjs" ask-cards', timeout: 10 }] }]);
});

test("the ask-time approval gate runs before AskUserQuestion only, and a failure lets the question through", () => {
  const { PreToolUse } = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8")).hooks;
  const entries = PreToolUse.filter((item) => item.hooks.some((hook) => hook.command.includes("/publish-approval-ask-gate.mjs")));
  assert.equal(entries.length, 1);
  const matcher = new RegExp(entries[0].matcher);
  assert.ok(matcher.test("AskUserQuestion"));
  for (const tool of ["Bash", "AskUserQuestionX", "mcp__x__AskUserQuestion"]) assert.ok(!matcher.test(tool), tool);
  for (const hook of entries[0].hooks) assert.equal(hook.onFailure, undefined, hook.command);
});
