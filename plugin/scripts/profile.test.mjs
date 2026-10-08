import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, initProfile, loadConfig, overrides, profileDir, resolveShared } from "./profile.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const SCRIPT = new URL("./profile.mjs", import.meta.url).pathname;
const SHARED = new URL("../shared/", import.meta.url).pathname;

function profileWith(files) {
  const dir = tempDir("tedy-profile-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

test("the profile directory comes from TEDY_PROFILE_DIR, else ~/.config/tedy", () => {
  assert.equal(profileDir({ TEDY_PROFILE_DIR: "/p/me" }), "/p/me");
  assert.equal(profileDir({}), join(homedir(), ".config", "tedy"));
});

test("a missing config gives the defaults, with every personal gate off", () => {
  const config = loadConfig(profileWith({}));
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.deepEqual(config.gates, { noComments: false, draftPrOnly: false, roleGate: false, pushExempt: [] });
  assert.equal(config.language.chat, "en");
});

test("a partial config keeps the defaults it does not set and expands ~ in pushExempt", () => {
  const dir = profileWith({ "config.json": JSON.stringify({ gates: { noComments: true, pushExempt: ["~/work/kit", "/abs/profile"] }, language: { chat: "vi" } }) });
  assert.deepEqual(loadConfig(dir), { gates: { noComments: true, draftPrOnly: false, roleGate: false, pushExempt: [join(homedir(), "work/kit"), "/abs/profile"] }, language: { chat: "vi" } });
});

test("an invalid config fails loudly, naming the file and the field", () => {
  const cases = [
    [{ gates: { noComments: "yes" } }, /gates\.noComments must be a boolean/],
    [{ gates: { pushExempt: "/one" } }, /gates\.pushExempt must be an array of strings/],
    [{ gate: {} }, /unknown key "gate"/],
    [{ gates: { noComment: true } }, /unknown key "gates\.noComment"/],
    [{ language: { chat: "" } }, /language\.chat must be a non-empty string/],
    [[], /must be a JSON object/],
  ];
  for (const [config, message] of cases) {
    const dir = profileWith({ "config.json": JSON.stringify(config) });
    assert.throws(() => loadConfig(dir), (error) => error.message.includes(join(dir, "config.json")) && message.test(error.message));
  }
  const broken = profileWith({ "config.json": "{ nope" });
  assert.throws(() => loadConfig(broken), /config\.json.*JSON/);
});

test("a profile file overrides the engine file of the same relative path, and paths cannot leave either root", () => {
  const dir = profileWith({ "style/pr-comment.md": "mine\n" });
  assert.equal(resolveShared("style/pr-comment.md", dir), join(dir, "style/pr-comment.md"));
  assert.equal(resolveShared("handoff.md", dir), join(SHARED, "handoff.md"));
  assert.deepEqual(overrides(dir), ["style/pr-comment.md"]);
  assert.throws(() => resolveShared("../rules/working-style.md", dir), /relative path inside/);
  assert.throws(() => resolveShared("/etc/passwd", dir), /relative path inside/);
  assert.throws(() => resolveShared("style/none.md", dir), /neither .* nor /);
});

test("init creates the config and rules from the template, and never overwrites them", () => {
  const dir = join(tempDir("tedy-profile-init-"), "profile");
  assert.deepEqual(initProfile(dir), { created: ["config.json", "rules.md", "projects/"], kept: [] });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")), DEFAULT_CONFIG);
  assert.equal(readFileSync(join(dir, "rules.md"), "utf8"), readFileSync(join(SHARED, "rules-template.md"), "utf8"));
  writeFileSync(join(dir, "rules.md"), "edited\n");
  assert.deepEqual(initProfile(dir), { created: [], kept: ["config.json", "rules.md", "projects/"] });
  assert.equal(readFileSync(join(dir, "rules.md"), "utf8"), "edited\n");
});

test("doctor reports the profile, config, rules, overrides and maps, and exits 1 on an invalid config", () => {
  const dir = profileWith({ "config.json": JSON.stringify({ gates: { roleGate: true } }), "rules.md": "r\n", "style/pr-comment.md": "mine\n", "projects/a.md": "x\n" });
  const ok = spawnSync("node", [SCRIPT, "doctor"], { encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: dir } });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, new RegExp(`^profile: ${dir}$`, "m"));
  assert.match(ok.stdout, /^config: ok \(personal gates on: roleGate\)$/m);
  assert.match(ok.stdout, /^rules: present$/m);
  assert.match(ok.stdout, /^overrides: style\/pr-comment\.md$/m);
  assert.match(ok.stdout, /^projects: 1 map$/m);
  const empty = spawnSync("node", [SCRIPT, "doctor"], { encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: join(dir, "none") } });
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /^config: missing, defaults apply \(personal gates off\)$/m);
  assert.match(empty.stdout, /^rules: missing; run profile\.mjs init$/m);
  const bad = profileWith({ "config.json": JSON.stringify({ gates: { roleGate: 1 } }) });
  const invalid = spawnSync("node", [SCRIPT, "doctor"], { encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: bad } });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /^config: invalid: .*gates\.roleGate must be a boolean/m);
});

test("path prints the file a skill should read", () => {
  const dir = profileWith({ "style/pr-comment.md": "mine\n" });
  const result = spawnSync("node", [SCRIPT, "path", "style/pr-comment.md"], { encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: dir } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${join(dir, "style/pr-comment.md")}\n`);
  assert.equal(spawnSync("node", [SCRIPT, "path"], { encoding: "utf8" }).status, 2);
});
