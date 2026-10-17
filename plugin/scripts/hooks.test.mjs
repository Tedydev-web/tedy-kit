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
