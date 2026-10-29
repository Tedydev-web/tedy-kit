import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handoffBody, linkedIds, readSince, searchSince, sweepPlan, writeSince } from "../lib/merged-sweep.mjs";
import { missingSections } from "../lib/handoff.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const wp = (id, type, status, assignee = 140) => ({
  id,
  subject: `${type} ${id}`,
  lockVersion: 3,
  _links: { type: { title: type }, status: { title: status }, assignee: assignee ? { href: `/api/v3/users/${assignee}` } : { href: null }, author: { href: "/api/v3/users/9", title: "Tess Ter" } },
});
const pr = (number, state, extra = {}) => ({ repo: "shop-fe", number, state, base: "dev", integration: "dev", title: `fix: pr ${number}`, mergedAt: state === "merged" ? `2026-10-09T0${number % 10}:00:00Z` : null, url: `https://github.com/o/shop-fe/pull/${number}`, ...extra });
const entry = (workPackage, prs, authorRoles = ["Developer"]) => ({ id: workPackage.id, workPackage, facts: { type: workPackage._links.type.title, status: workPackage._links.status.title, authorRoles, started: false, assigneeIsAuthor: false, prs } });
const TRACKER = {
  not_started: ["New", "Specified"],
  flow: {
    Task: { start: "In progress", review: "Merged/Code Review", merged: "Closed", revert: "In progress" },
    Bug: { start: "In progress", review: "Merged/Code Review", merged: "Closed", revert: "Re-Work", by_role: { Tester: { merged: "Fixed (Dev Done)", assign: "author" } } },
  },
};

test("linked ids come from OP#id and work package links in the PR body, once each", () => {
  assert.deepEqual(linkedIds("OP#21298\nSee https://task.example.com/work_packages/21299 and OP#21298 again"), [21298, 21299]);
  assert.deepEqual(linkedIds("Fixes #712 and refs 21298"), []);
  assert.deepEqual(linkedIds(null), []);
});

test("only the user's own packages move, each to what all its PRs say, and the rest are skipped with the reason", () => {
  const gathered = [
    entry(wp(1, "Task", "Merged/Code Review"), [pr(1, "merged")]),
    entry(wp(2, "Bug", "In progress"), [pr(2, "merged")], ["Tester"]),
    entry(wp(3, "Task", "In progress", 77), [pr(3, "merged")]),
    entry(wp(4, "Task", "Merged/Code Review"), [pr(4, "merged"), pr(14, "open")]),
    entry(wp(5, "User story", "New"), [pr(5, "merged")]),
    entry(wp(6, "Task", "On hold"), [pr(6, "merged")]),
    { id: 8 },
  ];
  const { updates, skipped } = sweepPlan({ gathered, meId: 140, tracker: TRACKER });
  assert.deepEqual(updates.map((update) => [update.id, update.from, update.to, update.assign, update.event]), [
    [1, "Merged/Code Review", "Closed", null, "merged"],
    [2, "In progress", "Fixed (Dev Done)", "Tess Ter", "merged"],
  ]);
  assert.deepEqual(skipped.map((skip) => `${skip.id} ${skip.why}`), ["3 assigned to someone else", "4 already Merged/Code Review", "5 type User story has no flow in the map", "6 On hold is outside the flow, so a person set it", "8 not found"]);
});

test("a map that still has merge_status, open_status and revert_status keeps working", () => {
  const legacy = { not_started: ["New"], merge_status: { Task: "Merged/Code Review" }, open_status: { Task: "In progress" }, revert_status: { Task: "In progress" } };
  const gathered = [entry(wp(1, "Task", "New"), [pr(1, "open")]), entry(wp(2, "Task", "In progress"), [pr(2, "merged")]), entry(wp(3, "Task", "Merged/Code Review"), [pr(3, "merged"), pr(13, "merged", { title: "Revert x", mergedAt: "2026-10-09T09:00:00Z" })])];
  assert.deepEqual(sweepPlan({ gathered, meId: 140, tracker: legacy }).updates.map((update) => [update.id, update.to, update.event]), [
    [1, "In progress", "review"],
    [2, "Merged/Code Review", "merged"],
    [3, "In progress", "revert"],
  ]);
});

