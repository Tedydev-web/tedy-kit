import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_PUBLISH_ASK_RULES, TRANSCRIPT_EDIT_DENY } from "../lib/publish-approval-settings.mjs";
import { loadConfig } from "../lib/profile.mjs";
import { evaluate as guard } from "../gates/profile-guard-gate.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const SCRIPT = new URL("../scripts/profile.mjs", import.meta.url).pathname;
const MARKER = "tedy-env-block-marker";
const OTHER = ["Bash(gh pr merge*)", "Bash(*my-own-tool.mjs*send*)"];
const SSH_DENY = "Read(~/.ssh/**)";

function places({ config = { gates: { noComments: true }, language: { chat: "vi" } }, rules = [...OTHER.slice(0, 1), ...KIT_PUBLISH_ASK_RULES, OTHER[1]], deny = [SSH_DENY] } = {}) {
  const profile = tempDir("tedy-toggle-profile-");
  if (config) writeFileSync(join(profile, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  const home = tempDir("tedy-toggle-claude-");
  const settings = join(home, "settings.json");
  const data = { env: { TEDY_TOKEN: MARKER }, permissions: { allow: ["Read"], ask: rules, ...(deny ? { deny } : {}), defaultMode: "bypassPermissions" }, model: "x", hooks: { Stop: [] } };
  writeFileSync(settings, `${JSON.stringify(data, null, 2)}\n`);
  chmodSync(settings, 0o600);
  return { profile, home, settings, data };
}

const toggle = ({ profile, settings }, ...args) => spawnSync("node", [SCRIPT, "publish-approval", ...args], { encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: profile, TEDY_CLAUDE_SETTINGS: settings } });
const backups = ({ home }) => readdirSync(home).filter((name) => name !== "settings.json");
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

test("answer removes exactly the kit's publish ask rules, after a 600 backup, and keeps every other key", () => {
  const place = places();
  const before = readFileSync(place.settings, "utf8");
  const run = toggle(place, "answer");
  assert.equal(run.status, 0, run.stderr);
  const after = read(place.settings);
  assert.deepEqual(after.permissions.ask, OTHER);
  assert.deepEqual(after.permissions.deny, [SSH_DENY, TRANSCRIPT_EDIT_DENY]);
  assert.deepEqual({ ...after, permissions: { ...after.permissions, ask: null, deny: null } }, { ...place.data, permissions: { ...place.data.permissions, ask: null, deny: null } });
  assert.equal(statSync(place.settings).mode & 0o777, 0o600);
  const [backup] = backups(place);
  assert.equal(readFileSync(join(place.home, backup), "utf8"), before);
  assert.equal(statSync(join(place.home, backup)).mode & 0o777, 0o600);
  assert.equal(loadConfig(place.profile).gates.publishApproval, "answer");
  assert.equal(loadConfig(place.profile).gates.noComments, true);
  assert.equal(read(join(place.profile, "config.json")).language.chat, "vi");
  assert.doesNotMatch(run.stdout + run.stderr, new RegExp(MARKER));
  assert.match(run.stdout, /removed 22/);
});

test("the toggle is idempotent and ask restores the same rules", () => {
  const place = places();
  toggle(place, "answer");
  const once = readFileSync(place.settings, "utf8");
  const again = toggle(place, "answer");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(place.settings, "utf8"), once);
  assert.equal(backups(place).length, 1);
  const back = toggle(place, "ask");
  assert.equal(back.status, 0, back.stderr);
  assert.deepEqual(new Set(read(place.settings).permissions.ask), new Set([...OTHER, ...KIT_PUBLISH_ASK_RULES]));
  assert.equal(read(place.settings).permissions.ask.length, 24);
  assert.deepEqual(read(place.settings).permissions.deny, [SSH_DENY]);
  assert.equal(loadConfig(place.profile).gates.publishApproval, "ask");
  assert.deepEqual(read(join(place.profile, "config.json")).gates, { noComments: true });
  assert.equal(statSync(place.settings).mode & 0o777, 0o600);
  assert.equal(backups(place).length, 2);
  toggle(place, "ask");
  assert.equal(backups(place).length, 2);
  assert.match(toggle(place).stdout, /publish approval: ask/);
});

