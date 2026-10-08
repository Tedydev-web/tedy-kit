import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { tempDir } from "./temp-dir-for-tests.mjs";

const run = promisify(execFile);
const SCRIPT = new URL("./openproject.mjs", import.meta.url).pathname;
const DESCRIPTION = "## Goal\nShow the pop-up when a 4th vault is started on Free.\n\n## Checklist\n- [ ] Show the pop-up.\n\n## AC\n- [ ] On Free, a 4th vault cannot be started.";
const STATUSES = [
  { name: "New", isClosed: false, _links: { self: { href: "/api/v3/statuses/1" } } },
  { name: "In progress", isClosed: false, _links: { self: { href: "/api/v3/statuses/7" } } },
  { name: "Closed", isClosed: true, _links: { self: { href: "/api/v3/statuses/12" } } },
];

function fakeOpenProject() {
  const workPackages = {};
  const calls = [];
  let nextId = 30000;
  const make = (id, subject) => ({ id, subject, lockVersion: 0, updatedAt: "2026-10-08T04:00:00Z", estimatedTime: null, description: { raw: DESCRIPTION }, _links: { status: { title: "New" }, project: { href: "/api/v3/projects/183" }, priority: { title: "Normal" } } });
  workPackages[21298] = make(21298, "[FE] Vault limit pop-up on Free");
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://x");
      const send = (data) => response.end(JSON.stringify(data));
      if (request.method !== "GET" && !url.pathname.endsWith("/form")) calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/v3/statuses") return send({ _embedded: { elements: STATUSES } });
      if (url.pathname === "/api/v3/priorities") return send({ _embedded: { elements: [{ name: "High", _links: { self: { href: "/api/v3/priorities/9" } } }] } });
      if (url.pathname.endsWith("/types")) return send({ _embedded: { elements: [{ name: "Task", _links: { self: { href: "/api/v3/types/1" } } }] } });
      if (url.pathname.endsWith("/available_assignees")) return send({ _embedded: { elements: [{ name: "Hoàng Phúc", _links: { self: { href: "/api/v3/users/7" } } }] } });
      if (url.pathname.endsWith("/form")) return send({ _embedded: { validationErrors: {} } });
      if (url.pathname === "/api/v3/projects/183/work_packages" && request.method === "GET") return send({ total: 0, _embedded: { elements: [] } });
      if (url.pathname === "/api/v3/projects/183/work_packages" && request.method === "POST") {
        const payload = JSON.parse(body);
        const created = make(nextId++, payload.subject);
        created.description = { raw: payload.description.raw };
        workPackages[created.id] = created;
        return send(created);
      }
      const relation = url.pathname.match(/^\/api\/v3\/work_packages\/(\d+)\/relations$/);
      if (relation && request.method === "POST") {
        const links = JSON.parse(body)._links ?? {};
        const target = links.to?.href?.split("/").pop();
        if (links.from?.href !== `/api/v3/work_packages/${relation[1]}`) return response.writeHead(500).end(JSON.stringify({ message: "undefined method `project' for nil:NilClass" }));
        if (!workPackages[target]) return response.writeHead(422).end(JSON.stringify({ message: "Related work package does not exist" }));
        return response.writeHead(201).end(JSON.stringify({ id: 903 }));
      }
      const match = url.pathname.match(/^\/api\/v3\/work_packages\/(\d+)$/);
      const workPackage = match && workPackages[match[1]];
      if (!workPackage) return response.writeHead(404).end("{}");
      if (request.method === "DELETE") {
        delete workPackages[match[1]];
        return response.writeHead(204).end();
      }
      if (request.method === "PATCH") {
        const payload = JSON.parse(body);
        if (payload.lockVersion !== workPackage.lockVersion) return response.writeHead(409).end(JSON.stringify({ message: "lock version mismatch" }));
        const status = STATUSES.find((candidate) => candidate._links.self.href === payload._links?.status?.href);
        if (status) workPackage._links.status = { title: status.name };
        if (payload._links?.assignee) workPackage._links.assignee = { title: "Hoàng Phúc" };
        if (payload.estimatedTime) workPackage.estimatedTime = payload.estimatedTime;
        if (payload.subject) workPackage.subject = payload.subject;
        if (payload.description) workPackage.description = { raw: payload.description.raw };
        workPackage.lockVersion += 1;
      }
      send(workPackage);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, workPackages, url: `http://127.0.0.1:${server.address().port}` })));
}

function workspace(url) {
  const home = tempDir("tedy-op-set-");
  mkdirSync(join(home, ".config", "op", "sync"), { recursive: true });
  writeFileSync(join(home, ".config", "op", "config.json"), JSON.stringify({ url, token: "test-token-value" }));
  const env = { ...process.env, HOME: home, TEDY_STATE_DIR: join(home, "state"), OP_SYNC_DIR: join(home, ".config", "op", "sync") };
  const op = (...args) => run("node", [SCRIPT, ...args], { env, cwd: home }).then((result) => result.stdout, (error) => error.stdout);
  const sidecar = () => JSON.parse(readFileSync(join(home, ".config", "op", "sync", `127.0.0.1_${new URL(url).port}__183.map.json`), "utf8"));
  return { home, op, sidecar };
}

