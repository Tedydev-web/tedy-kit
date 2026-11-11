import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cardBlocks, linkedIds, readSince, searchSince, sweepPlan, writeSince } from "../lib/merged-sweep.mjs";
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
  assert.doesNotThrow(() => cardBlocks([{ id: 2, type: "Task", from: "a", to: "b", assign: null, event: "merged", prs: [pr(11, "merged")] }]));
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

test("the card body holds one set block per work package, by the absolute plugin path, with its row under it, and passes the card check", async () => {
  const { cardBlocks } = await import("../lib/merged-sweep.mjs");
  const { cardRefusal, readCard } = await import("../lib/pending-cards.mjs");
  const { updates } = sweepPlan({ gathered: [entry(wp(1, "Task", "Merged/Code Review"), [pr(1, "merged")]), entry(wp(2, "Bug", "In progress"), [pr(2, "merged")], ["Tester"])], meId: 140, tracker: TRACKER });
  const scripts = new URL("../scripts/", import.meta.url).pathname;
  const body = cardBlocks(updates);
  assert.equal(body, `### 1\nnode "${scripts}openproject.mjs" set 1 --status "Closed"\n- #1 Task 1 (Task, Merged/Code Review → Closed) · merged: shop-fe#1 https://github.com/o/shop-fe/pull/1\n\n### 2\nnode "${scripts}openproject.mjs" set 2 --status "Fixed (Dev Done)" --assignee "Tess Ter"\n- #2 Bug 2 (Bug, In progress → Fixed (Dev Done), assign Tess Ter) · merged: shop-fe#2 https://github.com/o/shop-fe/pull/2\n`);
  assert.equal(cardRefusal(readCard(`kind: publish\ntitle: Status\njob: none\npreview: run\n\n${body}`)), null);
});

test("card blocks quote a plugin path with a space and names with quotes, and still pass the card check", async () => {
  const { cpSync } = await import("node:fs");
  const { pathToFileURL } = await import("node:url");
  const { tokenize } = await import("../lib/shell-segments.mjs");
  const plugin = join(tempDir("tedy-sweep-space-"), "sp ace", "plugin");
  for (const dir of ["lib", "scripts", "gates", "shared"]) cpSync(new URL(`../${dir}/`, import.meta.url).pathname, join(plugin, dir), { recursive: true });
  const copied = await import(pathToFileURL(join(plugin, "lib", "merged-sweep.mjs")).href);
  const { cardRefusal, readCard } = await import(pathToFileURL(join(plugin, "lib", "pending-cards.mjs")).href);
  const update = (id, to, assign = null) => ({ id, subject: "s", type: "Task", from: "a", to, assign, event: "merged", prs: [] });
  const odd = `He said "hi" and it's $5 \\ ok`;
  const card = readCard(`kind: publish\ntitle: S\njob: none\npreview: run\n\n${copied.cardBlocks([update(1, "Won't fix"), update(2, 'Say "done"', "O'Neil"), update(3, odd, "D'Arcy \"DJ\"")])}`);
  assert.equal(cardRefusal(card), null);
  const script = join(plugin, "scripts", "openproject.mjs");
  assert.deepEqual(card.blocks.map((block) => tokenize(block.command)), [
    ["node", script, "set", "1", "--status", "Won't fix"],
    ["node", script, "set", "2", "--status", 'Say "done"', "--assignee", "O'Neil"],
    ["node", script, "set", "3", "--status", odd, "--assignee", "D'Arcy \"DJ\""],
  ]);
  assert.throws(() => copied.cardBlocks([update(4, "Two\nlines")]), /#4: the name holds a line break, so no card command can carry it/);
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
  return { run, files, repo, state, host: `127.0.0.1_${port}`, close: () => server.close() };
}

test("a sweep writes one run card with a block per update and no hand-off, even in a map that lists a pm session, moves the mark, and a sweep with nothing new writes no card", async () => {
  const { parse } = await import("../lib/handoff.mjs");
  const { CARD_KEYS, readCard } = await import("../lib/pending-cards.mjs");
  const world = await inboxWorld({ sessions: [{ name: "PM - Shop", role: "pm" }] });
  try {
    const out = await world.run([]);
    const cards = await world.files("drafts");
    assert.equal(cards.length, 1, out);
    assert.match(out, new RegExp(`^card: ${cards[0]}$`, "m"));
    const text = readFileSync(cards[0], "utf8");
    const fields = parse(text, CARD_KEYS);
    assert.deepEqual([fields.kind, fields.preview, fields.job, fields.records, fields.title], ["publish", "run", "none", `op:${world.host}:wp:21,op:${world.host}:wp:22`, "Status from PRs: 2 work package(s)"]);
    assert.deepEqual(readCard(text).blocks.map((block) => block.command.replace(/^node "[^"]+\/openproject\.mjs" /, "")), ['set 21 --status "Closed"', 'set 22 --status "Closed"']);
    assert.deepEqual(await world.files("reports"), []);
    const mark = readSince("shop", world.state);
    assert.notEqual(mark, null);
    const again = await world.run(["--inbox"]);
    assert.equal((await world.files("drafts")).length, 1, again);
    assert.doesNotMatch(again, /^card: /m);
    assert.notEqual(readSince("shop", world.state), null);
  } finally {
    world.close();
  }
});

test("--job names the job in the card and on every set command, and the card passes the card check", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { parse } = await import("../lib/handoff.mjs");
  const { CARD_KEYS, cardRefusal, readCard } = await import("../lib/pending-cards.mjs");
  const { tokenize } = await import("../lib/shell-segments.mjs");
  const world = await inboxWorld({ sessions: [] });
  try {
    const { repo } = world;
    const job = join(repo, "plans", "jobs", "261106-0900-review-sweep.md");
    mkdirSync(join(repo, "plans", "jobs"), { recursive: true });
    writeFileSync(job, "to: tedy:review\nfrom: cockpit\nstatus: running\ncreated: 2026-11-06T02:00:00.000Z\ntitle: sweep\n\nbody\n");
    const out = await world.run(["--job", job]);
    const [card] = await world.files("drafts");
    assert.ok(card, out);
    const text = readFileSync(card, "utf8");
    assert.equal(parse(text, CARD_KEYS).job, job);
    const blocks = readCard(text).blocks.map((block) => tokenize(block.command));
    assert.equal(blocks.length, 2);
    for (const tokens of blocks) assert.deepEqual(tokens.slice(-2), ["--job", job]);
    assert.equal(cardRefusal(readCard(text), repo), null);
  } finally {
    world.close();
  }
});

test("--job without a file, and the removed --handoff and --from, are refused before the sweep runs, while --inbox is still taken", async () => {
  for (const args of [["--job"], ["--inbox", "--job"], ["--handoff", "--from", "Review - Shop"], ["--from", "Review - Shop"]]) {
    const { out, mark } = await sweepRun(args, false);
    assert.equal(out.status, 2, args.join(" "));
    assert.equal(out.stderr, "usage: merged-sweep.mjs [--since <ISO time>] [--job <job file>]\n", args.join(" "));
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
