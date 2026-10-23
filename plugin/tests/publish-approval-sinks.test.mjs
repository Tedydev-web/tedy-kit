import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { recordApprovals } from "../lib/publish-approval-ticket.mjs";
import { LABELS } from "../lib/labels.mjs";
import { stateDenyRules } from "../lib/publish-approval-settings.mjs";
import { pullRequestCheckout } from "./git-sibling-for-tests.mjs";
import { mappedProfile, tempDir } from "./temp-dir-for-tests.mjs";

const VI = LABELS.vi;
const ACCEPTED = [VI["post.asIs"], VI["approve.all"]];
const SCRIPTS = new URL("../scripts/", import.meta.url).pathname;
const GH = join(SCRIPTS, "github-write.mjs");
const OP = join(SCRIPTS, "openproject.mjs");
const FIGMA = join(SCRIPTS, "figma-comments.mjs");
const BODY = "Fixed it.";

const FAKE_GH = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
const fx = JSON.parse(readFileSync(process.env.GH_FIXTURE, "utf8"));
const out = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
if (args.includes("graphql")) out(fx.graphql ?? {});
else if (args[0] === "pr" && args[1] === "view" && args.includes("headRefOid")) out(fx.head ?? "");
else if (args[0] === "pr" && args[1] === "view") out(fx.prView ?? {});
else if (args[0] === "api" && args[1] === "user") out(fx.login ?? "");
else if (args.some((t) => /^-X/.test(t))) out(fx.write ?? {});
else if (args.some((t) => /\\/comments$/.test(t))) out([[]]);
else out("");
`;
const BIN = tempDir("tedy-sink-ghbin-");
writeFileSync(join(BIN, "gh"), FAKE_GH);
chmodSync(join(BIN, "gh"), 0o755);

function place(mode = "answer") {
  const dir = tempDir("tedy-sink-");
  const state = join(dir, "state");
  writeFileSync(join(dir, "b.md"), `${BODY}\n`);
  writeFileSync(join(dir, "p.md"), "OP#21298\n\nTask read now\n");
  const head = pullRequestCheckout(dir, 1).pr(1);
  const fixture = join(dir, "fx.json");
  writeFileSync(fixture, JSON.stringify({ write: { id: 77, html_url: "https://x/77" }, graphql: { data: { resolveReviewThread: { thread: { isResolved: true } } } }, prView: { number: 3, isDraft: true, author: { login: "me" }, body: "old" }, login: "me", head }));
  const log = join(dir, "gh.log");
  writeFileSync(log, "");
  const settings = join(dir, "claude-settings.json");
  writeFileSync(settings, JSON.stringify({ permissions: { deny: stateDenyRules(state) } }));
  const env = { ...process.env, TEDY_CLAUDE_SETTINGS: settings, PATH: `${BIN}:${process.env.PATH}`, GH_FIXTURE: fixture, GH_LOG: log, HOME: dir, TEDY_STATE_DIR: state, TEDY_PROFILE_DIR: mappedProfile(dir, { gates: mode ? { publishApproval: mode } : {}, language: { chat: "en" } }) };
  const writes = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((args) => args.some((token) => /^-X/.test(token)) || (args.includes("graphql") && args.some((token) => /mutation/.test(token))));
  const approve = (preview, text = "Đăng?") => recordApprovals({ session_id: "s", tool_use_id: "t", tool_input: { questions: [{ question: text, header: "x", options: [{ label: VI["post.asIs"], description: "d", preview }, { label: VI["post.hold"], description: "n" }] }] }, tool_response: { answers: { [text]: VI["post.asIs"] }, annotations: { [text]: { preview } } } }, { dir: join(state, "approvals"), accepted: ACCEPTED });
  const shell = (command, args) => spawnSync(command, args, { cwd: dir, env, encoding: "utf8" });
  const run = (script, args) => shell("node", [script, ...args]);
  const lint = () => {
    const result = run(join(SCRIPTS, "draft-lint.mjs"), ["pr-reply", "b.md", "--pr", "1"]);
    assert.equal(result.status, 0, result.stdout);
    return result.stdout.split("\n").filter((line) => line.startsWith("warning: ")).join("\n");
  };
  const warnings = lint();
  return { dir, env, state, writes, approve, run, shell, lint, warnings };
}

const reply = ["reply", "1", "2", "--repo", "o/r", "--body-file", "b.md"];
const REPLY_LINE = `node ${GH} ${reply.join(" ")}`;

test("answer mode: github-write refuses a write with no ticket, and writes nothing", () => {
  const { run, writes } = place();
  for (const args of [reply, ["resolve", "PRRT_x"], ["pr-body", "3", "--repo", "o/r", "--body-file", "p.md"]]) {
    const result = run(GH, args);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stdout + result.stderr, /no unused approval matches this write/, args.join(" "));
  }
  assert.deepEqual(writes(), []);
});

test("answer mode: a ticket with the command line and the body allows one write, then is spent", () => {
  const { run, writes, approve, warnings } = place();
  approve(`Trả lời thread 2:\n\n${BODY}\n${warnings}\n\n${REPLY_LINE}`);
  assert.equal(run(GH, reply).status, 0);
  assert.equal(writes().length, 1);
  assert.equal(run(GH, reply).status, 1);
  assert.equal(writes().length, 1);
});

test("answer mode: the body file edited after the approval no longer matches the ticket", () => {
  const { run, writes, approve, dir, lint } = place();
  approve(`${BODY}\n\n${REPLY_LINE}`);
  writeFileSync(join(dir, "b.md"), "Fixed it, and also the other one.\n");
  lint();
  const result = run(GH, reply);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no unused approval/);
  assert.deepEqual(writes(), []);
});

test("answer mode: a comment or a redirect that hides --dry-run from the shell still needs a ticket", () => {
  const { run, shell, writes, approve } = place();
  approve(`OP#21298\n\nTask read now\n\nnode ${GH} pr-body 3 --repo o/r --body-file p.md --dry-run`);
  for (const line of [`node ${GH} pr-body 3 --repo o/r --body-file p.md # --dry-run`, `node ${GH} pr-body 3 --repo o/r --body-file p.md > --dry-run`]) {
    const result = shell("bash", ["-c", line]);
    assert.notEqual(result.status, 0, line);
    assert.match(result.stderr, /no unused approval/, line);
  }
  assert.deepEqual(writes(), []);
  assert.equal(run(GH, ["pr-body", "3", "--repo", "o/r", "--body-file", "p.md", "--dry-run"]).status, 0);
  assert.deepEqual(writes(), []);
});

