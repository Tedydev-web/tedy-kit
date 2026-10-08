import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listPending, parse, render, route, setStatus, slugOf, stamp } from "./handoff.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const map = {
  paths: ["/w/tonpass"],
  sessions: [
    { name: "PM - Family Wallet", role: "pm" },
    { name: "Dev TMA - Family Wallet", role: "dev", repos: ["tonpass-wallet-fe"] },
    { name: "Dev Admin - Family Wallet", role: "dev", repos: ["onedollar-wallet-admin-fe", "tonpass-wallet-admin-be"] },
  ],
};

test("route picks the only session of a role, or the one owning the repository", () => {
  assert.equal(route(map, "pm").name, "PM - Family Wallet");
  assert.equal(route(map, "dev", "tonpass-wallet-admin-be").name, "Dev Admin - Family Wallet");
  assert.throws(() => route(map, "dev"), /2 dev sessions .*--repo/);
  assert.throws(() => route(map, "review"), /no review session/);
});

test("a hand-off renders as a pending header plus body, and parses back", () => {
  const text = render({ to: "Dev TMA - Family Wallet", from: "PM - Family Wallet", title: "Fix the fake save toast", body: "Save shows a toast without calling the API.\n", created: "2026-10-08T01:00:00Z" });
  assert.deepEqual(parse(text), { to: "Dev TMA - Family Wallet", from: "PM - Family Wallet", status: "pending", created: "2026-10-08T01:00:00Z", title: "Fix the fake save toast" });
  assert.match(text, /\n\nSave shows a toast without calling the API\.\n$/);
});

test("status moves from pending to accepted to done, keeping one updated line", () => {
  const base = render({ to: "a", from: "b", title: "t", body: "x", created: "c" });
  const accepted = setStatus(base, "accepted", "t1");
  const done = setStatus(accepted, "done", "t2");
  assert.equal(parse(done).status, "done");
  assert.equal(parse(done).updated, "t2");
  assert.equal(done.split("\n").filter((line) => line.startsWith("updated: ")).length, 1);
});

test("listPending returns only pending hand-offs, optionally for one session", () => {
  const dir = tempDir("tedy-handoff-");
  writeFileSync(join(dir, "handoff-1.md"), render({ to: "Dev TMA - Family Wallet", from: "PM - Family Wallet", title: "one", body: "x", created: "c" }));
  writeFileSync(join(dir, "handoff-2.md"), setStatus(render({ to: "Dev TMA - Family Wallet", from: "PM", title: "two", body: "x", created: "c" }), "done", "t"));
  writeFileSync(join(dir, "handoff-3.md"), render({ to: "PM - Family Wallet", from: "Dev", title: "three", body: "x", created: "c" }));
  writeFileSync(join(dir, "review-x.md"), "not a hand-off");
  assert.deepEqual(listPending(dir).map((item) => item.title).sort(), ["one", "three"]);
  assert.deepEqual(listPending(dir, "PM - Family Wallet").map((item) => item.title), ["three"]);
  assert.deepEqual(listPending(join(dir, "missing")), []);
});

test("slugs fold Vietnamese and stamps follow yymmdd-hhmm", () => {
  assert.equal(slugOf("Sửa toast giả ở Đổi tên"), "sua-toast-gia-o-doi-ten");
  assert.equal(stamp(new Date(2026, 9, 8, 9, 5)), "261008-0905");
});
