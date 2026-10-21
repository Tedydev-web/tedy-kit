import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const GATES = ["no-comments-gate", "role-gate", "git-gate", "tracker-token-gate", "profile-guard-gate"];

test("the five PreToolUse gates block the tool call when their hook fails", () => {
  const hooks = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8")).hooks.PreToolUse.flatMap((entry) => entry.hooks);
  const gates = hooks.filter((hook) => GATES.some((gate) => hook.command.includes(`/${gate}.mjs`)));
  assert.deepEqual(gates.map((hook) => GATES.find((gate) => hook.command.includes(`/${gate}.mjs`))).sort(), [...GATES].sort());
  for (const hook of gates) assert.equal(hook.onFailure, "block", hook.command);
});

for (const [gate, tools] of [["git-gate", ["Bash"]], ["role-gate", ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]], ["profile-guard-gate", ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]]]) {
  test(`${gate} runs on its tools and on context-mode shell tools under any install name`, () => {
    const entry = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8")).hooks.PreToolUse.find((item) => item.hooks.some((hook) => hook.command.includes(`/${gate}.mjs`)));
    const matcher = new RegExp(entry.matcher);
    for (const tool of [...tools, "mcp__plugin_context-mode_context-mode__ctx_execute", "mcp__plugin_context-mode_context-mode__ctx_execute_file", "mcp__plugin_context-mode_context-mode__ctx_batch_execute", "mcp__context-mode__ctx_execute", "mcp__plugin_tedy_context-mode__ctx_batch_execute"]) {
      assert.ok(matcher.test(tool), tool);
    }
    for (const tool of ["NotebookBash", "BashOutput", "Read", "EditX", "mcp__plugin_context-mode_context-mode__ctx_search", "mcp__plugin_context-mode_context-mode__ctx_index", "mcp__plugin_context-mode_context-mode__ctx_execute_files", "mcp__other__ctx_execute"]) {
      assert.ok(!matcher.test(tool), tool);
    }
  });
}
