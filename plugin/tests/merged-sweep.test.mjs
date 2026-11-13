import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { batchItems, linkedIds, readSince, searchSince, sweepPlan, writeSince } from "../lib/merged-sweep.mjs";
import { batchSummary, readBatch } from "../lib/publish-batch.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const wp = (id, type, status, assignee = 140) => ({
  id,
  subject: `${type} ${id}`,
  lockVersion: 3,
  _links: { type: { title: type }, status: { title: status }, assignee: assignee ? { href: `/api/v3/users/${assignee}` } : { href: null }, author: { href: "/api/v3/users/9", title: "Tess Ter" } },
});
const pr = (number, state, extra = {}) => ({ repo: "shop-fe", number, state, base: "dev", integration: "dev", title: `fix: pr ${number}`, mergedAt: state === "merged" ? `2026-10-09T0${number % 10}:00:00Z` : null, url: `https://github.com/o/shop-fe/pull/${number}`, ...extra });
const entry = (workPackage, prs, authorRoles = ["Developer"]) => ({ id: workPackage.id, workPackage, facts: { type: workPackage._links.type.title, status: workPackage._links.status.title, authorRoles, started: false, assigneeIsAuthor: false, prs } });
const TRACKER = {
  not_started: ["New", "Specified"],
  flow: {
    Task: { start: "In progress", review: "Merged/Code Review", merged: "Closed", revert: "In progress" },
    Bug: { start: "In progress", review: "Merged/Code Review", merged: "Closed", revert: "Re-Work", by_role: { Tester: { merged: "Fixed (Dev Done)", assign: "author" } } },
  },
};

test("linked ids come from OP#id and work package links in the PR body, once each", () => {
  assert.deepEqual(linkedIds("OP#21298\nSee https://task.example.com/work_packages/21299 and OP#21298 again"), [21298, 21299]);
  assert.deepEqual(linkedIds("Fixes #712 and refs 21298"), []);
  assert.deepEqual(linkedIds(null), []);
});

test("a kit-written PR body links only the package in its header, not packages its copied description names", () => {
  const body = "OP#21298\n\nTask read at 2026-11-04T09:00:00Z\n\n## Cart total\n\nDepends on OP#21300; see https://task.example.com/work_packages/21301\n";
  assert.deepEqual(linkedIds(body), [21298]);
  assert.deepEqual(linkedIds(body.replaceAll("\n", "\r\n")), [21298]);
});

test("only the user's own packages move, each to what all its PRs say, and the rest are skipped with the reason", () => {
  const gathered = [
    entry(wp(1, "Task", "Merged/Code Review"), [pr(1, "merged")]),
    entry(wp(2, "Bug", "In progress"), [pr(2, "merged")], ["Tester"]),
    entry(wp(3, "Task", "In progress", 77), [pr(3, "merged")]),
    entry(wp(4, "Task", "Merged/Code Review"), [pr(4, "merged"), pr(14, "open")]),
    entry(wp(5, "User story", "New"), [pr(5, "merged")]),
    entry(wp(6, "Task", "On hold"), [pr(6, "merged")]),
    { id: 8 },
  ];
  const { updates, skipped } = sweepPlan({ gathered, meId: 140, tracker: TRACKER });
  assert.deepEqual(updates.map((update) => [update.id, update.from, update.to, update.assign, update.event]), [
    [1, "Merged/Code Review", "Closed", null, "merged"],
    [2, "In progress", "Fixed (Dev Done)", "Tess Ter", "merged"],
  ]);
  assert.deepEqual(skipped.map((skip) => `${skip.id} ${skip.why}`), ["3 assigned to someone else", "4 already Merged/Code Review", "5 type User story has no flow in the map", "6 On hold is outside the flow, so a person set it", "8 not found"]);
});

test("a map that still has merge_status, open_status and revert_status keeps working", () => {
  const legacy = { not_started: ["New"], merge_status: { Task: "Merged/Code Review" }, open_status: { Task: "In progress" }, revert_status: { Task: "In progress" } };
  const gathered = [entry(wp(1, "Task", "New"), [pr(1, "open")]), entry(wp(2, "Task", "In progress"), [pr(2, "merged")]), entry(wp(3, "Task", "Merged/Code Review"), [pr(3, "merged"), pr(13, "merged", { title: "Revert x", mergedAt: "2026-10-09T09:00:00Z" })])];
  assert.deepEqual(sweepPlan({ gathered, meId: 140, tracker: legacy }).updates.map((update) => [update.id, update.to, update.event]), [
    [1, "In progress", "review"],
    [2, "Merged/Code Review", "merged"],
    [3, "In progress", "revert"],
  ]);
});

test("the sweep remembers where it stopped per project", () => {
  const dir = tempDir("tedy-sweep-");
  assert.equal(readSince("shop", dir), null);
  writeSince("shop", "2026-10-09T03:00:00Z", dir);
  writeSince("other", "2026-10-01T00:00:00Z", dir);
  assert.equal(readSince("shop", dir), "2026-10-09T03:00:00Z");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "merged-sweep.json"), "utf8")), { shop: "2026-10-09T03:00:00Z", other: "2026-10-01T00:00:00Z" });
});

