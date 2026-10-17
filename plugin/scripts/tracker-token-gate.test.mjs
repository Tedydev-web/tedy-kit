import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate as trackerToken, trackerHost } from "./tracker-token-gate.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const GATE_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "tracker-token-gate.mjs");
const CONFIG_NAME = "config" + ".json";

function opHome() {
  const root = tempDir("tedy-op-");
  const op = join(root, "op");
  mkdirSync(join(op, "sync"), { recursive: true });
  const configFile = join(op, CONFIG_NAME);
  writeFileSync(configFile, "{}");
  writeFileSync(join(op, "sync", "h__p.map.json"), "{}");
  return { root, op, configFile };
}

test("the tracker token file and direct writes to the tracker host are denied in any tool input", () => {
  const host = "op.example.com";
  const literal = "/srv/u/.con" + "fig/op/" + CONFIG_NAME;
  assert.ok(trackerToken({ command: `python3 -c "import json;json.load(open('${literal}'))"` }, host));
  assert.ok(trackerToken({ code: "p = Path.home() / '.config' / 'op' / 'config.json'" }, host));
  assert.ok(trackerToken({ code: "os.path.join(home, '.config', 'op', 'config.json')" }, host));
  assert.ok(trackerToken({ file_path: literal }, host));
  assert.ok(trackerToken({ commands: [{ label: "x", command: "curl -X PATCH https://op.example.com/api/v3/work_packages/1" }] }, host));
  assert.ok(trackerToken({ code: "requests.post('https://op.example.com/api/v3/work_packages/1/activities')" }, host));
  assert.equal(trackerToken({ command: "curl https://op.example.com/api/v3/statuses" }, host), null);
  assert.equal(trackerToken({ command: "node plugin/scripts/openproject.mjs set 21453 --status Fixed --apply --lock 3" }, host), null);
  assert.equal(trackerToken({ command: "cat ~/.config/op/sync/op.example.com__x.map.json" }, host), null);
  assert.equal(trackerHost(() => JSON.stringify({ url: "https://op.example.com/", token: "t" })), "op.example.com");
  assert.equal(trackerHost(() => "not json"), null);
});

test("the token file is denied however a path reaches it: cd, relative paths, globs, ancestors and symlinks", () => {
  const { root, op, configFile } = opHome();
  symlinkSync(configFile, join(root, "link"));
  const check = (toolInput, cwd = "/") => trackerToken(toolInput, null, { configFile, cwd });
  for (const toolInput of [
    { command: `cd ${op} && cat ${CONFIG_NAME}` },
    { command: `cd ${root} && cat op/${CONFIG_NAME}` },
    { command: `cat ${op}/conf*.json` },
    { command: `cat ${join(root, "link")}` },
    { pattern: "token", path: op },
    { pattern: "token", path: root },
    { file_path: join(root, "link") },
    { path: join(op, CONFIG_NAME) },
  ]) {
    assert.ok(check(toolInput), JSON.stringify(toolInput));
  }
  assert.ok(check({ command: `cat ${CONFIG_NAME}` }, op));
  for (const command of [`rg token ${root}`, `grep -r token ${op}`, `zip -r x.zip ${root}`, `cd ${root} && rg token .`, `tar czf x.tgz ${op}`]) assert.ok(check({ command }), command);
  for (const command of [`ls ${root}`, `rg x ${join(op, "sync")}`, `du -sh ${root}`, `find ${root} -name x`, `cp a.txt ${root}`]) assert.equal(check({ command }), null, command);
});

test("the shared sidecar and ordinary paths stay readable", () => {
  const { op, configFile } = opHome();
  const check = (toolInput) => trackerToken(toolInput, null, { configFile, cwd: "/" });
  for (const toolInput of [
    { file_path: join(op, "sync", "h__p.map.json") },
    { command: `cat ${join(op, "sync", "h__p.map.json")}` },
    { pattern: "x", path: join(op, "sync") },
    { command: "ls ~/Documents" },
    { pattern: "x" },
  ]) {
    assert.equal(check(toolInput), null, JSON.stringify(toolInput));
  }
});

test("the gate entry denies a Bash command that names the token file on its own", () => {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "cat ~/.con" + "fig/op/" + CONFIG_NAME }, cwd: "/tmp" });
  const out = execFileSync("node", [GATE_ENTRY], { input, encoding: "utf8", env: { ...process.env, TEDY_STATE_DIR: tempDir("tedy-state-") } });
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
});

test("the gate entry refuses the call when its own check throws", () => {
  const home = tempDir("tedy-token-home-");
  mkdirSync(join(home, ".con" + "fig", "op"), { recursive: true });
  writeFileSync(join(home, ".con" + "fig", "op", CONFIG_NAME), "{}");
  const input = JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x" }, cwd: 123 });
  const out = execFileSync("node", [GATE_ENTRY], { input, encoding: "utf8", env: { ...process.env, HOME: home, TEDY_STATE_DIR: tempDir("tedy-state-") } });
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
});
