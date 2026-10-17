import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { foreignActivity, setPayload, workPackageFilters, workPackageLine } from "../lib/openproject-client.mjs";
import { getPaths } from "../lib/openproject.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const run = promisify(execFile);
const SCRIPT = new URL("../lib/openproject.mjs", import.meta.url).pathname;
const REFS = {
  statuses: [{ name: "In progress", _links: { self: { href: "/api/v3/statuses/7" } } }],
  types: { task: "/api/v3/types/1", bug: "/api/v3/types/7" },
  assignees: [{ name: "Trần Lan (Lan)", href: "/api/v3/users/12" }, { name: "Minh Pham", href: "/api/v3/users/15" }],
};

test("get reads a work package by id, its relations or activities, and keeps raw API paths", () => {
  assert.deepEqual(getPaths("21421", {}), ["/api/v3/work_packages/21421"]);
  assert.deepEqual(getPaths("21421", { relations: true }), ["/api/v3/work_packages/21421/relations"]);
  assert.deepEqual(getPaths("21421", { relations: true, activities: true }), ["/api/v3/work_packages/21421/relations", "/api/v3/work_packages/21421/activities"]);
  assert.deepEqual(getPaths("/api/v3/statuses", {}), ["/api/v3/statuses"]);
  assert.throws(() => getPaths("api/v3/statuses", {}), /starting with \//);
});

test("list filters resolve names to ids, and open means any open status", () => {
  assert.deepEqual(workPackageFilters({ parent: "21167", assignee: "tran", status: "open", type: "Bug" }, REFS), [
    { parent: { operator: "=", values: ["21167"] } },
    { assignee: { operator: "=", values: ["12"] } },
    { status: { operator: "o", values: [] } },
    { type: { operator: "=", values: ["7"] } },
  ]);
  assert.deepEqual(workPackageFilters({ status: "in progress" }, REFS), [{ status: { operator: "=", values: ["7"] } }]);
  assert.deepEqual(workPackageFilters({}, REFS), []);
  assert.throws(() => workPackageFilters({ status: "Done" }, REFS), /status "Done" does not exist/);
  assert.throws(() => workPackageFilters({ type: "Epic" }, REFS), /type "Epic" does not exist/);
  assert.throws(() => workPackageFilters({ parent: "abc" }, REFS), /--parent takes a work package id/);
  assert.throws(() => workPackageFilters({ parent: true }, REFS), /--parent takes a work package id/);
});

test("a listed work package is one line with id, type, status, assignee, dates and subject", () => {
  const wp = { id: 21421, subject: "[FE] Rules list", startDate: "2026-10-22", dueDate: "2026-10-23", _links: { type: { title: "Task" }, status: { title: "New" }, assignee: { title: "Minh Pham" } } };
  assert.equal(workPackageLine(wp), "#21421 Task [New] Minh Pham 2026-10-22..2026-10-23 [FE] Rules list");
  assert.equal(workPackageLine({ id: 1, subject: "M", date: "2026-11-01", _links: { type: { title: "Milestone" }, status: { title: "New" } } }), "#1 Milestone [New] unassigned -..2026-11-01 M");
});

test("a quick set takes start and due dates, schedules them manually and refuses bad dates", () => {
  assert.deepEqual(setPayload(4, { start: "2026-10-16", due: "2026-10-17" }, REFS), { lockVersion: 4, startDate: "2026-10-16", dueDate: "2026-10-17", scheduleManually: true });
  assert.deepEqual(setPayload(4, { due: "2026-10-17" }, REFS), { lockVersion: 4, dueDate: "2026-10-17", scheduleManually: true });
  assert.throws(() => setPayload(4, { start: "2026-02-30" }, REFS), /--start takes a date as YYYY-MM-DD/);
  assert.throws(() => setPayload(4, { due: true }, REFS), /--due takes a date/);
  assert.throws(() => setPayload(4, { start: "2026-10-18", due: "2026-10-17" }, REFS), /is after --due/);
  assert.throws(() => setPayload(4, {}, REFS), /--start or --due/);
});

test("only the token's own activity can be edited", () => {
  const me = { name: "Tedy", _links: { self: { href: "/api/v3/users/140" } } };
  assert.equal(foreignActivity({ id: 9, _links: { user: { href: "/api/v3/users/140" } } }, me), null);
  assert.match(foreignActivity({ id: 9, _links: { user: { href: "/api/v3/users/145" } } }, me), /refused: activity 9 was written by \/api\/v3\/users\/145, not Tedy/);
  assert.match(foreignActivity({ id: 9, _links: {} }, me), /an unknown user/);
});

function fakeOpenProject() {
  const calls = [];
  const wp = { id: 21298, subject: "[FE] Vault", lockVersion: 2, startDate: null, dueDate: null, _links: { status: { title: "New" }, type: { title: "Task" }, project: { href: "/api/v3/projects/42" }, priority: { title: "Normal" } } };
  const activities = {
    501: { id: 501, comment: { raw: "Old note" }, _links: { user: { href: "/api/v3/users/140" }, workPackage: { href: "/api/v3/work_packages/21298" } } },
    502: { id: 502, comment: { raw: "Their note" }, _links: { user: { href: "/api/v3/users/145" }, workPackage: { href: "/api/v3/work_packages/21298" } } },
  };
  const children = Array.from({ length: 150 }, (_, index) => ({ id: 40000 + index, subject: `Child ${index}`, startDate: null, dueDate: null, _links: { type: { title: "Task" }, status: { title: "New" } } }));
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://x");
      const send = (data) => response.end(JSON.stringify(data));
      if (request.method !== "GET" && !url.pathname.endsWith("/form")) calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/v3/users/me") return send({ id: 140, name: "Tedy", _links: { self: { href: "/api/v3/users/140" } } });
      if (url.pathname.endsWith("/form")) return send({ _embedded: { validationErrors: {} } });
      if (url.pathname === "/api/v3/projects/42/work_packages") {
        calls.push(`list ${url.searchParams.get("filters")} ${url.searchParams.get("pageSize")} ${url.searchParams.get("offset")}`);
        const offset = Number(url.searchParams.get("offset"));
        return send({ total: children.length, _embedded: { elements: children.slice((offset - 1) * 100, offset * 100) } });
      }
      if (url.pathname === "/api/v3/work_packages/21298/activities") return send({ _embedded: { elements: Object.values(activities) } });
      const activity = url.pathname.match(/^\/api\/v3\/activities\/(\d+)$/);
      if (activity) {
        const found = activities[activity[1]];
        if (!found) return response.writeHead(404).end("{}");
        if (request.method === "PATCH") found.comment = { raw: JSON.parse(body).comment.raw };
        return send(found);
      }
      if (url.pathname !== "/api/v3/work_packages/21298") return response.writeHead(404).end("{}");
      if (request.method === "PATCH") {
        const payload = JSON.parse(body);
        if (payload.lockVersion !== wp.lockVersion) return response.writeHead(409).end(JSON.stringify({ message: "lock version mismatch" }));
        Object.assign(wp, { startDate: payload.startDate ?? wp.startDate, dueDate: payload.dueDate ?? wp.dueDate, lockVersion: wp.lockVersion + 1 });
      }
      send(wp);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, wp, activities, url: `http://127.0.0.1:${server.address().port}` })));
}