test("the sweep's GitHub search mark is the same instant as the stored mark, whatever offset it carries, and a missing subject is tolerated", () => {
  assert.equal(searchSince("2026-10-17T10:00:00+07:00"), "2026-10-17T03:00:00Z");
  assert.equal(searchSince("2026-10-17T03:00:00.000Z"), "2026-10-17T03:00:00Z");
  assert.doesNotThrow(() => batchItems([{ id: 2, type: "Task", from: "a", to: "b", assign: null, lock: 1, event: "merged", prs: [pr(11, "merged")] }]));
});

const sweepRun = async (args, ghExit) => {
  const { spawnSync } = await import("node:child_process");
  const { chmodSync, mkdirSync, writeFileSync } = await import("node:fs");
  const root = tempDir("tedy-sweep-");
  const repo = join(root, "repo");
  const profile = join(root, "profile");
  const state = join(root, "state");
  const bin = join(root, "bin");
  for (const dir of [repo, join(profile, "projects"), bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(profile, "projects", "shop.md"), `# map\n\n\`\`\`json\n${JSON.stringify({ name: "shop", paths: [repo], repos: [{ path: ".", role: "FE" }], tracker: { merge_status: { Task: "Merged" } } })}\n\`\`\`\n`);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n${ghExit ? 'echo "gh: not logged in" >&2; exit 1' : "echo '[]'"}\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const out = spawnSync("node", [new URL("../scripts/merged-sweep.mjs", import.meta.url).pathname, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: state } });
  return { out, mark: readSince("shop", state) };
};

test("a --since that is not a date stops the sweep before any repo is listed and keeps the stored mark", async () => {
  const { out, mark } = await sweepRun(["--since", "last monday"], false);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /--since is not a date: last monday/);
  assert.doesNotMatch(out.stdout, /skip /);
  assert.equal(mark, null);
});

test("a repo that cannot be listed keeps the stored mark so its merged PRs are swept next time", async () => {
  const { out, mark } = await sweepRun(["--since", "2026-10-01T00:00:00Z"], true);
  assert.match(out.stdout, /skip \.: gh: not logged in/);
  assert.match(out.stdout, /mark kept at 2026-10-01T00:00:00Z/);
  assert.equal(mark, null);
});

test("the batch holds one set item per work package with --apply and the lock it was planned at, and publish-batch reads and summarises it", () => {
  const { updates } = sweepPlan({ gathered: [entry(wp(1, "Task", "Merged/Code Review"), [pr(1, "merged")]), entry(wp(2, "Bug", "In progress"), [pr(2, "merged")], ["Tester"])], meId: 140, tracker: TRACKER });
  const items = batchItems(updates);
  assert.deepEqual(items, [
    ["openproject.mjs", "set", "1", "--status", "Closed", "--apply", "--lock", "3"],
    ["openproject.mjs", "set", "2", "--status", "Fixed (Dev Done)", "--assignee", "Tess Ter", "--apply", "--lock", "3"],
  ]);
  const file = join(tempDir("tedy-sweep-batch-"), "batch.json");
  writeFileSync(file, JSON.stringify({ items }));
  assert.deepEqual(readBatch(file), items);
  assert.equal(batchSummary(items, "/", "en"), "Publish 2 items under your name: 1) OP #1 set status=Closed; 2) OP #2 set status=Fixed (Dev Done), assignee=Tess Ter");
});

