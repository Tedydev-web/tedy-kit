import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stamp } from "./pending.mjs";
import { itemCommand } from "./publish-batch.mjs";
import { STATE_DIR } from "./hook-io.mjs";
import { loadConfig } from "./openproject-client.mjs";
import { resolveMap } from "./project-map.mjs";
import { notBefore, sinceTime } from "./since.mjs";
import { gatherFacts, listPullRequests } from "./op-status.mjs";
import { mapRepos } from "./source-pin-git.mjs";
import { flowOf, linkedIds, planStatus } from "./status-flow.mjs";

export const searchSince = (since) => `${new Date(sinceTime(since)).toISOString().slice(0, 19)}Z`;

const FIRST_RUN_DAYS = 7;

export { linkedIds };

const assigneeId = (workPackage) => Number(workPackage._links.assignee?.href?.split("/").pop()) || null;

export function sweepPlan({ gathered, meId, tracker }) {
  const updates = [];
  const skipped = [];
  for (const { id, workPackage, facts } of [...gathered].sort((a, b) => a.id - b.id)) {
    if (!workPackage) {
      skipped.push({ id, why: "not found" });
      continue;
    }
    if (assigneeId(workPackage) !== meId) {
      skipped.push({ id, why: "assigned to someone else" });
      continue;
    }
    const plan = planStatus(facts, tracker);
    if (plan.skip) skipped.push({ id, why: plan.skip });
    else {
      const prs = facts.prs.filter((pr) => pr.base === pr.integration && pr.state !== "closed");
      updates.push({ id, subject: workPackage.subject, type: facts.type, from: facts.status, to: plan.to, assign: plan.assign === "author" ? workPackage._links.author.title : null, lock: workPackage.lockVersion, event: plan.event, prs });
    }
  }
  return { updates, skipped };
}

export const batchItems = (updates) => updates.map((update) => ["openproject.mjs", "set", String(update.id), "--status", update.to, ...(update.assign ? ["--assignee", update.assign] : []), "--apply", "--lock", String(update.lock)]);

function writeBatch(map, updates) {
  const dir = join(map.paths[0], "plans", "drafts");
  mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n += 1) {
    const file = join(dir, `${stamp()}-status-from-prs${n === 1 ? "" : `-${n}`}.json`);
    try {
      writeFileSync(file, `${JSON.stringify({ items: batchItems(updates) }, null, 2)}\n`, { flag: "wx" });
      return file;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

const sincePath = (dir) => join(dir, "merged-sweep.json");

function readAll(dir) {
  return existsSync(sincePath(dir)) ? JSON.parse(readFileSync(sincePath(dir), "utf8")) : {};
}

export const readSince = (name, dir = STATE_DIR) => readAll(dir)[name] ?? null;

export function writeSince(name, at, dir = STATE_DIR) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${sincePath(dir)}.tmp`, `${JSON.stringify({ ...readAll(dir), [name]: at }, null, 2)}\n`);
  renameSync(`${sincePath(dir)}.tmp`, sincePath(dir));
}

function listedPrs(map, since, withOpen) {
  const prs = [];
  const skipped = [];
  for (const repo of map.repos ?? []) {
    const dir = isAbsolute(repo.path) ? repo.path : resolve(map.paths[0], repo.path);
    const list = (args) => JSON.parse(execFileSync("gh", ["pr", "list", ...args, "--limit", "100", "--json", "number,title,body,mergedAt,createdAt,url"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    try {
      prs.push(...list(["--state", "merged", "--search", `merged:>=${searchSince(since)}`]).filter((pr) => notBefore(pr.mergedAt, since)).map((pr) => ({ ...pr, repo: repo.path })));
      if (withOpen) prs.push(...list(["--state", "open", "--author", "@me"]).filter((pr) => notBefore(pr.createdAt, since)).map((pr) => ({ ...pr, mergedAt: null, repo: repo.path })));
    } catch (error) {
      skipped.push(repo.path);
      console.log(`skip ${repo.path}: ${String(error.stderr || error.message).split("\n")[0]}`);
    }
  }
  return { prs, skipped };
}

async function main(argv) {
  const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  if (["--handoff", "--from", "--job"].some((name) => argv.includes(name))) {
    console.error("usage: merged-sweep.mjs [--since <ISO time>]");
    return 2;
  }
  const resolved = resolveMap(process.cwd());
  if (!resolved) throw new Error(`no project map covers ${process.cwd()}; run /tedy:setup`);
  const { map } = resolved;
  if (!Object.keys(flowOf(map.tracker ?? {})).length) {
    console.log(`the map ${map.name} has no tracker.flow or tracker.merge_status; add the status per work package type with /tedy:setup update`);
    return 1;
  }
  const startedAt = new Date().toISOString();
  const since = flag("--since") ?? readSince(map.name) ?? new Date(Date.now() - FIRST_RUN_DAYS * 86_400_000).toISOString();
  sinceTime(since);
  const { prs, skipped } = listedPrs(map, since, true);
  const ids = [...new Set(prs.flatMap((pr) => linkedIds(pr.body)))];
  console.log(`since ${since}: ${prs.filter((pr) => pr.mergedAt).length} merged and ${prs.filter((pr) => !pr.mergedAt).length} newly opened PR(s), ${ids.length} linked work package(s)`);
  let updates = [];
  if (ids.length) {
    const client = loadConfig();
    const meId = (await client.request("/api/v3/users/me")).id;
    const repos = mapRepos(map).map((repo) => ({ ...repo, integration: repo.branches[0] }));
    const gathered = [];
    for (const id of ids) {
      try {
        gathered.push({ id, ...(await gatherFacts(id, { request: (path) => client.request(path), listPrs: listPullRequests, repos, project: map.tracker.project, started: false })) });
      } catch (error) {
        console.log(`#${id}: ${error.message}`);
        gathered.push({ id });
      }
    }
    const picked = sweepPlan({ gathered, meId, tracker: map.tracker });
    updates = picked.updates;
    for (const update of updates) console.log(`update #${update.id} ${update.type} ${update.from} → ${update.to}${update.assign ? `, assign ${update.assign}` : ""} · ${update.event} ${update.prs.map((pr) => `${pr.repo}#${pr.number}`).join(", ")}`);
    for (const skip of picked.skipped) console.log(`skip #${skip.id}: ${skip.why}`);
  }
  if (updates.length) {
    const path = writeBatch(map, updates);
    console.log(`batch: ${path}\n${itemCommand(["publish-batch.mjs", path, "--summary"])}`);
  }
  if (skipped.length) console.log(`mark kept at ${since}: ${skipped.length} repo(s) could not be listed`);
  else writeSince(map.name, startedAt);
  return 0;
}

export function run() {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`merged-sweep: ${error.message}`);
      process.exit(1);
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
