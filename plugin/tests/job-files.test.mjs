import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { JOB_BASE_KEYS, JOB_KEYS, missingSections, parse, render, setStatus, slugOf, stamp } from "../lib/job-files.mjs";

const SECTIONED = "Fix the toast.\n\n## User decisions\nnone\n\n## First safe step\nread the screen\n\n## Sources\nPRD UC_01\n";

test("a job file renders as a pending header plus body, and parses back", () => {
  const text = render({ to: "tedy:dev", from: "cockpit", title: "Fix the fake save toast", body: "Save shows a toast without calling the API.\n", created: "2026-10-08T01:00:00Z" });
  assert.deepEqual(parse(text), { to: "tedy:dev", from: "cockpit", status: "pending", created: "2026-10-08T01:00:00Z", title: "Fix the fake save toast" });
  assert.match(text, /\n\nSave shows a toast without calling the API\.\n$/);
});

test("parse reads the base keys by default and another header when given its key list", () => {
  const text = "to: a\nfrom: b\nstatus: pending\ncreated: c\ntitle: t\nupdated: u\n\nbody: x\n";
  assert.deepEqual(parse(text), { to: "a", from: "b", status: "pending", created: "c", title: "t", updated: "u" });
  assert.deepEqual(parse("to: a\ndraft-sha: x\ntitle: t\n"), { to: "a" });
  assert.deepEqual(parse("kind: publish\ndraft-sha: x\ntitle: t\n\nkind: notify\n", ["kind", "draft-sha", "title"]), { kind: "publish", "draft-sha": "x", title: "t" });
  assert.deepEqual(JOB_KEYS.slice(0, JOB_BASE_KEYS.length), [...JOB_BASE_KEYS]);
});

test("status moves from pending to running to done, keeping one updated line, and a file without a status line is refused", () => {
  const base = render({ to: "a", from: "b", title: "t", body: "x", created: "c" });
  const running = setStatus(base, "running", "t1");
  const done = setStatus(running, "done", "t2");
  assert.equal(parse(done).status, "done");
  assert.equal(parse(done).updated, "t2");
  assert.equal(done.split("\n").filter((line) => line.startsWith("updated: ")).length, 1);
  assert.throws(() => setStatus("title: t\n", "done", "t3"), /^Error: not a job file: no status line$/);
});

test("slugs fold Vietnamese and stamps follow yymmdd-hhmm", () => {
  assert.equal(slugOf("Sửa toast giả ở Đổi tên"), "sua-toast-gia-o-doi-ten");
  assert.equal(stamp(new Date(2026, 9, 8, 9, 5)), "261008-0905");
});

test("a job body must carry the user decisions, the first safe step and the sources, outside any code fence", () => {
  assert.deepEqual(missingSections(SECTIONED), []);
  assert.deepEqual(missingSections("## User decisions\nnone\n"), ["## First safe step", "## Sources"]);
  assert.deepEqual(missingSections("```\n## User decisions\n## First safe step\n## Sources\n```\n"), ["## User decisions", "## First safe step", "## Sources"]);
});

test("a fence closes only on the marker that opened it", () => {
  assert.deepEqual(missingSections("```\n~~~\n## User decisions\n## First safe step\n## Sources\n```\n"), ["## User decisions", "## First safe step", "## Sources"]);
});
