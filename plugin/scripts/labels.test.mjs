import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { LABELS, fill, labels } from "./labels.mjs";
import { profileWith } from "./temp-dir-for-tests.mjs";

const SCRIPT = new URL("./labels.mjs", import.meta.url).pathname;

test("every language pack has exactly the keys of the English pack", () => {
  const keys = Object.keys(LABELS.en).sort();
  for (const [code, pack] of Object.entries(LABELS)) assert.deepEqual(Object.keys(pack).sort(), keys, code);
});

test("the Vietnamese pack keeps the labels the menus use today", () => {
  const vi = labels("vi");
  assert.equal(vi["approve.header"], "Duyệt");
  assert.equal(vi["post.asIs"], "Đăng nguyên bản (Recommended)");
  assert.equal(vi["next.header"], "Bước tiếp");
  assert.equal(vi["next.stop"], "Dừng ở đây");
  assert.equal(vi["readiness.missing"], "thiếu nặng");
});

test("an unknown language falls back to English, and placeholders are filled", () => {
  assert.equal(labels("fr")["next.header"], "Next step");
  assert.equal(fill(labels("en")["handoff.message"], { from: "PM", title: "Fix toast", path: "/p/h.md" }), "Hand-off from PM: Fix toast. File: /p/h.md. The user approved this hand-off.");
  assert.match(labels("vi")["handoff.message"], /^Hand-off /);
});

test("the command prints the table for the profile's chat language, or the one asked for", () => {
  const vi = spawnSync("node", [SCRIPT], { encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: profileWith({ language: { chat: "vi" } }) } });
  assert.equal(vi.status, 0);
  assert.match(vi.stdout, /^language: vi$/m);
  assert.match(vi.stdout, /^\| `approve\.header` \| Duyệt \|$/m);
  const en = spawnSync("node", [SCRIPT, "en"], { encoding: "utf8" });
  assert.match(en.stdout, /^\| `approve\.header` \| Approve \|$/m);
});