function workspace(url) {
  const home = tempDir("tedy-op-read-");
  mkdirSync(join(home, ".config", "op"), { recursive: true });
  writeFileSync(join(home, ".config", "op", "config.json"), JSON.stringify({ url, token: "test-" + "token-value" }));
  const env = { ...process.env, HOME: home, TEDY_STATE_DIR: join(home, "state"), OP_SYNC_DIR: join(home, ".config", "op", "sync") };
  const op = (...args) => run("node", [SCRIPT, ...args], { env, cwd: home }).then((result) => result.stdout, (error) => `${error.stdout}${error.stderr}`);
  return { home, op };
}

test("get by id reads the work package instead of gluing the id to the host", async () => {
  const { server, url } = await fakeOpenProject();
  const { op } = workspace(url);
  try {
    assert.equal(JSON.parse(await op("get", "21298")).subject, "[FE] Vault");
    assert.equal(JSON.parse(await op("get", "/api/v3/work_packages/21298")).id, 21298);
  } finally {
    server.close();
  }
});

test("list pages through every work package under a parent, 100 at a time", async () => {
  const { server, calls, url } = await fakeOpenProject();
  const { op } = workspace(url);
  try {
    const out = await op("list", "--parent", "21167", "--project", "42");
    assert.equal(out.trim().split("\n").length, 151);
    assert.match(out, /^#40000 Task \[New\] unassigned -..- Child 0$/m);
    assert.match(out, /150 work package\(s\) in project 42/);
    assert.deepEqual(calls, [`list ${JSON.stringify([{ parent: { operator: "=", values: ["21167"] } }])} 100 1`, `list ${JSON.stringify([{ parent: { operator: "=", values: ["21167"] } }])} 100 2`]);
  } finally {
    server.close();
  }
});

test("set dates previews with the lock, refuses a stale lock and reads the dates back", async () => {
  const { server, calls, wp, url } = await fakeOpenProject();
  const { op } = workspace(url);
  try {
    const preview = await op("set", "21298", "--start", "2026-10-16", "--due", "2026-10-17");
    assert.match(preview, /start none → 2026-10-16, due none → 2026-10-17 \| form ok \| lock 2/);
    assert.match(preview, /--apply --lock 2/);
    assert.deepEqual(calls, []);
    assert.match(await op("set", "21298", "--start", "2026-10-16", "--apply", "--lock", "1"), /refused: #21298 is at lock 2/);
    assert.deepEqual(calls, []);
    assert.match(await op("set", "21298", "--start", "2026-10-16", "--due", "2026-10-17", "--apply", "--lock", "2"), /dates 2026-10-16..2026-10-17/);
    assert.deepEqual(calls, ["PATCH /api/v3/work_packages/21298"]);
    assert.equal(wp.dueDate, "2026-10-17");
  } finally {
    server.close();
  }
});

test("comment-edit previews, refuses someone else's or a duplicate comment, and reads the edit back", async () => {
  const { server, calls, activities, url } = await fakeOpenProject();
  const { home, op } = workspace(url);
  const file = join(home, "body.md");
  try {
    writeFileSync(file, "New note\n");
    assert.match(await op("comment-edit", "502", "--body-file", file, "--apply"), /refused: activity 502 was written by \/api\/v3\/users\/145/);
    const preview = await op("comment-edit", "501", "--body-file", file);
    assert.match(preview, /#21298 "\[FE\] Vault" \[New\] \| activity 501 \| comment of 8 → 8 characters/);
    assert.match(preview, /1 comment edit; run again with --apply/);
    writeFileSync(file, "Their note");
    assert.match(await op("comment-edit", "501", "--body-file", file, "--apply"), /refused: #21298 already has this comment as activity 502/);
    writeFileSync(file, "Old note");
    assert.match(await op("comment-edit", "501", "--body-file", file, "--apply"), /already says this/);
    writeFileSync(file, "  ");
    assert.match(await op("comment-edit", "501", "--body-file", file), /comment body is empty/);
    assert.deepEqual(calls, []);
    writeFileSync(file, "New note\n");
    assert.match(await op("comment-edit", "501", "--body-file", file, "--apply"), /edited #21298 activity 501/);
    assert.deepEqual(calls, ["PATCH /api/v3/activities/501"]);
    assert.equal(activities[501].comment.raw, "New note");
  } finally {
    server.close();
  }
});
