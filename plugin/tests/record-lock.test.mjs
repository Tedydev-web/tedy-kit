import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { jobFlag, ledgerConflicts, ledgerPath, lockPath, withRecords } from "../lib/record-lock.mjs";
import { world } from "./fake-services-for-tests.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const MODULE = new URL("../lib/record-lock.mjs", import.meta.url).href;
const NS = readlinkSync("/proc/self/ns/pid");
const startOf = (pid) => {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
};
const MINUTE = 60_000;

function hold(key, fields = {}, ageMinutes = 0) {
  const path = lockPath(key);
  mkdirSync(dirname(path), { recursive: true });
  const lock = { key, pid: process.pid, ns: NS, start: startOf(process.pid), at: "2026-11-05T01:00:00.000Z", command: "github-write.mjs post", ...fields };
  writeFileSync(path, typeof fields === "string" ? fields : JSON.stringify(lock));
  if (ageMinutes) {
    const then = new Date(Date.now() - ageMinutes * MINUTE);
    utimesSync(path, then, then);
  }
  return path;
}

const ledger = (key, state) => (existsSync(ledgerPath(key, state)) ? readFileSync(ledgerPath(key, state), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

test("a write takes its locks, appends one ledger line per key once, and releases the locks", async () => {
  let inside;
  const result = await withRecords(["t1:b", "t1:a", "t1:a"], {}, async (recorded) => {
    inside = [existsSync(lockPath("t1:a")), existsSync(lockPath("t1:b"))];
    recorded();
    recorded();
    return 7;
  });
  assert.equal(result, 7);
  assert.deepEqual(inside, [true, true]);
  assert.equal(existsSync(lockPath("t1:a")), false);
  assert.equal(existsSync(lockPath("t1:b")), false);
  for (const key of ["t1:a", "t1:b"]) {
    const lines = ledger(key);
    assert.equal(lines.length, 1, key);
    assert.equal(lines[0].key, key);
    assert.equal(lines[0].job, null);
    assert.equal(lines[0].pid, process.pid);
    assert.equal(typeof lines[0].command, "string");
    assert.ok(!Number.isNaN(Date.parse(lines[0].at)));
  }
});

test("a held lock refuses at once with its holder, runs nothing and appends nothing", async () => {
  const path = hold("t2:a");
  let ran = false;
  await assert.rejects(
    withRecords(["t2:a"], {}, async () => {
      ran = true;
    }),
    { message: `refused: t2:a is being written by pid ${process.pid} (github-write.mjs post) since 2026-11-05T01:00:00.000Z; nothing was written and the approval is unused. Run this command again when it finishes.` },
  );
  assert.equal(ran, false);
  assert.equal(existsSync(path), true);
  assert.deepEqual(ledger("t2:a"), []);
});

test("a dead holder, a reused pid and an unreadable old lock are broken; a live holder is never broken by age; another namespace's lock is broken only after 30 minutes", async () => {
  const write = async (key) => withRecords([key], {}, async (recorded) => recorded());
  hold("t3:dead", { pid: deadPid() });
  await write("t3:dead");
  hold("t3:reused", { start: "1" });
  await write("t3:reused");
  hold("t3:garbage", "{not json", 31);
  await write("t3:garbage");
  hold("t3:zero", { pid: 0 }, 31);
  await write("t3:zero");
  for (const key of ["t3:dead", "t3:reused", "t3:garbage", "t3:zero"]) {
    assert.equal(ledger(key).length, 1, key);
    assert.equal(existsSync(lockPath(key)), false, key);
  }
  hold("t3:young-garbage", "");
  await assert.rejects(write("t3:young-garbage"), /refused: t3:young-garbage is being written by pid unknown/);
  hold("t3:live", {}, 31);
  await assert.rejects(write("t3:live"), /refused: t3:live is being written by pid/);
  const elsewhere = deadPid();
  hold("t3:ns", { ns: "pid:[1]", pid: elsewhere }, 29);
  await assert.rejects(write("t3:ns"), new RegExp(`refused: t3:ns is being written by pid ${elsewhere}`));
  hold("t3:ns", { ns: "pid:[1]", pid: elsewhere }, 31);
  await write("t3:ns");
  assert.equal(ledger("t3:ns").length, 1);
  assert.deepEqual(ledger("t3:live"), []);
});

test("a write that fails releases its locks, and keeps its ledger line only when it wrote", async () => {
  await assert.rejects(
    withRecords(["t4:before"], {}, async () => {
      throw new Error("boom before");
    }),
    /boom before/,
  );
  assert.equal(existsSync(lockPath("t4:before")), false);
  assert.deepEqual(ledger("t4:before"), []);
  await assert.rejects(
    withRecords(["t4:after"], {}, async (recorded) => {
      recorded();
      throw new Error("boom after");
    }),
    /boom after/,
  );
  assert.equal(existsSync(lockPath("t4:after")), false);
  assert.equal(ledger("t4:after").length, 1);
});

test("--job is read as --job <file> or --job=<file> in any position, and a --job with no file refuses", () => {
  assert.equal(jobFlag(["post", "d.md"]), undefined);
  assert.equal(jobFlag(["post", undefined]), undefined);
  assert.equal(jobFlag(["post", "--job", "plans/jobs/a.md", "d.md"]), "plans/jobs/a.md");
  assert.equal(jobFlag(["post", "d.md", "--job=plans/jobs/a.md"]), "plans/jobs/a.md");
  for (const args of [["post", "d.md", "--job"], ["post", "--job", "--doc", "D"], ["post", "--job="], ["post", "--job", " "]]) {
    assert.throws(() => jobFlag(args), { message: "--job needs a job file path; nothing was written" }, args.join(" "));
  }
});

async function captured(fn) {
  const write = process.stderr.write;
  let stderr = "";
  process.stderr.write = (chunk) => ((stderr += chunk), true);
  try {
    return { value: await fn(), stderr };
  } catch (error) {
    return { error, stderr };
  } finally {
    process.stderr.write = write;
  }
}

const gateLog = () => readFileSync(join(process.env.TEDY_STATE_DIR, "gate-log.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("a ledger line that cannot be appended after the write warns on stderr and in the gate log, and the write still succeeds", async () => {
  mkdirSync(ledgerPath("t10:a"), { recursive: true });
  const { value, error, stderr } = await captured(() =>
    withRecords(["t10:a", "t10:b"], {}, async (recorded) => {
      recorded();
      recorded();
      return 3;
    }),
  );
  assert.equal(error, undefined);
  assert.equal(value, 3);
  assert.equal(existsSync(lockPath("t10:a")), false);
  assert.equal(existsSync(lockPath("t10:b")), false);
  assert.equal(ledger("t10:b").length, 1);
  assert.equal(stderr.split("\n").filter((line) => line.includes("t10:a")).length, 1, stderr);
  assert.match(stderr, /^warning: written, but the ledger line for t10:a could not be appended \(EISDIR[^\n]*\); a later job's conflict check will not see this write$/m);
  assert.ok(gateLog().some((entry) => entry.hook === "record-lock" && entry.decision === "ledger-append-failed" && entry.key === "t10:a"));
});

test("two processes racing on one record: one writes, the other refuses with the lock-held text", async () => {
  const state = tempDir("tedy-race-");
  const barrier = join(state, "barrier");
  const script = `import { existsSync } from "node:fs";
import { withRecords } from ${JSON.stringify(MODULE)};
try {
  await withRecords(["t5:k"], {}, async (recorded) => {
    recorded();
    while (!existsSync(process.env.BARRIER)) await new Promise((done) => setTimeout(done, 20));
  });
  process.exit(0);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}`;
  const start = () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TEDY_STATE_DIR: state, BARRIER: barrier } });
    let err = "";
    child.stderr.on("data", (chunk) => (err += chunk));
    return new Promise((done) => child.on("exit", (code) => done({ code, err: () => err })));
  };
  const runs = [start(), start()];
  const timer = setTimeout(() => writeFileSync(barrier, ""), 15_000);
  const first = await Promise.race(runs);
  writeFileSync(barrier, "");
  clearTimeout(timer);
  const [a, b] = await Promise.all(runs);
  assert.equal(first.code, 1, first.err());
  assert.match(first.err(), /^refused: t5:k is being written by pid \d+ \(.*\) since .*; nothing was written and the approval is unused\. Run this command again when it finishes\.$/m);
  assert.deepEqual([a.code, b.code].sort(), [0, 1]);
  assert.equal(ledger("t5:k", state).length, 1);
});

