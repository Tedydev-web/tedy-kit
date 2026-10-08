import { test } from "node:test";
import assert from "node:assert/strict";
import { addSlugs, buildPayload, forgetSlugs, isoDuration, matchName, mergeDescription, mergePayload, planWrites, recordLastApply, setPayload } from "./openproject-client.mjs";

test("estimates become ISO 8601 durations", () => {
  assert.equal(isoDuration(2), "PT2H");
  assert.equal(isoDuration(1.5), "PT1H30M");
  assert.equal(isoDuration(0.25), "PT0H15M");
});

test("a draft becomes an OpenProject payload with markdown, type, assignee, parent and manual dates", () => {
  const refs = { types: { task: "/api/v3/types/1" }, assignees: [{ name: "Hoàng Lâm", href: "/api/v3/users/7" }] };
  const draft = { slug: "task-fe-x", type: "Task", subject: "[FE] X", description: "## Goal\nX.", estimate: 1.5, assignee: "Lâm", startDate: "2026-10-08", dueDate: "2026-10-08", parent: 21270 };
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
  const people = [{ name: "Hoàng Lâm" }, { name: "Phan Bình" }, { name: "Phan Hiếu" }];
  assert.equal(matchName(people, "lam").name, "Hoàng Lâm");
  assert.throws(() => matchName(people, "Phan"), /2 people/);
  assert.throws(() => matchName(people, "Kim"), /no assignee/);
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

test("a draft with an id updates a work package the sidecar does not know yet, and adopts its slug on apply", () => {
  const mapping = { "task-a": 101 };
  assert.deepEqual(planWrites([{ slug: "task-c", id: 21185 }, { slug: "task-a", id: 101 }], mapping), [
    { slug: "task-c", action: "update", id: 21185, adopt: true },
    { slug: "task-a", action: "update", id: 101 },
  ]);
  assert.throws(() => planWrites([{ slug: "task-a", id: 202 }], mapping), /maps to #101 in the sidecar, not #202/);
});

test("addSlugs appends new keys in pg-project-management's format and keeps meta keys untouched", () => {
  const before = JSON.stringify({ _relations: [], _merged: { "epic-a": 1 }, "epic-a": 1, _last_apply: "2026-10-05" }, null, 2);
  const after = addSlugs(before, { "task-b": 2, "epic-a": 1 });
  assert.equal(after, JSON.stringify({ _relations: [], _merged: { "epic-a": 1 }, "epic-a": 1, _last_apply: "2026-10-05", "task-b": 2 }, null, 2));
  assert.equal(after.endsWith("\n"), false);
  assert.throws(() => addSlugs(before, { "epic-a": 9 }), /already maps to 1/);
});

test("a draft with merge adopts an existing work package, whatever the sidecar says about its slug", () => {
  assert.deepEqual(planWrites([{ slug: "task-m", merge: 21300 }], { "task-m": 21300 }), [{ slug: "task-m", action: "merge", id: 21300, adopt: true }]);
  assert.deepEqual(planWrites([{ slug: "task-n", merge: 21301 }], {}), [{ slug: "task-n", action: "merge", id: 21301, adopt: true }]);
  assert.throws(() => planWrites([{ slug: "task-m", merge: 21302 }], { "task-m": 21300 }), /maps to #21300 in the sidecar, not #21302/);
  assert.throws(() => planWrites([{ slug: "task-x", merge: 1, id: 2 }], {}), /either id or merge/);
});

test("merging keeps the existing description and appends only new checklist lines under a dated header", () => {
  const old = "## Goal\nShow it.\n\n## AC\n- [x] Shows the [Home](https://f/1) section.\n- [ ] Free plan stops at 3.";
  const draft = "## Goal\nOther words.\n\n## AC\n- [ ] Shows the Home section\n- [ ] Pro plan has no limit.\n- [ ] Pro plan has no limit.";
  const merged = mergeDescription(old, draft, "2026-10-08");
  assert.equal(merged, `${old}\n\n## Added 2026-10-08\n- [ ] Pro plan has no limit.`);
  assert.equal(mergeDescription(old, "## AC\n- [ ] Free plan stops at 3", "2026-10-08"), old);
  assert.equal(mergeDescription("  ", draft, "2026-10-08"), draft);
});

test("a merge payload sends only what changes: new lines, and an estimate only when there is none", () => {
  const current = { lockVersion: 7, estimatedTime: "PT2H", description: { raw: "## AC\n- [ ] A." } };
  assert.deepEqual(mergePayload(current, { description: "## AC\n- [ ] B.", estimate: 1 }, "2026-10-08"), {
    lockVersion: 7,
    description: { format: "markdown", raw: "## AC\n- [ ] A.\n\n## Added 2026-10-08\n- [ ] B." },
  });
  assert.deepEqual(mergePayload({ ...current, estimatedTime: null }, { description: "## AC\n- [ ] A.", estimate: 1.5 }, "2026-10-08"), { lockVersion: 7, estimatedTime: "PT1H30M" });
});

test("the last apply is recorded in pg-project-management's format, and rolled-back slugs can be forgotten", () => {
  const before = JSON.stringify({ _relations: [], _merged: {}, "task-a": 1, "task-b": 2 }, null, 2);
  const recorded = recordLastApply(before, "2026-10-08T11:00:00", [2]);
  assert.deepEqual(JSON.parse(recorded)._last_apply, { at: "2026-10-08T11:00:00", created: [2] });
  assert.ok(recorded.indexOf('"task-b"') < recorded.indexOf('"_last_apply"'));
  const forgotten = forgetSlugs(recorded, [2], []);
  assert.deepEqual(Object.keys(JSON.parse(forgotten)), ["_relations", "_merged", "task-a"]);
  assert.deepEqual(JSON.parse(forgetSlugs(recorded, [], [2]))._last_apply.created, [2]);
});

test("a quick set builds a PATCH with only the named fields and the lock it was previewed at", () => {
  const refs = {
    statuses: [{ name: "In progress", _links: { self: { href: "/api/v3/statuses/7" } } }],
    priorities: [{ name: "High", _links: { self: { href: "/api/v3/priorities/9" } } }],
    assignees: [{ name: "Hoàng Lâm", href: "/api/v3/users/7" }],
  };
  assert.deepEqual(setPayload(5, { status: "in progress", assignee: "Lam", priority: "High", estimate: 2.5 }, refs), {
    lockVersion: 5,
    estimatedTime: "PT2H30M",
    _links: { status: { href: "/api/v3/statuses/7" }, assignee: { href: "/api/v3/users/7" }, priority: { href: "/api/v3/priorities/9" } },
  });
  assert.deepEqual(setPayload(5, { estimate: 1 }, refs), { lockVersion: 5, estimatedTime: "PT1H" });
  assert.throws(() => setPayload(5, { status: "Done" }, refs), /status "Done" does not exist/);
  assert.throws(() => setPayload(5, {}, refs), /nothing to set/);
});