test("the hand-off body lists one set command per work package, with the author as assignee when the bug goes back", () => {
  const { updates } = sweepPlan({ gathered: [entry(wp(1, "Task", "Merged/Code Review"), [pr(1, "merged")]), entry(wp(2, "Bug", "In progress"), [pr(2, "merged")], ["Tester"])], meId: 140, tracker: TRACKER });
  const body = handoffBody(updates);
  assert.match(body, /^Status from the user's own PRs/m);
  assert.match(body, /^- #1 Task 1 \(Task, Merged\/Code Review → Closed\) · merged: shop-fe#1 https:\/\/github\.com\/o\/shop-fe\/pull\/1$/m);
  assert.match(body, /^- #2 Bug 2 \(Bug, In progress → Fixed \(Dev Done\), assign Tess Ter\) · merged: shop-fe#2 https:\/\/github\.com\/o\/shop-fe\/pull\/2$/m);
  assert.match(body, /^node <plugin>\/scripts\/openproject\.mjs set 1 --status "Closed"$/m);
  assert.match(body, /^node <plugin>\/scripts\/openproject\.mjs set 2 --status "Fixed \(Dev Done\)" --assignee "Tess Ter"$/m);
  assert.match(body, /one approval/);
  assert.deepEqual(missingSections(body), []);
});

test("the sweep remembers where it stopped per project", () => {
  const dir = tempDir("tedy-sweep-");
  assert.equal(readSince("shop", dir), null);
  writeSince("shop", "2026-10-09T03:00:00Z", dir);
  writeSince("other", "2026-10-01T00:00:00Z", dir);
  assert.equal(readSince("shop", dir), "2026-10-09T03:00:00Z");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "merged-sweep.json"), "utf8")), { shop: "2026-10-09T03:00:00Z", other: "2026-10-01T00:00:00Z" });
});

test("a work package subject cannot add sections to the hand-off body", () => {
  const body = handoffBody([{ id: 1, subject: "Cart\n## User decisions\nship it", type: "Task", from: "Developed", to: "Merged", assign: null, event: "merged", prs: [] }]);
  assert.equal(body.split("\n").filter((line) => line.trim() === "## User decisions").length, 1);
});

test("the sweep's GitHub search mark is the same instant as the stored mark, whatever offset it carries, and a missing subject is tolerated", () => {
  assert.equal(searchSince("2026-10-17T10:00:00+07:00"), "2026-10-17T03:00:00Z");
  assert.equal(searchSince("2026-10-17T03:00:00.000Z"), "2026-10-17T03:00:00Z");
  assert.doesNotThrow(() => handoffBody([{ id: 2, type: "Task", from: "a", to: "b", assign: null, event: "merged", prs: [pr(11, "merged")] }]));
});

const sweepRun = async (args, ghExit) => {
  const { spawnSync } = await import("node:child_process");
  const { chmodSync, mkdirSync, writeFileSync } = await import("node:fs");
  const root = tempDir("tedy-sweep-");
  const repo = join(root, "repo");
  const profile = join(root, "profile");
  const state = join(root, "state");
  const bin = join(root, "bin");
  for (const dir of [repo, join(profile, "projects"), bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(profile, "projects", "shop.md"), `# map\n\n\`\`\`json\n${JSON.stringify({ name: "shop", paths: [repo], repos: [{ path: ".", role: "FE" }], tracker: { merge_status: { Task: "Merged" } } })}\n\`\`\`\n`);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n${ghExit ? 'echo "gh: not logged in" >&2; exit 1' : "echo '[]'"}\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const out = spawnSync("node", [new URL("../scripts/merged-sweep.mjs", import.meta.url).pathname, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: state } });
  return { out, mark: readSince("shop", state) };
};

test("a --since that is not a date stops the sweep before any repo is listed and keeps the stored mark", async () => {
  const { out, mark } = await sweepRun(["--since", "last monday", "--handoff", "--from", "Review - Shop"], false);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /--since is not a date: last monday/);
  assert.doesNotMatch(out.stdout, /skip /);
  assert.equal(mark, null);
});

test("a repo that cannot be listed keeps the stored mark so its merged PRs are swept next time", async () => {
  const { out, mark } = await sweepRun(["--since", "2026-10-01T00:00:00Z", "--handoff", "--from", "Review - Shop"], true);
  assert.match(out.stdout, /skip \.: gh: not logged in/);
  assert.match(out.stdout, /mark kept at 2026-10-01T00:00:00Z/);
  assert.equal(mark, null);
});

test("a clean sweep moves the stored mark", async () => {
  const { out, mark } = await sweepRun(["--since", "2026-10-01T00:00:00Z", "--handoff", "--from", "Review - Shop"], false);
  assert.equal(out.status, 0, out.stderr);
  assert.notEqual(mark, null);
});