test("the ledger refuses only another job's write after the draft's sources were pinned", async () => {
  const since = "2026-11-05T02:00:00.000Z";
  const line = (key, job, at) => {
    mkdirSync(dirname(ledgerPath(key)), { recursive: true });
    appendFileSync(ledgerPath(key), `${JSON.stringify({ at, key, job, command: "figma-comments.mjs post", pid: 1 })}\n`);
  };
  line("t6:other", "b.md", "2026-11-05T03:00:00.000Z");
  assert.deepEqual(ledgerConflicts(["t6:other"], { job: "/home/x/plans/jobs/a.md", since }), [{ key: "t6:other", job: "b.md", at: "2026-11-05T03:00:00.000Z" }]);
  let ran = false;
  await assert.rejects(
    withRecords(["t6:other"], { job: "plans/jobs/a.md", since }, async () => {
      ran = true;
    }),
    { message: "refused: t6:other got a kit write from job b.md at 2026-11-05T03:00:00.000Z, after this draft's sources were pinned at 2026-11-05T02:00:00.000Z; read the record again, update the draft, lint it and ask the user again." },
  );
  assert.equal(ran, false);
  assert.equal(existsSync(lockPath("t6:other")), false);
  assert.equal(ledger("t6:other").length, 1);
  line("t6:same", "plans/jobs/a.md", "2026-11-05T03:00:00.000Z");
  assert.deepEqual(ledgerConflicts(["t6:same"], { job: "/home/x/plans/jobs/a.md", since }), []);
  assert.deepEqual(ledgerConflicts(["t6:same"], { job: "./plans/jobs/a.md", since }), []);
  line("t6:nojob", null, "2026-11-05T03:00:00.000Z");
  assert.deepEqual(ledgerConflicts(["t6:nojob"], { job: "a.md", since }), []);
  assert.deepEqual(ledgerConflicts(["t6:other"], { since }), []);
  assert.deepEqual(ledgerConflicts(["t6:other"], { job: "a.md", since: null }), []);
  line("t6:before", "b.md", "2026-11-05T01:00:00.000Z");
  assert.deepEqual(ledgerConflicts(["t6:before"], { job: "a.md", since }), []);
  assert.deepEqual(ledgerConflicts(["t6:missing"], { job: "a.md", since }), []);
  await withRecords(["t6:same"], { job: "/abs/plans/jobs/a.md", since }, async (recorded) => recorded());
  assert.equal(ledger("t6:same").at(-1).job, "a.md");
  await assert.rejects(withRecords(["t6:x"], { job: true }, async () => {}), /--job needs a job file/);
});