test("set previews the change with its lock, refuses a stale lock, and patches only the named fields", async () => {
  const { server, calls, workPackages, url } = await fakeOpenProject();
  const { op } = workspace(url);
  try {
    const preview = await op("set", "21298", "--status", "In progress", "--assignee", "Phuc", "--estimate", "2");
    assert.match(preview, /#21298 "\[FE\] Vault limit pop-up on Free" \[New\] \| status New → In progress, assignee none → Phuc, estimate none → 2 \| form ok \| lock 0/);
    assert.match(preview, /run again with --apply --lock 0/);
    assert.deepEqual(calls, []);
    workPackages[21298].lockVersion = 3;
    assert.match(await op("set", "21298", "--status", "In progress", "--apply", "--lock", "0"), /refused: #21298 is at lock 3, not the previewed 0/);
    assert.deepEqual(calls, []);
    const applied = await op("set", "21298", "--status", "In progress", "--estimate", "2", "--apply", "--lock", "3");
    assert.match(applied, /set #21298 .* \[In progress\] .* estimate PT2H/);
    assert.deepEqual(calls, ["PATCH /api/v3/work_packages/21298"]);
  } finally {
    server.close();
  }
});

test("rollback lists what the last apply created, closes by default, and deletes only with --delete", async () => {
  const { server, calls, workPackages, url } = await fakeOpenProject();
  const { home, op, sidecar } = workspace(url);
  const file = join(home, "drafts.json");
  writeFileSync(file, JSON.stringify([
    { slug: "task-fe-a", type: "Task", subject: "[FE] Vault limit pop-up on Pro", description: DESCRIPTION, estimate: 1 },
    { slug: "task-fe-b", type: "Task", subject: "[FE] Wire vault limit to the API", description: DESCRIPTION, estimate: 1, id: 21298 },
  ]));
  try {
    await op("preview", file, "--project", "183");
    assert.match(await op("apply", file, "--project", "183"), /verified 2\/2/);
    assert.deepEqual(sidecar()._last_apply.created, [30000]);
    calls.length = 0;
    const dry = await op("rollback", "--project", "183");
    assert.match(dry, /close 1 work package\(s\) it created; nothing else is touched\n  #30000 "\[FE\] Vault limit pop-up on Pro" \[New\]/);
    assert.deepEqual(calls, []);
    assert.match(await op("rollback", "--project", "183", "--apply"), /close 1\/1/);
    assert.equal(workPackages[30000]._links.status.title, "Closed");
    assert.equal(workPackages[21298]._links.status.title, "New");
    assert.equal(workPackages[21298].subject, "[FE] Wire vault limit to the API");
    assert.equal(sidecar()._last_apply, undefined);
    assert.equal(sidecar()["task-fe-a"], 30000);
    assert.match(await op("rollback", "--project", "183", "--apply"), /nothing to roll back/);

    await op("preview", file, "--project", "183");
    writeFileSync(file, JSON.stringify([{ slug: "task-fe-c", type: "Task", subject: "[FE] Vault limit banner", description: DESCRIPTION, estimate: 1 }]));
    await op("preview", file, "--project", "183");
    await op("apply", file, "--project", "183");
    workPackages[30001].updatedAt = "2099-01-01T00:00:00Z";
    assert.match(await op("rollback", "--project", "183", "--delete"), /#30001 .* changed after the apply\nrefused: #30001 changed after the apply/);
    assert.equal(workPackages[30001].subject, "[FE] Vault limit banner");
    workPackages[30001].updatedAt = "2000-01-01T00:00:00Z";
    assert.match(await op("rollback", "--project", "183", "--delete", "--apply"), /delete 1\/1/);
    assert.equal(workPackages[30001], undefined);
    assert.equal(sidecar()["task-fe-c"], undefined);
    assert.equal(sidecar()["task-fe-a"], 30000);
  } finally {
    server.close();
  }
});

test("a failed relation fails the apply, and work packages created before a mid-batch error stay in the rollback record", async () => {
  const { server, url } = await fakeOpenProject();
  const { home, op, sidecar } = workspace(url);
  const file = join(home, "drafts.json");
  try {
    writeFileSync(file, JSON.stringify([{ slug: "task-fe-r", type: "Task", subject: "[FE] Vault limit hint", description: DESCRIPTION, estimate: 1, relates: [21298, 99999] }]));
    await op("preview", file, "--project", "183");
    const applied = await op("apply", file, "--project", "183");
    assert.doesNotMatch(applied, /relation failed: task-fe-r relates 21298/);
    assert.match(applied, /relation failed: task-fe-r relates 99999/);
    assert.match(applied, /verified 1\/1; 1 relation\(s\) failed/);
    assert.deepEqual(sidecar()._last_apply.created, [30000]);

    writeFileSync(file, JSON.stringify([
      { slug: "task-fe-s", type: "Task", subject: "[FE] Vault limit sheet", description: DESCRIPTION, estimate: 1 },
      { slug: "task-fe-t", type: "Task", subject: "[FE] Vault limit toast", description: DESCRIPTION, estimate: 1, status: "Nope" },
    ]));
    await op("preview", file, "--project", "183");
    await op("apply", file, "--project", "183");
    assert.deepEqual(sidecar()._last_apply.created, [30001, 30002]);
    assert.match(await op("rollback", "--project", "183"), /close 2 work package\(s\)/);
  } finally {
    server.close();
  }
});
