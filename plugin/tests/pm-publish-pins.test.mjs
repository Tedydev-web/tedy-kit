import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const lib = (name) => new URL(`../lib/${name}.mjs`, import.meta.url).pathname;

const FETCH_STUB = `
import { appendFileSync, readFileSync } from "node:fs";
globalThis.fetch = async (url, options = {}) => {
  const method = options.method ?? "GET";
  appendFileSync(process.env.FETCH_LOG, JSON.stringify([method, String(url)]) + "\\n");
  const routes = JSON.parse(readFileSync(process.env.FETCH_FIXTURE, "utf8"));
  const hit = routes.find(([verb, part]) => verb === method && String(url).includes(part));
  if (!hit) return new Response(JSON.stringify({ message: "no route" }), { status: 404 });
  return new Response(JSON.stringify(hit[2]), { status: 200 });
};
`;

const FAKE_RCLONE = `#!/usr/bin/env node
if (process.argv[2] === "config") process.stdout.write(JSON.stringify({ gdrive: { token: JSON.stringify({ access_token: "a", refresh_token: "r", expiry: "2999-01-01T00:00:00Z" }) } }));
`;

function setup() {
  const work = tempDir("tedy-pm-pub-");
  const stub = join(work, "fetch-stub.mjs");
  writeFileSync(stub, FETCH_STUB);
  const bin = join(work, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "rclone"), FAKE_RCLONE);
  chmodSync(join(bin, "rclone"), 0o755);
  mkdirSync(join(process.env.HOME, ".config", "figma"), { recursive: true });
  writeFileSync(join(process.env.HOME, ".config", "figma", "token"), "figma-test-token\n");
  const profileDir = profileWith({ language: { chat: "vi" } });
  mkdirSync(join(profileDir, "projects"));
  const map = { name: "p", paths: [work], repos: [{ path: ".", role: "frontend" }], language: { pr_review: "vi", doc_figma: "vi" }, figma: { file: "F1" }, prd: { doc: "D1" } };
  writeFileSync(join(profileDir, "projects", "p.md"), `\`\`\`json\n${JSON.stringify(map)}\n\`\`\`\n`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEDY_PROFILE_DIR: profileDir, TEDY_STATE_DIR: tempDir("tedy-pm-state-"), FETCH_FIXTURE: join(work, "routes.json"), FETCH_LOG: join(work, "fetch.log") };
  const run = (script, args, routes) => {
    writeFileSync(env.FETCH_FIXTURE, JSON.stringify(routes));
    writeFileSync(env.FETCH_LOG, "");
    const result = spawnSync("node", ["--import", stub, lib(script), ...args], { cwd: work, encoding: "utf8", env });
    const calls = readFileSync(env.FETCH_LOG, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { status: result.status, out: `${result.stdout}${result.stderr}`, posts: calls.filter(([method]) => method === "POST") };
  };
  return { work, run };
}

const frame = (text) => ({ id: "1:2", type: "FRAME", name: "Card", absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 }, children: [{ id: "1:3", type: "TEXT", characters: text }] });
const BODY = "@an frame Card thiếu trạng thái lỗi nha\n";

test("a Figma post needs the lint's pin and refuses when the commented node changed after it", () => {
  const { work, run } = setup();
  writeFileSync(join(work, "c.txt"), BODY);
  const figma = (version, latest) => [
    ["GET", "/files/F1?depth=1", { version }],
    ["GET", "/files/F1/nodes?ids=1%3A2&version=v1", { nodes: { "1:2": { document: frame("Pay") } } }],
    ["GET", "/files/F1/nodes?ids=1%3A2", { nodes: { "1:2": { document: latest } } }],
    ["GET", "/files/F1/comments", { comments: [{ id: "c9", message: BODY.trim() }] }],
    ["POST", "/files/F1/comments", { id: "c9" }],
  ];
  const unlinted = run("figma-comments", ["post", "1-2", "--body-file", "c.txt"], figma("v1", frame("Pay")));
  assert.equal(unlinted.status, 1);
  assert.match(unlinted.out, /^figma-comments: refused: c\.txt has no pinned sources; run draft-lint\.mjs figma-comment c\.txt, then ask the user again$/m);
  assert.equal(unlinted.posts.length, 0);
  const lint = run("draft-lint", ["figma-comment", "c.txt"], figma("v1", frame("Pay")));
  assert.equal(lint.status, 0, lint.out);
  assert.match(lint.out, /^pinned: Figma F1 version v1$/m);
  const changed = run("figma-comments", ["post", "1-2", "--body-file", "c.txt"], figma("v2", frame("Pay now")));
  assert.equal(changed.status, 1);
  assert.match(changed.out, /^figma-comments: refused: Figma F1 version changed from v1 to v2 since the draft was linted and node 1:2 changed; re-read the changed sources, fix the draft, lint it again and ask the user again$/m);
  assert.equal(changed.posts.length, 0);
  const kept = run("figma-comments", ["post", "1-2", "--body-file", "c.txt"], figma("v2", frame("Pay")));
  assert.equal(kept.status, 0, kept.out);
  assert.match(kept.out, /^notice: Figma F1 version changed from v1 to v2 since the draft was linted; node 1:2 is unchanged, so it posts as drafted$/m);
  assert.equal(kept.posts.length, 1);
});

test("a Google Doc reply refuses when the Doc changed after the lint pinned it", () => {
  const { work, run } = setup();
  writeFileSync(join(work, "r.txt"), "Mình chốt theo Figma nha\n");
  const doc = (version) => [
    ["GET", "/v1/documents/D1?includeTabsContent=true", { tabs: [{ tabProperties: { tabId: "t.0" }, documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: `Crypto ${version}\n` } }] } }] } } }] }],
    ["GET", "/drive/v3/files/D1/comments", { comments: [{ id: "t1", content: "q", resolved: false, author: { displayName: "PM", me: false }, replies: [{ id: "x", content: "Mình chốt theo Figma nha", author: { displayName: "me", me: true } }] }] }],
    ["POST", "/drive/v3/files/D1/comments/t1/replies", { id: "x" }],
  ];
  const lint = run("draft-lint", ["doc-comment", "r.txt"], doc(7));
  assert.equal(lint.status, 0, lint.out);
  assert.match(lint.out, /^pinned: Google Doc D1 text [0-9a-f]{12}$/m);
  const changed = run("gdoc-comments", ["reply", "t1", "--body-file", "r.txt"], doc(8).map((route, index) => (index === 1 ? [route[0], route[1], { comments: [] }] : route)));
  assert.equal(changed.status, 1);
  assert.match(changed.out, /^gdoc-comments: refused: Google Doc D1 text changed from [0-9a-f]{12} to [0-9a-f]{12} since the draft was linted; re-read the changed sources, fix the draft, lint it again and ask the user again$/m);
  assert.equal(changed.posts.length, 0);
});