test("several keys are taken in sorted order, and a refusal on a later key releases the earlier ones", async () => {
  hold("t7:a", { pid: process.pid, command: "first" });
  hold("t7:b", { pid: process.pid, command: "second" });
  await assert.rejects(withRecords(["t7:b", "t7:a"], {}, async () => {}), /refused: t7:a is being written by pid \d+ \(first\)/);
  hold("t7:c");
  await assert.rejects(withRecords(["t7:c", "t7:0"], {}, async () => {}), /refused: t7:c /);
  assert.equal(existsSync(lockPath("t7:0")), false);
  await withRecords(["t7:0"], {}, async (recorded) => recorded());
  assert.equal(ledger("t7:0").length, 1);
});

test("two drafts on one Figma file post one after the other, with no job and with one job for both", async () => {
  for (const job of [[], ["--job", "plans/jobs/one.md"]]) {
    const w = world({ web: { figma: [] } });
    const bodies = ["@lam Màn này thiếu trạng thái rỗng.\n", "@lam Màn này thiếu trạng thái lỗi.\n"];
    const warnings = [];
    for (const [index, body] of bodies.entries()) {
      w.file(`f${index}.md`, body);
      const lint = await w.run("draft-lint", ["figma-comment", `f${index}.md`, "--file", "F"]);
      assert.equal(lint.code, 0, lint.out);
      warnings.push(lint.out.split("\n").filter((text) => text.startsWith("warning: ")).map((text) => `${text}\n`).join(""));
    }
    for (const [index, body] of bodies.entries()) {
      const args = ["post", "1:2", "--body-file", `f${index}.md`, "--file", "F", ...job];
      w.approve(`${body}${warnings[index]}${w.line("figma-comments", args)}`);
      const posted = await w.run("figma-comments", args);
      assert.equal(posted.code, 0, posted.out);
    }
    assert.equal(w.writes().length, 2);
    const lines = ledger("figma:F", join(w.dir, "state"));
    assert.equal(lines.length, 2, JSON.stringify(lines));
    assert.deepEqual(lines.map((entry) => entry.job), job.length ? ["one.md", "one.md"] : [null, null]);
  }
});
