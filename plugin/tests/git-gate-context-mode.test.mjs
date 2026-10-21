import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bashInputs } from "../gates/git-gate.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const GATE_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "../gates/git-gate.mjs");
const EXECUTE = "mcp__plugin_context-mode_context-mode__ctx_execute";
const EXECUTE_FILE = "mcp__plugin_context-mode_context-mode__ctx_execute_file";
const BATCH = "mcp__context-mode__ctx_batch_execute";
const HEREDOC = "cat <<'EOF' | bash\ngit push origin main\nEOF";

function hook(toolName, toolInput, cwd = "/tmp", ask = []) {
  const settings = join(tempDir("tedy-settings-"), "settings.json");
  writeFileSync(settings, JSON.stringify({ permissions: { ask } }));
  const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd });
  const env = { ...process.env, TEDY_STATE_DIR: tempDir("tedy-state-"), TEDY_CLAUDE_SETTINGS: settings, TEDY_PROFILE_DIR: profileWith({ gates: {} }) };
  const out = execFileSync("node", [GATE_ENTRY], { input, encoding: "utf8", env });
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

const bash = (command, cwd) => hook("Bash", { command }, cwd);

test("a push sent as ctx_execute shell code is judged exactly like the same Bash command", () => {
  const command = "git push --force origin feat";
  const viaBash = bash(command);
  assert.equal(viaBash?.permissionDecision, "ask");
  assert.deepEqual(hook(EXECUTE, { language: "shell", code: command }), viaBash);
  assert.deepEqual(hook(EXECUTE_FILE, { path: "x.log", language: "shell", code: command }), viaBash);
});

test("a heredoc in one ctx_batch_execute command is refused with the rewrite text, even beside allowed commands", () => {
  const viaBash = bash(HEREDOC);
  assert.equal(viaBash?.permissionDecision, "deny");
  assert.match(viaBash.permissionDecisionReason, /script file/);
  const result = hook(BATCH, { commands: [{ label: "status", command: "git status" }, { label: "push", command: HEREDOC }], queries: ["x"] });
  assert.deepEqual(result, viaBash);
});

test("a refusal in any batch command wins over an ask in another", () => {
  const result = hook(BATCH, { commands: [{ label: "a", command: "git push --force origin feat" }, { label: "b", command: 'eval "gh pr merge 1"' }] });
  assert.equal(result?.permissionDecision, "deny");
  assert.match(result.permissionDecisionReason, /script file/);
});

test("an allowed plain command through ctx_execute passes and is read from the code field", () => {
  assert.equal(hook(EXECUTE, { language: "shell", code: "git status" }), null);
  assert.equal(hook(BATCH, { commands: [{ label: "log", command: "git log -1" }, { label: "diff", command: "git diff" }] }), null);
  const input = { tool_name: EXECUTE, tool_input: { language: "shell", code: "git status", cwd: "/w/sub" }, cwd: "/w", transcript_path: "/t.jsonl" };
  assert.deepEqual(bashInputs(input), { inputs: [{ ...input, tool_name: "Bash", cwd: "/w/sub", tool_input: { command: "git status" } }] });
});

test("a publish through a context-mode tool is refused and sent back to run as a plain Bash command", () => {
  const rules = ["Bash(*github-write.mjs*post*)", "Bash(*openproject.mjs*set*--apply*)"];
  const publish = "node /k/github-write.mjs post d.md";
  assert.equal(hook("Bash", { command: publish }, "/tmp", rules), null);
  for (const [toolName, toolInput] of [
    [EXECUTE, { language: "shell", code: publish }],
    [EXECUTE_FILE, { path: "x", language: "shell", code: `cd /tmp && ${publish}` }],
    [BATCH, { commands: [{ label: "a", command: "git status" }, { label: "b", command: "node /k/openproject.mjs set 12 --status Done --apply" }] }],
  ]) {
    const result = hook(toolName, toolInput, "/tmp", rules);
    assert.equal(result?.permissionDecision, "deny", JSON.stringify(toolInput));
    assert.match(result.permissionDecisionReason, /plain Bash command/, JSON.stringify(toolInput));
  }
  assert.equal(hook(EXECUTE, { language: "shell", code: "git commit -F - <<'EOF'\nrun github-write.mjs post later\nEOF" }, "/tmp", rules), null);
  assert.equal(hook(EXECUTE, { language: "shell", code: "node /k/github-write.mjs view 1" }, "/tmp", rules), null);
});

test("a Bash call is passed through unchanged", () => {
  const input = { tool_name: "Bash", tool_input: { command: "git status" }, cwd: "/w" };
  assert.equal(bashInputs(input).inputs[0], input);
});

test("batch commands are read in every form the context-mode server accepts", () => {
  const read = (commands) => bashInputs({ tool_name: BATCH, tool_input: { commands }, cwd: "/w" }).inputs?.map((input) => input.tool_input.command);
  assert.deepEqual(read([{ label: "a", command: "git status" }, "git diff"]), ["git status", "git diff"]);
  assert.deepEqual(read(JSON.stringify([{ label: "a", command: "git status" }])), ["git status"]);
  assert.deepEqual(read("git push --force origin feat"), ["git push --force origin feat"]);
  assert.equal(hook(BATCH, { commands: JSON.stringify(["git push --force origin feat"]) })?.permissionDecision, "ask");
});

test("non-shell code in ctx_execute or ctx_execute_file is treated like python3 <file> through Bash", () => {
  const code = "import subprocess; subprocess.run(['git', 'push', '--force', 'origin', 'main'])";
  assert.equal(bash("python3 /tmp/tedy-script.py"), null);
  assert.equal(hook(EXECUTE, { language: "python", code }), null);
  assert.equal(hook(EXECUTE_FILE, { path: "data.json", language: "javascript", code: "console.log(FILE_CONTENT.length)" }), null);
  assert.deepEqual(bashInputs({ tool_name: EXECUTE, tool_input: { language: "python", code }, cwd: "/w" }), { inputs: [] });
});

test("a malformed context-mode call is refused with a clear message, never allowed", () => {
  for (const [toolName, toolInput] of [
    [EXECUTE, { language: "shell" }],
    [EXECUTE, { code: "git status" }],
    [EXECUTE, { language: "bash", code: "git push --force" }],
    [EXECUTE, { language: "shell", code: "git status", cwd: 7 }],
    [EXECUTE_FILE, { path: "x", language: "shell", code: ["git status"] }],
    [EXECUTE, null],
    [BATCH, {}],
    [BATCH, { commands: [] }],
    [BATCH, { commands: "  " }],
    [BATCH, { commands: [{ label: "a" }] }],
    [BATCH, { commands: [{ label: "a", command: "git status" }, 7] }],
    [BATCH, { commands: { command: "git status" } }],
  ]) {
    const result = hook(toolName, toolInput);
    assert.equal(result?.permissionDecision, "deny", JSON.stringify(toolInput));
    assert.match(result.permissionDecisionReason, /could not read this context-mode call/, JSON.stringify(toolInput));
  }
});