test("answer mode: a wrapper, a symlink or a script calling the CLI is checked the same way", () => {
  const { shell, writes, approve, dir, warnings } = place();
  const link = join(dir, "gw.mjs");
  symlinkSync(GH, link);
  writeFileSync(join(dir, "publish.mjs"), `import { execFileSync } from "node:child_process";\nexecFileSync("node", [${JSON.stringify(GH)}, ...${JSON.stringify(reply)}], { stdio: "inherit" });\n`);
  for (const [command, args] of [["env", ["node", GH, ...reply]], ["node", [link, ...reply]], ["node", [join(dir, "publish.mjs")]]]) assert.notEqual(shell(command, args).status, 0, args.join(" "));
  assert.deepEqual(writes(), []);
  approve(`${BODY}\n${warnings}\n\n${REPLY_LINE}`);
  assert.notEqual(shell("node", [link, ...reply]).status, 0);
  assert.equal(shell("env", ["node", GH, ...reply]).status, 0);
  assert.equal(writes().length, 1);
});

test("answer mode: two processes with one ticket, only one writes", async () => {
  const { env, writes, approve, dir, warnings } = place();
  approve(`${BODY}\n${warnings}\n\n${REPLY_LINE}`);
  const exec = promisify(execFile);
  const codes = await Promise.all(Array.from({ length: 4 }, () => exec("node", [GH, ...reply], { cwd: dir, env }).then(() => 0, (error) => error.code)));
  assert.equal(codes.filter((code) => code === 0).length, 1, codes.join(","));
  assert.equal(writes().length, 1);
});

