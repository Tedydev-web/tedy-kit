import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listPending, parse, render, route, setStatus, slugOf, stamp } from "../lib/handoff.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const map = {
  paths: ["/w/acme"],
  sessions: [
    { name: "PM - Shop", role: "pm" },
    { name: "Dev TMA - Shop", role: "dev", repos: ["acme-shop-fe"] },
    { name: "Dev Admin - Shop", role: "dev", repos: ["onedollar-wallet-admin-fe", "acme-shop-admin-be"] },
  ],
};

test("route picks the only session of a role, or the one owning the repository", () => {
  assert.equal(route(map, "pm").name, "PM - Shop");
  assert.equal(route(map, "dev", "acme-shop-admin-be").name, "Dev Admin - Shop");
  assert.throws(() => route(map, "dev"), /2 dev sessions .*--repo/);
  assert.throws(() => route(map, "review"), /no review session/);
});

test("a hand-off renders as a pending header plus body, and parses back", () => {
  const text = render({ to: "Dev TMA - Shop", from: "PM - Shop", title: "Fix the fake save toast", body: "Save shows a toast without calling the API.\n", created: "2026-10-08T01:00:00Z" });
  assert.deepEqual(parse(text), { to: "Dev TMA - Shop", from: "PM - Shop", status: "pending", created: "2026-10-08T01:00:00Z", title: "Fix the fake save toast" });
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
  writeFileSync(join(dir, "handoff-1.md"), render({ to: "Dev TMA - Shop", from: "PM - Shop", title: "one", body: "x", created: "c" }));
  writeFileSync(join(dir, "handoff-2.md"), setStatus(render({ to: "Dev TMA - Shop", from: "PM", title: "two", body: "x", created: "c" }), "done", "t"));
  writeFileSync(join(dir, "handoff-3.md"), render({ to: "PM - Shop", from: "Dev", title: "three", body: "x", created: "c" }));
  writeFileSync(join(dir, "review-x.md"), "not a hand-off");
  assert.deepEqual(listPending(dir).map((item) => item.title).sort(), ["one", "three"]);
  assert.deepEqual(listPending(dir, "PM - Shop").map((item) => item.title), ["three"]);
  assert.deepEqual(listPending(join(dir, "missing")), []);
});

test("slugs fold Vietnamese and stamps follow yymmdd-hhmm", () => {
  assert.equal(slugOf("Sửa toast giả ở Đổi tên"), "sua-toast-gia-o-doi-ten");
  assert.equal(stamp(new Date(2026, 9, 8, 9, 5)), "261008-0905");
});

test("the message for the receiving session starts with Hand-off in every language", async () => {
  const { spawnSync } = await import("node:child_process");
  const { profileWith } = await import("./temp-dir-for-tests.mjs");
  const work = tempDir("tedy-handoff-work-");
  const body = join(work, "body.md");
  writeFileSync(body, "x\n");
  const run = (chat) => {
    const profile = profileWith({ language: { chat } });
    mkdirSync(join(profile, "projects"));
    writeFileSync(join(profile, "projects", "shop.md"), `# Shop\n\n\`\`\`json\n${JSON.stringify({ name: "shop", paths: [work], sessions: [{ name: "Dev Web - Shop", role: "dev" }] })}\n\`\`\`\n`);
    return spawnSync("node", [new URL("../lib/handoff.mjs", import.meta.url).pathname, "write", "--to", "Dev Web - Shop", "--from", "PM - Shop", "--title", "Fix toast", "--body-file", body], { encoding: "utf8", cwd: work, env: { ...process.env, TEDY_PROFILE_DIR: profile } }).stdout;
  };
  assert.match(run("vi"), /^message: Hand-off từ PM - Shop: Fix toast\. File: .*\. Việc chuyển này đã được duyệt\.$/m);
  assert.match(run("en"), /^message: Hand-off from PM - Shop: Fix toast\. File: .*\. The user approved this hand-off\.$/m);
});
