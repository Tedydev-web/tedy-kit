import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrateStates, readState, writeState } from "../lib/project-state.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const SCRIPT = new URL("../lib/project-state.mjs", import.meta.url).pathname;
const mapFile = (data) => `# Map\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;

test("a field written for a map reads back, and other fields stay untouched", () => {
  const dir = tempDir("tedy-state-");
  assert.deepEqual(readState("alpha", dir), {});
  writeState("alpha", "last_reply_check", "2026-10-08T06:30:00Z", dir);
  writeState("alpha", "learned_until", "2026-10-07", dir);
  writeState("alpha", "last_reply_check", "2026-10-08T08:10:00Z", dir);
  assert.deepEqual(readState("alpha", dir), { last_reply_check: "2026-10-08T08:10:00Z", learned_until: "2026-10-07" });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "projects", "alpha.json"), "utf8")), readState("alpha", dir));
});

test("an unknown field or a malformed value is refused", () => {
  const dir = tempDir("tedy-state-");
  assert.throws(() => writeState("alpha", "sessions", "x", dir), /unknown state field "sessions"/);
  assert.throws(() => writeState("alpha", "last_reply_check", "yesterday", dir), /last_reply_check must be an ISO timestamp/);
  assert.throws(() => writeState("alpha", "learned_until", "2026-10-07 10:00", dir), /learned_until must be a date \(YYYY-MM-DD\) or an ISO timestamp/);
  assert.throws(() => writeState("alpha", "learn_held", "2026-10-08T00:00:00Z", dir), /learn_held must be a date/);
  assert.throws(() => writeState("../escape", "learned_until", "2026-10-08", dir), /map name/);
});

test("the learn marker takes a date or an ISO timestamp, and the nudge marks take a date", () => {
  const dir = tempDir("tedy-state-");
  writeState("alpha", "learned_until", "2026-10-07", dir);
  writeState("alpha", "learned_until", "2026-10-18T13:10:00+07:00", dir);
  writeState("alpha", "learn_nudged", "2026-10-18", dir);
  writeState("alpha", "learn_held", "2026-10-18", dir);
  assert.deepEqual(readState("alpha", dir), { learned_until: "2026-10-18T13:10:00+07:00", learn_nudged: "2026-10-18", learn_held: "2026-10-18" });
});

test("migrate copies the timestamps a map still carries, skips nulls and never overwrites a newer state", () => {
  const dir = tempDir("tedy-state-");
  writeState("beta", "last_reply_check", "2026-10-09T00:00:00Z", dir);
  const maps = [
    { file: "/p/alpha.md", map: { name: "alpha", learned_until: "2026-10-07", last_reply_check: "2026-10-08T06:30:00Z" } },
    { file: "/p/beta.md", map: { name: "beta", learned_until: "2026-10-07", last_reply_check: "2026-10-08T06:30:00Z" } },
    { file: "/p/gamma.md", map: { name: "gamma", learned_until: null, last_reply_check: null } },
  ];
  assert.deepEqual(migrateStates(maps, dir), ["alpha.last_reply_check", "alpha.learned_until", "beta.learned_until"]);
  assert.deepEqual(readState("beta", dir), { last_reply_check: "2026-10-09T00:00:00Z", learned_until: "2026-10-07" });
  assert.deepEqual(readState("gamma", dir), {});
  assert.deepEqual(migrateStates(maps, dir), []);
});

test("the command finds the map from the working directory and keeps state out of the profile", () => {
  const profile = tempDir("tedy-state-profile-");
  const state = tempDir("tedy-state-dir-");
  const work = tempDir("tedy-state-work-");
  mkdirSync(join(profile, "projects"));
  writeFileSync(join(profile, "projects", "alpha.md"), mapFile({ name: "alpha", paths: [work] }));
  const env = { ...process.env, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: state };
  const run = (...args) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8", env, cwd: work });
  assert.equal(run("get", "last_reply_check").stdout, "");
  assert.equal(run("set", "last_reply_check", "2026-10-08T08:10:00Z").status, 0);
  assert.equal(run("get", "last_reply_check").stdout, "2026-10-08T08:10:00Z\n");
  assert.deepEqual(JSON.parse(readFileSync(join(state, "projects", "alpha.json"), "utf8")), { last_reply_check: "2026-10-08T08:10:00Z" });
  const outside = spawnSync("node", [SCRIPT, "get", "last_reply_check"], { encoding: "utf8", env, cwd: state });
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /no project map covers/);
  assert.equal(spawnSync("node", [SCRIPT, "get", "learned_until", "--map", "alpha"], { encoding: "utf8", env, cwd: state }).status, 0);
});
