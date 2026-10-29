import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { planStatus, statusEvent } from "../lib/status-flow.mjs";

const TRACKER = {
  not_started: ["New", "Confirmed"],
  flow: {
    Task: { start: "In progress", review: "Merged/Code Review", merged: "Closed", revert: "In progress" },
    Bug: { start: "In progress", review: "Merged/Code Review", merged: "Closed", revert: "Re-Work", by_role: { Tester: { merged: "Fixed (Dev Done)", assign: "author" } } },
  },
};
const pr = (number, state, fields = {}) => ({ number, state, base: "dev", integration: "dev", title: `feat: work ${number}`, mergedAt: state === "merged" ? `2026-10-2${number % 10}T00:00:00Z` : null, ...fields });
const facts = (fields) => ({ type: "Task", status: "New", authorRoles: ["Developer"], started: false, prs: [], assigneeIsAuthor: false, ...fields });

test("the event comes from the PRs into the integration branch: open wins over merged, a later revert wins, and starting needs no PR", () => {
  assert.equal(statusEvent(facts({ started: true })), "start");
  assert.equal(statusEvent(facts({})), null);
  assert.equal(statusEvent(facts({ prs: [pr(1, "open")] })), "review");
  assert.equal(statusEvent(facts({ prs: [pr(1, "merged"), pr(2, "open")] })), "review");
  assert.equal(statusEvent(facts({ prs: [pr(1, "merged"), pr(2, "merged")] })), "merged");
  assert.equal(statusEvent(facts({ prs: [pr(1, "merged"), pr(2, "closed")] })), "merged");
  assert.equal(statusEvent(facts({ prs: [pr(1, "merged", { base: "feature/x" })] })), null);
  assert.equal(statusEvent(facts({ prs: [pr(1, "open", { base: "feature/x" }), pr(2, "merged")] })), "merged");
  assert.equal(statusEvent(facts({ prs: [pr(1, "merged"), pr(5, "merged", { title: "Revert \"feat: work 1\"" })] })), "revert");
  assert.equal(statusEvent(facts({ prs: [pr(5, "merged", { title: "Revert \"feat: work 1\"" }), pr(7, "merged")] })), "merged");
});

test("a task moves forward through the flow and closes once every PR merged", () => {
  assert.deepEqual(planStatus(facts({ started: true }), TRACKER), { to: "In progress", assign: null, event: "start" });
  assert.deepEqual(planStatus(facts({ status: "In progress", prs: [pr(1, "open")] }), TRACKER), { to: "Merged/Code Review", assign: null, event: "review" });
  assert.deepEqual(planStatus(facts({ status: "Merged/Code Review", prs: [pr(1, "merged")] }), TRACKER), { to: "Closed", assign: null, event: "merged" });
  assert.deepEqual(planStatus(facts({ status: "New", prs: [pr(1, "merged")] }), TRACKER), { to: "Closed", assign: null, event: "merged" });
  assert.deepEqual(planStatus(facts({ status: "Merged/Code Review", prs: [pr(1, "merged"), pr(2, "open")] }), TRACKER), { skip: "already Merged/Code Review" });
});

test("a bug a tester filed goes to Fixed (Dev Done) and back to its author; one a developer filed closes", () => {
  const tester = { type: "Bug", authorRoles: ["Tester"], status: "Merged/Code Review", prs: [pr(1, "merged")] };
  assert.deepEqual(planStatus(facts(tester), TRACKER), { to: "Fixed (Dev Done)", assign: "author", event: "merged" });
  assert.deepEqual(planStatus(facts({ ...tester, status: "Fixed (Dev Done)", assigneeIsAuthor: true }), TRACKER), { skip: "already Fixed (Dev Done)" });
  assert.deepEqual(planStatus(facts({ ...tester, status: "Fixed (Dev Done)", assigneeIsAuthor: false }), TRACKER), { to: "Fixed (Dev Done)", assign: "author", event: "merged" });
  assert.deepEqual(planStatus(facts({ ...tester, authorRoles: ["Developer"] }), TRACKER), { to: "Closed", assign: null, event: "merged" });
});

test("a revert reopens even a closed package, and nothing else moves one backwards", () => {
  const reverted = [pr(1, "merged"), pr(5, "merged", { title: "Revert \"feat: work 1\"" })];
  assert.deepEqual(planStatus(facts({ status: "Closed", prs: reverted }), TRACKER), { to: "In progress", assign: null, event: "revert" });
  assert.deepEqual(planStatus(facts({ type: "Bug", authorRoles: ["Tester"], status: "Fixed (Dev Done)", prs: reverted }), TRACKER), { to: "Re-Work", assign: null, event: "revert" });
  assert.deepEqual(planStatus(facts({ status: "Closed", prs: [pr(1, "open")] }), TRACKER), { skip: "already past Merged/Code Review (Closed)" });
  assert.deepEqual(planStatus(facts({ status: "Merged/Code Review", started: true }), TRACKER), { skip: "already past In progress (Merged/Code Review)" });
});

test("a status outside the flow, a type without a flow, or no event is left alone with the reason", () => {
  assert.deepEqual(planStatus(facts({ status: "On hold", prs: [pr(1, "merged")] }), TRACKER), { skip: "On hold is outside the flow, so a person set it" });
  assert.deepEqual(planStatus(facts({ status: "Rejected", prs: [pr(1, "merged"), pr(5, "merged", { title: "Revert x" })] }), TRACKER), { skip: "Rejected is outside the flow, so a person set it" });
  assert.deepEqual(planStatus(facts({ type: "Epic", prs: [pr(1, "merged")] }), TRACKER), { skip: "type Epic has no flow in the map" });
  assert.deepEqual(planStatus(facts({}), TRACKER), { skip: "no PR into the integration branch and the work has not started" });
});
