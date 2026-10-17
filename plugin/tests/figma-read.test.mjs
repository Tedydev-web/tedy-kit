import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactFrames, diffSnapshots, subtreeHash, versionsSince } from "../lib/figma-read.mjs";

const box = (x, y) => ({ x, y, width: 375, height: 812 });

test("versionsSince keeps versions created at or after the mark, and all of them without one", () => {
  const versions = [{ id: "3", created_at: "2026-10-14T08:00:00Z" }, { id: "2", created_at: "2026-10-13T00:00:00Z" }, { id: "1", created_at: "2026-10-12T23:59:59Z" }];
  assert.deepEqual(versionsSince(versions, "2026-10-13T00:00:00Z").map((version) => version.id), ["3", "2"]);
  assert.equal(versionsSince(versions).length, 3);
});

test("a frame's hash ignores its own name and where it sits on the canvas, but not what is inside it", () => {
  const frame = (name, x, label) => ({ id: "1:1", name, type: "FRAME", absoluteBoundingBox: box(x, 0), children: [{ id: "1:2", type: "TEXT", characters: label, absoluteBoundingBox: { x: x + 16, y: 20, width: 40, height: 20 } }] });
  const base = subtreeHash(frame("Home", 0, "Send"));
  assert.equal(subtreeHash(frame("Home v2", 0, "Send")), base);
  assert.equal(subtreeHash(frame("Home", 900, "Send")), base);
  assert.notEqual(subtreeHash(frame("Home", 0, "Receive")), base);
});

test("compactFrames lists frame-like nodes down to the depth limit, under their page", () => {
  const pages = [
    {
      name: "Ledger",
      children: [
        { id: "1:1", name: "Section", type: "SECTION", absoluteBoundingBox: box(0, 0), children: [{ id: "1:2", name: "List", type: "FRAME", absoluteBoundingBox: box(0, 0), children: [{ id: "1:3", name: "Row", type: "FRAME", absoluteBoundingBox: box(0, 0) }] }] },
        { id: "1:9", name: "Note", type: "TEXT", characters: "x" },
      ],
    },
  ];
  const frames = compactFrames(pages, 3);
  assert.deepEqual(Object.keys(frames), ["1:1", "1:2"]);
  assert.deepEqual({ ...frames["1:2"], hash: undefined }, { name: "List", page: "Ledger", type: "FRAME", hash: undefined });
  assert.match(frames["1:2"].hash, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(compactFrames(pages, 4)), ["1:1", "1:2", "1:3"]);
});

test("diffSnapshots reports added, removed, renamed and changed frames with page and name", () => {
  const before = { frames: { a: { name: "Home", page: "P", hash: "1" }, b: { name: "Old", page: "P", hash: "2" }, c: { name: "Gone", page: "P", hash: "3" }, d: { name: "Same", page: "P", hash: "4" } } };
  const after = { frames: { a: { name: "Home", page: "P", hash: "9" }, b: { name: "New", page: "Q", hash: "2" }, d: { name: "Same", page: "P", hash: "4" }, e: { name: "Fresh", page: "P", hash: "5" } } };
  assert.deepEqual(diffSnapshots(before, after), ["changed  a P / Home", "renamed  b P / Old → Q / New", "added    e P / Fresh", "removed  c P / Gone"]);
  assert.deepEqual(diffSnapshots(before, before), []);
});