test("ask mode is unchanged: no ticket needed", () => {
  for (const mode of ["ask", null]) {
    const { run, writes, state } = place(mode);
    assert.equal(run(GH, reply).status, 0, String(mode));
    assert.equal(writes().length, 1, String(mode));
    assert.throws(() => readdirSync(join(state, "approvals")));
  }
});

function fakeOpenProject() {
  const calls = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://x");
      if (request.method !== "GET") calls.push({ method: request.method, path: url.pathname, body });
      if (url.pathname.endsWith("/activities")) return response.end(JSON.stringify({ _embedded: { elements: calls.filter((call) => call.method === "POST").map((call, index) => ({ id: 500 + index, comment: { raw: JSON.parse(call.body).comment.raw } })) } }));
      response.end(JSON.stringify({ id: 5, subject: "[FE] Màn rỗng", lockVersion: 0, _links: { status: { title: "New" } } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

test("answer mode: openproject comment with --apply before --body-file needs the real body in the ticket", async () => {
  const { server, calls, url } = await fakeOpenProject();
  try {
    const { dir, env, approve } = place();
    mkdirSync(join(dir, ".config", "op", "sync"), { recursive: true });
    writeFileSync(join(dir, ".config", "op", "config.json"), JSON.stringify({ url, token: "test-" + "token-value" }));
    writeFileSync(join(dir, "c.md"), "Màn này thiếu trạng thái rỗng ạ?\n");
    const exec = promisify(execFile);
    const op = (...args) => exec("node", [OP, ...args], { cwd: dir, env: { ...env, OP_SYNC_DIR: join(dir, ".config", "op", "sync") } }).then((result) => ({ code: 0, out: result.stdout }), (error) => ({ code: error.code, out: `${error.stdout}${error.stderr}` }));
    const args = ["comment", "5", "--apply", "--body-file", "c.md"];
    assert.equal((await op("comment", "5", "--body-file", "c.md")).code, 0);
    approve(`node ${OP} ${args.join(" ")}`);
    const commandOnly = await op(...args);
    assert.equal(commandOnly.code, 1, commandOnly.out);
    assert.match(commandOnly.out, /no unused approval/);
    approve("Màn này thiếu trạng thái rỗng ạ?\n\n" + `node ${OP} ${args.join(" ")}`, "Lần 2?");
    writeFileSync(join(dir, "c.md"), "Màn này thiếu trạng thái rỗng ạ? Sửa sau khi duyệt.\n");
    assert.equal((await op(...args)).code, 1);
    assert.deepEqual(calls, []);
    writeFileSync(join(dir, "c.md"), "Màn này thiếu trạng thái rỗng ạ?\n");
    const posted = await op(...args);
    assert.equal(posted.code, 0, posted.out);
    assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ["POST /api/v3/work_packages/5/activities"]);
  } finally {
    server.close();
  }
});

test("answer mode: figma delete needs a ticket holding the exact command line", () => {
  const { dir, env, approve } = place();
  mkdirSync(join(dir, ".config", "figma"), { recursive: true });
  writeFileSync(join(dir, ".config", "figma", "token"), "figd_test\n");
  const log = join(dir, "fetch.log");
  writeFileSync(join(dir, "fake-fetch.mjs"), `import { appendFileSync } from "node:fs";\nglobalThis.fetch = async (url, options = {}) => {\n  if ((options.method ?? "GET") !== "GET") appendFileSync(${JSON.stringify(log)}, \`\${options.method} \${url}\\n\`);\n  const body = String(url).endsWith("/me") ? { handle: "me" } : { comments: [{ id: "1234", user: { handle: "me" } }, { id: "123", user: { handle: "me" } }] };\n  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });\n};\n`);
  const figma = (...args) => spawnSync("node", ["--import", join(dir, "fake-fetch.mjs"), FIGMA, ...args], { cwd: dir, env, encoding: "utf8" });
  const deletes = () => {
    try {
      return readFileSync(log, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  approve(`Xoá comment\nnode ${FIGMA} delete 1234 --file F`);
  assert.equal(figma("delete", "123", "--file", "F").status, 1);
  assert.deepEqual(deletes(), []);
  const done = figma("delete", "1234", "--file", "F");
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(deletes().length, 1);
});
