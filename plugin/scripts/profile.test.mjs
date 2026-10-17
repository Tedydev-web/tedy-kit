import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, initProfile, loadConfig, overrides, profileDir, resolveShared } from "./profile.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const SCRIPT = new URL("./profile.mjs", import.meta.url).pathname;
const SHARED = new URL("../shared/", import.meta.url).pathname;
const doctorEnv = (extra) => ({ ...process.env, TEDY_CLAUDE_MD: "/nonexistent/CLAUDE.md", TEDY_KNOWN_MARKETPLACES: "/nonexistent/known.json", TEDY_CLAUDE_VERSION: "2.1.302", ...extra });
const runDoctor = (extra) => spawnSync("node", [SCRIPT, "doctor"], { encoding: "utf8", env: doctorEnv(extra) });

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
  assert.deepEqual(config.gates, { noComments: false, draftPrOnly: false, roleGate: false, ghWrites: false, publishQuote: false, pushExempt: [] });
  assert.equal(config.language.chat, "en");
});

test("a partial config keeps the defaults it does not set and expands ~ in pushExempt", () => {
  const dir = profileWith({ "config.json": JSON.stringify({ gates: { noComments: true, pushExempt: ["~/work/kit", "/abs/profile"] }, language: { chat: "vi" } }) });
  assert.deepEqual(loadConfig(dir), { gates: { noComments: true, draftPrOnly: false, roleGate: false, ghWrites: false, publishQuote: false, pushExempt: [join(homedir(), "work/kit"), "/abs/profile"] }, language: { chat: "vi" } });
});

test("an invalid config fails loudly, naming the file and the field", () => {
  const cases = [
    [{ gates: { noComments: "yes" } }, /gates\.noComments must be a boolean/],
    [{ gates: { ghWrites: 1 } }, /gates\.ghWrites must be a boolean/],
    [{ gates: { publishQuote: "yes" } }, /gates\.publishQuote must be a boolean/],
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
  const dir = profileWith({ "config.json": JSON.stringify({ gates: { roleGate: true, ghWrites: true } }), "rules.md": "r\n", "style/pr-comment.md": "mine\n", "projects/a.md": "x\n" });
  const ok = runDoctor({ TEDY_PROFILE_DIR: dir });
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, new RegExp(`^ok profile-dir: ${dir}$`, "m"));
  assert.match(ok.stdout, /^ok config: personal gates on: roleGate, ghWrites$/m);
  assert.match(ok.stdout, /^rules: present$/m);
  assert.match(ok.stdout, /^overrides: style\/pr-comment\.md$/m);
  assert.match(ok.stdout, /^projects: 1 map$/m);
  for (const name of ["claude-md-imports", "claude-version", "release-worktree"]) assert.match(ok.stdout, new RegExp(`^ok ${name}: `, "m"));
  const empty = runDoctor({ TEDY_PROFILE_DIR: join(dir, "none") });
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /^ok config: missing, defaults apply \(personal gates off\)$/m);
  assert.match(empty.stdout, /^rules: missing; run profile\.mjs init$/m);
  const bad = profileWith({ "config.json": JSON.stringify({ gates: { roleGate: 1 } }) });
  const invalid = runDoctor({ TEDY_PROFILE_DIR: bad });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /^fail config: invalid: .*gates\.roleGate must be a boolean/m);
});

test("doctor fails on a relative profile dir, a missing CLAUDE.md import and an old Claude Code", () => {
  const dir = profileWith({ "config.json": "{}" });
  const relative = runDoctor({ TEDY_PROFILE_DIR: "relative/profile" });
  assert.equal(relative.status, 1);
  assert.match(relative.stdout, /^fail profile-dir: /m);
  const claudeMd = join(tempDir("tedy-claude-md-"), "CLAUDE.md");
  writeFileSync(claudeMd, `@${join(dir, "config.json")}\n@${join(dir, "missing-rules.md")}\n`);
  const imports = runDoctor({ TEDY_PROFILE_DIR: dir, TEDY_CLAUDE_MD: claudeMd });
  assert.equal(imports.status, 1);
  assert.match(imports.stdout, /^fail claude-md-imports: .*missing-rules\.md/m);
  const old = runDoctor({ TEDY_PROFILE_DIR: dir, TEDY_CLAUDE_VERSION: "2.1.300 (Claude Code)" });
  assert.equal(old.status, 1);
  assert.match(old.stdout, /^fail claude-version: 2\.1\.300/m);
});

test("doctor checks a release worktree against the profile's release tag", () => {
  const root = tempDir("tedy-release-");
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "a");
  git(repo, "tag", "v0.1.0");
  const release = join(root, "release");
  git(repo, "worktree", "add", "-q", "--detach", release, "v0.1.0");
  const known = (path) => {
    const file = join(root, `known-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify({ "tedy-kit": { source: { source: "directory", path }, installLocation: path } }));
    return file;
  };
  const dir = profileWith({ "config.json": "{}", "release-tag": "v0.1.0\n" });
  const matching = runDoctor({ TEDY_PROFILE_DIR: dir, TEDY_KNOWN_MARKETPLACES: known(release) });
  assert.equal(matching.status, 0, matching.stdout);
  assert.match(matching.stdout, /^ok release-worktree: .*v0\.1\.0/m);
  const plain = runDoctor({ TEDY_PROFILE_DIR: dir, TEDY_KNOWN_MARKETPLACES: known(repo) });
  assert.equal(plain.status, 0, plain.stdout);
  assert.match(plain.stdout, /^ok release-worktree: .*not a linked worktree/m);
  const wrongTag = runDoctor({ TEDY_PROFILE_DIR: profileWith({ "config.json": "{}", "release-tag": "v0.2.0\n" }), TEDY_KNOWN_MARKETPLACES: known(release) });
  assert.equal(wrongTag.status, 1);
  assert.match(wrongTag.stdout, /^fail release-worktree: /m);
  writeFileSync(join(release, "a.txt"), "changed\n");
  const dirty = runDoctor({ TEDY_PROFILE_DIR: dir, TEDY_KNOWN_MARKETPLACES: known(release) });
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /^fail release-worktree: .*uncommitted/m);
});

test("path prints the file a skill should read", () => {
  const dir = profileWith({ "style/pr-comment.md": "mine\n" });
  const result = spawnSync("node", [SCRIPT, "path", "style/pr-comment.md"], { encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: dir } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${join(dir, "style/pr-comment.md")}\n`);
  assert.equal(spawnSync("node", [SCRIPT, "path"], { encoding: "utf8" }).status, 2);
});
