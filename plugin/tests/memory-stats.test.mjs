import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { layoutOverride, memoryStats, projectSlug } from "../lib/memory-stats.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const memory = (type, nested = true) => `---\nname: x\ndescription: y\n${nested ? `metadata:\n  type: ${type}` : `type: ${type}`}\n---\n\nbody\n`;

function put(path, content, when) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  if (when) utimesSync(path, when, when);
}

const local = (y, m, d, h = 12, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s);

function setup() {
  const root = tempDir("tedy-projects-");
  const work = tempDir("tedy-work-");
  const map = { name: "shop", paths: [work], repos: [{ path: "fe", role: "FE" }, { path: "be", role: "BE", readonly: true }] };
  const folder = (path) => join(root, projectSlug(path));
  return { root, work, map, folder };
}

test("a project slug turns every character outside letters and digits into a dash, as Claude Code names its project folders", () => {
  assert.equal(projectSlug("/a/b.c/d_e"), "-a-b-c-d-e");
  assert.equal(projectSlug("/srv/w/shop/shop-fe/.claude/worktrees/fix-12"), "-srv-w-shop-shop-fe--claude-worktrees-fix-12");
});

test("memories are read from the project folder and from every mapped repo's folder, readonly repos included", () => {
  const { root, work, map, folder } = setup();
  put(join(folder(work), "memory", "a.md"), memory("feedback"));
  put(join(folder(join(work, "fe")), "memory", "b.md"), memory("feedback", false));
  put(join(folder(join(work, "be")), "memory", "c.md"), memory("project"));
  put(join(folder(work), "memory", "MEMORY.md"), "- [a](a.md)\n");
  put(join(folder(work), "memory", "notes.txt"), memory("feedback"));
  const stats = memoryStats(map, "", root);
  assert.equal(stats.memories, 3);
  assert.equal(stats.feedback, 2);
  assert.equal(stats.feedbackNewer, 2);
  assert.equal(stats.typed, 3);
  assert.equal(stats.dirs.length, 3);
});

test("a date since counts the whole local day, and a timestamp since counts only later files", () => {
  const { root, work, map, folder } = setup();
  const dir = join(folder(work), "memory");
  put(join(dir, "day-before.md"), memory("feedback"), local(2026, 10, 6, 23, 59));
  put(join(dir, "early-same-day.md"), memory("feedback"), local(2026, 10, 7, 0, 30));
  put(join(dir, "later.md"), memory("feedback"), local(2026, 10, 9));
  assert.equal(memoryStats(map, "2026-10-07", root).feedbackNewer, 2);
  const mark = local(2026, 10, 7, 0, 30);
  assert.equal(memoryStats(map, new Date(mark.getTime() - 1000).toISOString(), root).feedbackNewer, 2);
  assert.equal(memoryStats(map, new Date(mark.getTime() + 1000).toISOString(), root).feedbackNewer, 1);
});

test("sessions count top-level transcripts in every project folder of the map and its worktree folders, not subagent transcripts", () => {
  const { root, work, map, folder } = setup();
  const since = "2026-10-07";
  put(join(folder(work), "s1.jsonl"), "{}\n", local(2026, 10, 8));
  put(join(folder(work), "old.jsonl"), "{}\n", local(2026, 10, 1));
  put(join(folder(work), "s1", "subagents", "agent-1.jsonl"), "{}\n", local(2026, 10, 8));
  put(join(folder(join(work, "fe")), "s2.jsonl"), "{}\n", local(2026, 10, 8));
  put(join(root, `${projectSlug(join(work, "fe"))}--claude-worktrees-fix-1`, "s3.jsonl"), "{}\n", local(2026, 10, 9));
  assert.equal(memoryStats(map, since, root).sessions, 3);
});

test("missing folders give zeros, and an unreadable memory is skipped and counted", () => {
  const { root, work, map, folder } = setup();
  assert.deepEqual(memoryStats(map, "", root), { dirs: [], memories: 0, newer: 0, feedback: 0, feedbackNewer: 0, typed: 0, skipped: 0, sessions: 0 });
  const blocked = join(folder(work), "memory", "blocked.md");
  put(blocked, memory("feedback"));
  chmodSync(blocked, 0o000);
  const stats = memoryStats(map, "", root);
  if (process.getuid?.() !== 0) assert.equal(stats.skipped, 1);
});

test("a memory folder moved by settings or the environment is reported instead of read as empty", () => {
  const settings = join(tempDir("tedy-settings-"), "settings.json");
  assert.equal(layoutOverride({}, settings), null);
  assert.equal(layoutOverride({ CLAUDE_CODE_PROJECT_DIR_NAME: "x" }, settings), "CLAUDE_CODE_PROJECT_DIR_NAME");
  writeFileSync(settings, JSON.stringify({ autoMemoryDirectory: "/m" }));
  assert.equal(layoutOverride({}, settings), "autoMemoryDirectory");
  writeFileSync(settings, "not json");
  assert.equal(layoutOverride({}, settings), null);
});
