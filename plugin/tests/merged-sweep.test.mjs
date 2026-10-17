import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handoffBody, linkedIds, pickUpdates, readSince, writeSince } from "../lib/merged-sweep.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const wp = (id, type, status, assignee = 140, closed = false) => ({
  id,
  subject: `${type} ${id}`,
  lockVersion: 3,
  _links: { type: { title: type }, status: { title: status }, assignee: assignee ? { href: `/api/v3/users/${assignee}` } : { href: null } },
  closed,
});
const pr = (number, body, extra = {}) => ({ repo: "shop-fe", number, title: `fix: pr ${number}`, body, mergedAt: "2026-10-09T02:00:00Z", url: `https://github.com/o/shop-fe/pull/${number}`, ...extra });
const targets = { merged: { Task: "Merged/Code Review", Bug: "Fixed (Dev Done)" } };

test("linked ids come from OP#id and work package links in the PR body, once each", () => {
  assert.deepEqual(linkedIds("OP#21298\nSee https://task.example.com/work_packages/21299 and OP#21298 again"), [21298, 21299]);
  assert.deepEqual(linkedIds("Fixes #712 and refs 21298"), []);
  assert.deepEqual(linkedIds(null), []);
});

test("only the user's own tasks and bugs that are not yet at their target status are picked", () => {
  const workPackages = new Map([
    [1, wp(1, "Task", "Developed")],
    [2, wp(2, "Bug", "New")],
    [3, wp(3, "Task", "In progress", 77)],
    [4, wp(4, "Task", "Merged/Code Review")],
    [5, wp(5, "User story", "New")],
    [6, wp(6, "Task", "Closed", 140, true)],
    [7, wp(7, "Task", "New", null)],
  ]);
  const prs = [pr(10, "OP#1 OP#3"), pr(11, "OP#2 OP#4 OP#5 OP#6 OP#7 OP#8")];
  const { updates, skipped } = pickUpdates({ prs, workPackages, meId: 140, targets });
  assert.deepEqual(updates.map((update) => [update.id, update.from, update.to, update.pr.number]), [
    [1, "Developed", "Merged/Code Review", 10],
    [2, "New", "Fixed (Dev Done)", 11],
  ]);
  assert.deepEqual(skipped.map((skip) => `${skip.id} ${skip.why}`), ["3 assigned to someone else", "4 already Merged/Code Review", "5 type User story has no merged status", "6 closed", "7 assigned to someone else", "8 not found"]);
});

test("a work package linked from two merged PRs is updated once, from the latest merge", () => {
  const workPackages = new Map([[1, wp(1, "Task", "Developed")]]);
  const prs = [pr(10, "OP#1", { mergedAt: "2026-10-09T01:00:00Z" }), pr(12, "OP#1", { mergedAt: "2026-10-09T03:00:00Z" })];
  assert.deepEqual(pickUpdates({ prs, workPackages, meId: 140, targets }).updates.map((update) => update.pr.number), [12]);
});

test("the hand-off body lists one set command per work package for the PM session to preview", () => {
  const body = handoffBody([{ id: 1, subject: "[FE] Cart limit pop-up", type: "Task", from: "Developed", to: "Merged/Code Review", pr: pr(10, "OP#1") }]);
  assert.match(body, /^Status from the user's own PRs/m);
  assert.match(body, /^- #1 \[FE\] Cart limit pop-up \(Task, Developed → Merged\/Code Review\) · merged in shop-fe#10 https:\/\/github\.com\/o\/shop-fe\/pull\/10 on 2026-10-09$/m);
  assert.match(body, /^node <plugin>\/scripts\/openproject\.mjs set 1 --status "Merged\/Code Review"$/m);
  assert.match(body, /one approval/);
});

test("an opened PR proposes the open status only for work not started; a revert proposes the revert status", () => {
  const all = { ...targets, open: { Task: "In progress", Bug: "In progress" }, revert: { Task: "In progress", Bug: "Re-Work" } };
  const workPackages = new Map([
    [1, wp(1, "Task", "New")],
    [2, wp(2, "Task", "Merged/Code Review")],
    [3, wp(3, "Bug", "Fixed (Dev Done)")],
    [4, wp(4, "Task", "Developed")],
  ]);
  const prs = [pr(20, "OP#1 OP#2", { mergedAt: null }), pr(21, "OP#3", { title: 'Revert "fix: x"' }), pr(22, "OP#4", { mergedAt: null }), pr(23, "OP#4")];
  const { updates, skipped } = pickUpdates({ prs, workPackages, meId: 140, targets: all, notStarted: ["New", "Specified", "Scheduled"] });
  assert.deepEqual(updates.map((update) => [update.id, update.to, update.pr.number]), [
    [1, "In progress", 20],
    [3, "Re-Work", 21],
    [4, "Merged/Code Review", 23],
  ]);
  assert.deepEqual(skipped.map((skip) => `${skip.id} ${skip.why}`), ["2 already started (Merged/Code Review)"]);
  assert.match(handoffBody(updates), /opened in shop-fe#20/);
  assert.match(handoffBody(updates), /reverted in shop-fe#21/);
});

test("the sweep remembers where it stopped per project", () => {
  const dir = tempDir("tedy-sweep-");
  assert.equal(readSince("shop", dir), null);
  writeSince("shop", "2026-10-09T03:00:00Z", dir);
  writeSince("other", "2026-10-01T00:00:00Z", dir);
  assert.equal(readSince("shop", dir), "2026-10-09T03:00:00Z");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "merged-sweep.json"), "utf8")), { shop: "2026-10-09T03:00:00Z", other: "2026-10-01T00:00:00Z" });
});