async function inboxWorld({ sessions }) {
  const { execFile } = await import("node:child_process");
  const { chmodSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { createServer } = await import("node:http");
  const { promisify } = await import("node:util");
  const root = tempDir("tedy-sweep-inbox-");
  const repo = join(root, "repo");
  const profile = join(root, "profile");
  const state = join(root, "state");
  const bin = join(root, "bin");
  for (const dir of [repo, join(profile, "projects"), bin, join(root, ".config", "op")]) mkdirSync(dir, { recursive: true });
  const mergedAt = new Date(Date.now() - 3_600_000).toISOString();
  const merged = { number: 5, title: "fix: cart", body: "OP#21 OP#22", mergedAt, createdAt: mergedAt, url: "https://github.com/o/shop-fe/pull/5" };
  writeFileSync(join(root, "gh.json"), JSON.stringify({ merged: [merged], all: [{ ...merged, state: "MERGED", baseRefName: "dev" }] }));
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node\nconst fx = JSON.parse(require("node:fs").readFileSync(process.env.GH_FIXTURE, "utf8"));\nconst args = process.argv.slice(2);\nconst state = args[args.indexOf("--state") + 1];\nprocess.stdout.write(JSON.stringify(state === "merged" ? fx.merged : state === "all" ? fx.all : []));\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const work = (id, status) => ({ id, subject: `Task ${id}`, lockVersion: 1, _links: { type: { title: "Task" }, status: { title: status }, assignee: { href: "/api/v3/users/140" }, author: { href: "/api/v3/users/9", title: "Tess Ter" } } });
  const packages = { 21: work(21, "Merged/Code Review"), 22: work(22, "In progress") };
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://x").pathname;
    const send = (data, status = 200) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (path === "/api/v3/users/me") return send({ id: 140 });
    if (path === "/api/v3/memberships") return send({ _embedded: { elements: [{ _links: { roles: [{ title: "Developer" }] } }] } });
    const id = path.match(/^\/api\/v3\/work_packages\/(\d+)$/)?.[1];
    return packages[id] ? send(packages[id]) : send({}, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  writeFileSync(join(root, ".config", "op", "config.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, token: "test-" + "token-value" }));
  const tracker = { project: 183, not_started: ["New"], flow: { Task: { start: "In progress", review: "Merged/Code Review", merged: "Closed", revert: "In progress" } } };
  writeFileSync(join(profile, "projects", "shop.md"), `# map\n\n\`\`\`json\n${JSON.stringify({ name: "shop", paths: [repo], repos: [{ path: ".", role: "FE", branch: "dev" }], tracker, sessions })}\n\`\`\`\n`);
  const env = { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, GH_FIXTURE: join(root, "gh.json"), TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: state };
  const run = (args) => promisify(execFile)("node", [new URL("../scripts/merged-sweep.mjs", import.meta.url).pathname, ...args], { cwd: repo, env }).then(({ stdout }) => stdout, (error) => assert.fail(`${error.stdout}${error.stderr}`));
  const files = async (sub) => {
    const { existsSync, readdirSync } = await import("node:fs");
    return existsSync(join(repo, "plans", sub)) ? readdirSync(join(repo, "plans", sub)).map((name) => join(repo, "plans", sub, name)) : [];
  };
  return { run, files, repo, state, env, close: () => server.close() };
}

test("a sweep writes one ready batch under plans/drafts with an item per update, prints its --summary command, which publish-batch runs, and moves the mark; a sweep with nothing new writes none", async () => {
  const { execFileSync } = await import("node:child_process");
  const world = await inboxWorld({ sessions: [{ name: "PM - Shop", role: "pm" }] });
  try {
    const out = await world.run([]);
    const drafts = await world.files("drafts");
    assert.equal(drafts.length, 1, out);
    assert.match(drafts[0], /\/plans\/drafts\/\d{6}-\d{4}-status-from-prs\.json$/);
    assert.match(out, new RegExp(`^batch: ${drafts[0]}$`, "m"));
    assert.deepEqual(readBatch(drafts[0]), [
      ["openproject.mjs", "set", "21", "--status", "Closed", "--apply", "--lock", "1"],
      ["openproject.mjs", "set", "22", "--status", "Closed", "--apply", "--lock", "1"],
    ]);
    const command = out.split("\n").find((line) => line.startsWith("node ") && line.endsWith(" --summary"));
    assert.ok(command, out);
    const [, script, batch] = command.split(" ");
    assert.match(script, /\/scripts\/publish-batch\.mjs$/);
    assert.equal(batch, drafts[0]);
    const summary = execFileSync("node", [script, batch, "--summary"], { cwd: world.repo, env: world.env, encoding: "utf8" });
    assert.match(summary, /OP #21 set status=Closed; 2\) OP #22 set status=Closed/);
    assert.doesNotMatch(out, /^card: /m);
    assert.deepEqual(await world.files("reports"), []);
    assert.notEqual(readSince("shop", world.state), null);
    const again = await world.run(["--inbox"]);
    assert.equal((await world.files("drafts")).length, 1, again);
    assert.doesNotMatch(again, /^batch: /m);
  } finally {
    world.close();
  }
});

test("--job and the removed --handoff and --from are refused before the sweep runs, while --inbox is still taken", async () => {
  for (const args of [["--job"], ["--job", "plans/jobs/a.md"], ["--inbox", "--job"], ["--handoff", "--from", "Review - Shop"], ["--from", "Review - Shop"]]) {
    const { out, mark } = await sweepRun(args, false);
    assert.equal(out.status, 2, args.join(" "));
    assert.equal(out.stderr, "usage: merged-sweep.mjs [--since <ISO time>]\n", args.join(" "));
    assert.equal(mark, null, args.join(" "));
  }
  const inbox = await sweepRun(["--since", "2026-10-01T00:00:00Z", "--inbox"], false);
  assert.equal(inbox.out.status, 0, inbox.out.stderr);
  assert.notEqual(inbox.mark, null);
});

test("a clean sweep moves the stored mark", async () => {
  const { out, mark } = await sweepRun(["--since", "2026-10-01T00:00:00Z"], false);
  assert.equal(out.status, 0, out.stderr);
  assert.notEqual(mark, null);
});
