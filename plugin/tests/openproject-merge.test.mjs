import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { mappedProfile, tempDir } from "./temp-dir-for-tests.mjs";

const run = promisify(execFile);
const SCRIPT = new URL("../lib/openproject.mjs", import.meta.url).pathname;
const DESCRIPTION = "## Goal\nShow the pop-up when a 4th vault is started on Free.\n\n## Checklist\n- [ ] Show the pop-up.\n\n## AC\n- [ ] On Free, a 4th vault cannot be started.";

function fakeOpenProject(workPackages) {
  const patches = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://x");
      const send = (data) => response.end(JSON.stringify(data));
      if (url.pathname === "/api/v3/statuses") return send({ _embedded: { elements: [{ name: "New", isClosed: false }, { name: "Closed", isClosed: true }] } });
      if (url.pathname.endsWith("/types")) return send({ _embedded: { elements: [{ name: "Task", _links: { self: { href: "/api/v3/types/1" } } }] } });
      if (url.pathname.endsWith("/available_assignees")) return send({ _embedded: { elements: [] } });
      if (url.pathname.endsWith("/work_packages") && request.method === "GET") return send({ total: 0, _embedded: { elements: [] } });
      const match = url.pathname.match(/^\/api\/v3\/work_packages\/(\d+)(\/form)?$/);
      const workPackage = match && workPackages[match[1]];
      if (!workPackage) return response.writeHead(404).end("{}");
      if (match[2]) return send({ _embedded: { validationErrors: {} } });
      if (request.method === "PATCH") {
        const payload = JSON.parse(body);
        patches.push(payload);
        if (payload.description) workPackage.description = { raw: payload.description.raw };
        if (payload.estimatedTime) workPackage.estimatedTime = payload.estimatedTime;
        workPackage.lockVersion += 1;
      }
      send(workPackage);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, patches, url: `http://127.0.0.1:${server.address().port}` })));
}

function workspace(url, drafts) {
  const home = tempDir("tedy-op-merge-");
  mkdirSync(join(home, ".config", "op", "sync"), { recursive: true });
  writeFileSync(join(home, ".config", "op", "config.json"), JSON.stringify({ url, token: "test-" + "token-value" }));
  const file = join(home, "drafts.json");
  writeFileSync(file, JSON.stringify(drafts));
  const env = { ...process.env, HOME: home, TEDY_PROFILE_DIR: mappedProfile(home, {}), TEDY_STATE_DIR: join(home, "state"), OP_SYNC_DIR: join(home, ".config", "op", "sync") };
  const op = (command) => run("node", [SCRIPT, command, file, "--project", "family"], { env, cwd: home }).then((result) => result.stdout, (error) => error.stdout);
  return { home, op };
}

const draft = { slug: "task-fe-vault-limit", type: "Task", subject: "[FE] Vault limit pop-up on Free", description: DESCRIPTION, estimate: 1 };

test("a merge appends new checklist lines to an open work package, keeps its estimate, and adopts the slug", async () => {
  const existing = { id: 21298, subject: "[FE] Free vault limit pop-up", lockVersion: 3, estimatedTime: "PT2H", description: { raw: "## Goal\nOld goal.\n\n## AC\n- [ ] Show the pop-up." }, _links: { status: { title: "New" } } };
  const { server, patches, url } = await fakeOpenProject({ 21298: existing });
  const { home, op } = workspace(url, [{ ...draft, merge: 21298 }]);
  try {
    const preview = await op("preview");
    assert.match(preview, /merge #21298 task-fe-vault-limit \| lint clean .* \| form ok \| \+1 checklist line\(s\), estimate kept/);
    assert.match(preview, /0 create · 0 update · 1 merge/);
    const applied = await op("apply");
    assert.match(applied, /verified 1\/1/);
    assert.equal(patches.length, 1);
    assert.deepEqual(Object.keys(patches[0]).sort(), ["description", "lockVersion"]);
    assert.match(existing.description.raw, /^## Goal\nOld goal\.[\s\S]*## Added \d{4}-\d{2}-\d{2}\n- \[ \] On Free, a 4th vault cannot be started\.$/);
    assert.equal(existing.subject, "[FE] Free vault limit pop-up");
    const sidecar = JSON.parse(readFileSync(join(home, ".config", "op", "sync", `127.0.0.1_${new URL(url).port}__family.map.json`), "utf8"));
    assert.equal(sidecar["task-fe-vault-limit"], 21298);
  } finally {
    server.close();
  }
});

test("a merge into a closed work package is refused at preview and apply writes nothing", async () => {
  const closed = { id: 21046, subject: "[FE] Free vault limit pop-up", lockVersion: 9, estimatedTime: null, description: { raw: "## AC\n- [ ] Old." }, _links: { status: { title: "Closed" } } };
  const { server, patches, url } = await fakeOpenProject({ 21046: closed });
  const { op } = workspace(url, [{ ...draft, merge: 21046 }]);
  try {
    assert.match(await op("preview"), /refused: #21046 is Closed; create a new work package with relates instead/);
    assert.match(await op("apply"), /refused: fix the lint and form findings above/);
    assert.equal(patches.length, 0);
  } finally {
    server.close();
  }
});
