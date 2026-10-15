import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { pairRelation, says } from "./openproject-relation.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const run = promisify(execFile);
const SCRIPT = new URL("./openproject.mjs", import.meta.url).pathname;
const wpHref = (id) => `/api/v3/work_packages/${id}`;
const idOf = (href) => Number(href.split("/").pop());
const rel = (id, from, type, to, reverseType = type) => ({ id, type, reverseType, _links: { from: { href: wpHref(from) }, to: { href: wpHref(to) } } });
const touches = (relation, id) => [idOf(relation._links.from.href), idOf(relation._links.to.href)].includes(id);

test("a pair relation is found from either end and read in both directions", () => {
  const relations = [rel(996, 21448, "relates", 21257), rel(1000, 21450, "relates", 21448)];
  assert.equal(pairRelation(relations, 21448, 21450).id, 1000);
  assert.equal(pairRelation(relations, 21448, 21452), null);
  assert.ok(says(rel(1, 21448, "blocks", 21450, "blocked"), 21448, "blocks"));
  assert.ok(says(rel(1, 21450, "blocked", 21448, "blocks"), 21448, "blocks"));
  assert.ok(!says(rel(1, 21450, "blocks", 21448, "blocked"), 21448, "blocks"));
});

function fakeOpenProject({ refuse } = {}) {
  const calls = [];
  const relations = [rel(1000, 21450, "relates", 21448), rel(1004, 21452, "relates", 21448)];
  let next = 2000;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const path = new URL(request.url, "http://x").pathname;
      const send = (data, status = 200) => response.writeHead(status).end(JSON.stringify(data));
      if (request.method !== "GET") calls.push(`${request.method} ${path}`);
      const one = path.match(/^\/api\/v3\/relations\/(\d+)$/);
      if (one) {
        const index = relations.findIndex((relation) => relation.id === Number(one[1]));
        if (index < 0) return send({ message: "not found" }, 404);
        if (request.method !== "DELETE") return send(relations[index]);
        relations.splice(index, 1);
        return response.writeHead(204).end();
      }
      const of = path.match(/^\/api\/v3\/work_packages\/(\d+)\/relations$/);
      if (!of) return send({}, 404);
      if (request.method === "POST") {
        const payload = JSON.parse(body);
        const from = idOf(payload._links.from.href);
        const to = idOf(payload._links.to.href);
        if (refuse === payload.type || pairRelation(relations, from, to)) return send({ message: "This relation would create a circular dependency." }, 422);
        relations.push(rel(next++, from, payload.type, to, payload.type === "blocks" ? "blocked" : payload.type));
        return send(relations.at(-1), 201);
      }
      send({ _embedded: { elements: relations.filter((relation) => touches(relation, Number(of[1]))) } });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, relations, url: `http://127.0.0.1:${server.address().port}` })));
}

function workspace(url) {
  const home = tempDir("tedy-op-relation-");
  mkdirSync(join(home, ".config", "op"), { recursive: true });
  writeFileSync(join(home, ".config", "op", "config.json"), JSON.stringify({ url, token: "test-token-value" }));
  const env = { ...process.env, HOME: home, TEDY_STATE_DIR: join(home, "state"), OP_SYNC_DIR: join(home, ".config", "op", "sync") };
  return (...args) => run("node", [SCRIPT, ...args], { env, cwd: home }).then((result) => result.stdout, (error) => `${error.stdout}${error.stderr}`);
}

test("relation previews, replaces the pair's old relation and reads the new one back", async () => {
  const { server, calls, relations, url } = await fakeOpenProject();
  const op = workspace(url);
  try {
    const preview = await op("relation", "21448", "21450", "--type", "blocks");
    assert.match(preview, /#21448 → #21450: relation 1000: #21450 relates #21448 → #21448 blocks #21450/);
    assert.match(preview, /1 relation delete \+ 1 relation create; run again with --apply/);
    assert.deepEqual(calls, []);
    assert.match(await op("relation", "21448", "21450", "--type", "blocks", "--apply"), /set relation 2000: #21448 blocks #21450/);
    assert.deepEqual(calls, ["DELETE /api/v3/relations/1000", "POST /api/v3/work_packages/21448/relations"]);
    assert.match(await op("relation", "21448", "21450", "--type", "blocks", "--apply"), /refused: relation 2000: #21448 blocks #21450 already says this/);
    assert.equal(relations.length, 2);
  } finally {
    server.close();
  }
});

test("a refused create puts the old relation back and lists both work packages' relations", async () => {
  const { server, calls, relations, url } = await fakeOpenProject({ refuse: "blocks" });
  const op = workspace(url);
  try {
    const out = await op("relation", "21448", "21452", "--type", "blocks", "--apply");
    assert.match(out, /create failed: .*HTTP 422: This relation would create a circular dependency/);
    assert.match(out, /restored #21452 relates #21448/);
    assert.match(out, /#21452 relations:\n {2}relation 2000: #21452 relates #21448/);
    assert.deepEqual(calls, ["DELETE /api/v3/relations/1004", "POST /api/v3/work_packages/21448/relations", "POST /api/v3/work_packages/21452/relations"]);
    assert.ok(relations.some((relation) => says(relation, 21452, "relates")));
  } finally {
    server.close();
  }
});

test("relation-delete previews, then deletes and checks it is gone", async () => {
  const { server, calls, url } = await fakeOpenProject();
  const op = workspace(url);
  try {
    assert.match(await op("relation-delete", "1004"), /relation 1004: #21452 relates #21448\n.*1 relation delete; run again with --apply/);
    assert.deepEqual(calls, []);
    assert.match(await op("relation-delete", "1004", "--apply"), /deleted relation 1004/);
    assert.deepEqual(calls, ["DELETE /api/v3/relations/1004"]);
  } finally {
    server.close();
  }
});