test("answer denies edits to session transcripts only, and ask takes that back, writing only on a change", () => {
  assert.equal(TRANSCRIPT_EDIT_DENY, "Edit(~/.claude/projects/**/*.jsonl)");
  const place = places({ rules: [...KIT_PUBLISH_ASK_RULES], deny: null });
  toggle(place, "answer");
  assert.deepEqual(read(place.settings).permissions.deny, [TRANSCRIPT_EDIT_DENY]);
  assert.deepEqual(read(place.settings).permissions.ask, []);
  assert.match(toggle(place).stdout, /transcript edit deny: on/);
  const ruleOnly = places({ rules: [], deny: [] });
  assert.equal(toggle(ruleOnly, "answer").status, 0);
  assert.deepEqual(read(ruleOnly.settings).permissions.deny, [TRANSCRIPT_EDIT_DENY]);
  assert.equal(backups(ruleOnly).length, 1);
  assert.equal(statSync(ruleOnly.settings).mode & 0o777, 0o600);
  toggle(ruleOnly, "answer");
  assert.equal(backups(ruleOnly).length, 1);
  toggle(ruleOnly, "ask");
  assert.equal("deny" in read(ruleOnly.settings).permissions, false);
  assert.deepEqual(read(ruleOnly.settings).permissions.ask, KIT_PUBLISH_ASK_RULES);
  assert.match(toggle(ruleOnly).stdout, /transcript edit deny: off/);
  toggle(place, "ask");
  assert.equal("deny" in read(place.settings).permissions, false);
});

test("a settings file with no ask rules gains them in ask mode, and gh pr merge survives both ways", () => {
  const place = places({ rules: ["Bash(gh pr merge*)"] });
  toggle(place, "ask");
  assert.deepEqual(read(place.settings).permissions.ask, ["Bash(gh pr merge*)", ...KIT_PUBLISH_ASK_RULES]);
  toggle(place, "answer");
  assert.deepEqual(read(place.settings).permissions.ask, ["Bash(gh pr merge*)"]);
});

test("the toggle refuses without a config.json, a valid config, a readable settings file or a known mode, and writes nothing", () => {
  for (const [place, args, message] of [
    [places({ config: null }), ["answer"], /profile\.mjs init/],
    [places({ config: { gates: { publishApproval: "maybe" } } }), ["answer"], /gates\.publishApproval must be "ask" or "answer"/],
    [places(), ["sometimes"], /usage/],
  ]) {
    const before = readFileSync(place.settings, "utf8");
    const run = toggle(place, ...args);
    assert.notEqual(run.status, 0, args.join(" "));
    assert.match(run.stderr, message);
    assert.equal(readFileSync(place.settings, "utf8"), before);
    assert.equal(backups(place).length, 0);
  }
  const broken = places();
  writeFileSync(broken.settings, `{"env": {"TEDY_TOKEN": "${MARKER}"`);
  const run = toggle(broken, "answer");
  assert.notEqual(run.status, 0);
  assert.doesNotMatch(run.stdout + run.stderr, new RegExp(MARKER));
  assert.equal(loadConfig(broken.profile).gates.publishApproval, "ask");
});

test("the profile guard asks before the toggle changes the mode", () => {
  const profile = tempDir("tedy-toggle-guard-");
  const check = (command) => guard({ tool_name: "Bash", tool_input: { command }, cwd: "/" }, { profile, release: tempDir("tedy-toggle-release-") });
  assert.ok(check("node /k/plugin/scripts/profile.mjs publish-approval answer"));
  assert.ok(check("node /k/plugin/lib/profile.mjs publish-approval ask"));
  assert.equal(check("node /k/plugin/scripts/profile.mjs publish-approval"), null);
  assert.equal(check("node /k/plugin/scripts/profile.mjs doctor"), null);
});
