import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_PUBLISH_ASK_RULES, retiredDenyRules } from "../lib/publish-approval-settings.mjs";
import { loadConfig } from "../lib/profile.mjs";
import { evaluate as guard } from "../gates/profile-guard-gate.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const RETIRED = retiredDenyRules();
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

test("ask restores the kit's 23 publish ask rules after a 600 backup, keeps every other key and drops an obsolete answer mode from the config", () => {
  const place = places({ config: { gates: { noComments: true, publishApproval: "answer" }, language: { chat: "vi" } }, rules: OTHER });
  const before = readFileSync(place.settings, "utf8");
  const run = toggle(place, "ask");
  assert.equal(run.status, 0, run.stderr);
  const after = read(place.settings);
  assert.deepEqual(after.permissions.ask, [...OTHER, ...KIT_PUBLISH_ASK_RULES]);
  assert.deepEqual(after.permissions.deny, [SSH_DENY]);
  assert.deepEqual({ ...after, permissions: { ...after.permissions, ask: null } }, { ...place.data, permissions: { ...place.data.permissions, ask: null } });
  assert.equal(statSync(place.settings).mode & 0o777, 0o600);
  const [backup] = backups(place);
  assert.equal(readFileSync(join(place.home, backup), "utf8"), before);
  assert.equal(statSync(join(place.home, backup)).mode & 0o777, 0o600);
  assert.deepEqual(read(join(place.profile, "config.json")).gates, { noComments: true });
  assert.equal(read(join(place.profile, "config.json")).language.chat, "vi");
  assert.doesNotMatch(run.stdout + run.stderr, new RegExp(MARKER));
  assert.match(run.stdout, /restored 23 kit publish ask rules, removed 0 retired deny rules/);
  assert.match(run.stdout, /removed the obsolete gates\.publishApproval "answer"/);
});

test("ask removes only the retired deny rule on the approval tickets, keeps the deny rules that guard the kit's records, is idempotent and writes only on a change", () => {
  const state = process.env.TEDY_STATE_DIR;
  assert.deepEqual(RETIRED, [`Edit(/${join(state, "approvals")}/**)`]);
  const kept = [`Edit(/${join(state, "pr-bodies")}/**)`, `Edit(/${join(state, "drafts")}/**)`, `Edit(/${join(state, "review-runs")}/**)`, `Edit(/${join(state, "drafts")}/*.sources.json)`];
  const place = places({ deny: [SSH_DENY, ...RETIRED, ...kept] });
  assert.match(toggle(place).stdout, new RegExp(`retired deny rules in .*: ${RETIRED.length}`));
  assert.equal(toggle(place, "ask").status, 0);
  assert.deepEqual(read(place.settings).permissions.deny, [SSH_DENY, ...kept]);
  assert.equal(backups(place).length, 1);
  const again = toggle(place, "ask");
  assert.match(again.stdout, /every kit publish ask rule is present and no retired deny rule is left, not written/);
  assert.equal(backups(place).length, 1);
  assert.match(toggle(place).stdout, /kit publish ask rules in .*: 23\/23\nretired deny rules in .*: 0/);
  const only = places({ deny: [RETIRED[0]] });
  toggle(only, "ask");
  assert.equal("deny" in read(only.settings).permissions, false);
});

test("publish-approval answer is refused as gone, and the toggle refuses without a config.json, a valid config or a readable settings file, writing nothing", () => {
  for (const [place, args, message, code] of [
    [places({ rules: [] }), ["answer"], /publish-approval answer is gone.*ADR 0022.*nothing was written/, 2],
    [places({ config: null, rules: [] }), ["ask"], /profile\.mjs init/, 1],
    [places({ config: { gates: { publishApproval: "maybe" } }, rules: [] }), ["ask"], /gates\.publishApproval is obsolete and, while it stays, must be "ask" or "answer"/, 1],
    [places(), ["sometimes"], /usage/, 2],
  ]) {
    const before = readFileSync(place.settings, "utf8");
    const run = toggle(place, ...args);
    assert.equal(run.status, code, args.join(" "));
    assert.match(run.stderr, message);
    assert.equal(readFileSync(place.settings, "utf8"), before);
    assert.equal(backups(place).length, 0);
  }
  const broken = places();
  writeFileSync(broken.settings, `{"env": {"TEDY_TOKEN": "${MARKER}"`);
  const run = toggle(broken, "ask");
  assert.notEqual(run.status, 0);
  assert.doesNotMatch(run.stdout + run.stderr, new RegExp(MARKER));
});

test("a config that still says answer loads with no publish approval mode left in the gates", () => {
  const place = places({ config: { gates: { publishApproval: "answer" } } });
  assert.equal("publishApproval" in loadConfig(place.profile).gates, false);
});

test("the profile guard asks before the toggle rewrites the settings", () => {
  const profile = tempDir("tedy-toggle-guard-");
  const check = (command) => guard({ tool_name: "Bash", tool_input: { command }, cwd: "/" }, { profile, release: tempDir("tedy-toggle-release-") });
  assert.ok(check("node /k/plugin/lib/profile.mjs publish-approval ask"));
  assert.equal(check("node /k/plugin/scripts/profile.mjs publish-approval"), null);
  assert.equal(check("node /k/plugin/scripts/profile.mjs doctor"), null);
});
