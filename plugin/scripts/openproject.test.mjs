import { test } from "node:test";
import assert from "node:assert/strict";
import { addSlugs, buildPayload, isoDuration, matchName, planWrites } from "./openproject-client.mjs";

test("estimates become ISO 8601 durations", () => {
  assert.equal(isoDuration(2), "PT2H");
  assert.equal(isoDuration(1.5), "PT1H30M");
  assert.equal(isoDuration(0.25), "PT0H15M");
});

test("a draft becomes an OpenProject payload with markdown, type, assignee, parent and manual dates", () => {
  const refs = { types: { task: "/api/v3/types/1" }, assignees: [{ name: "Hoàng Phúc", href: "/api/v3/users/7" }] };
  const draft = { slug: "task-fe-x", type: "Task", subject: "[FE] X", description: "## Goal\nX.", estimate: 1.5, assignee: "Phúc", startDate: "2026-10-08", dueDate: "2026-10-08", parent: 21270 };
  assert.deepEqual(buildPayload(draft, refs), {
    subject: "[FE] X",
    description: { format: "markdown", raw: "## Goal\nX." },
    estimatedTime: "PT1H30M",
    startDate: "2026-10-08",
    dueDate: "2026-10-08",
    scheduleManually: true,
    _links: { type: { href: "/api/v3/types/1" }, assignee: { href: "/api/v3/users/7" }, parent: { href: "/api/v3/work_packages/21270" } },
  });
  assert.equal(buildPayload(draft, refs, 4).lockVersion, 4);
  assert.throws(() => buildPayload({ ...draft, type: "Spike" }, refs), /type "Spike"/);
});

test("names match without diacritics and must be unique", () => {
  const people = [{ name: "Hoàng Phúc" }, { name: "Phan Tín" }, { name: "Phan Hiếu" }];
  assert.equal(matchName(people, "phuc").name, "Hoàng Phúc");
  assert.throws(() => matchName(people, "Phan"), /2 people/);
  assert.throws(() => matchName(people, "Tân"), /no assignee/);
});

test("planWrites updates mapped slugs, creates the rest and refuses meta keys", () => {
  const mapping = { _relations: [], _merged: {}, "task-a": 101 };
  assert.deepEqual(planWrites([{ slug: "task-a" }, { slug: "task-b" }], mapping), [
    { slug: "task-a", action: "update", id: 101 },
    { slug: "task-b", action: "create", id: null },
  ]);
  assert.throws(() => planWrites([{ slug: "_merged" }], mapping), /reserved/);
  assert.throws(() => planWrites([{ slug: "x" }, { slug: "x" }], mapping), /duplicate/);
});

test("addSlugs appends new keys in pg-project-management's format and keeps meta keys untouched", () => {
  const before = JSON.stringify({ _relations: [], _merged: { "epic-a": 1 }, "epic-a": 1, _last_apply: "2026-10-05" }, null, 2);
  const after = addSlugs(before, { "task-b": 2, "epic-a": 1 });
  assert.equal(after, JSON.stringify({ _relations: [], _merged: { "epic-a": 1 }, "epic-a": 1, _last_apply: "2026-10-05", "task-b": 2 }, null, 2));
  assert.equal(after.endsWith("\n"), false);
  assert.throws(() => addSlugs(before, { "epic-a": 9 }), /already maps to 1/);
});
