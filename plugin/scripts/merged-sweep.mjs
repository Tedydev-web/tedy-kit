import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { render, reportsDir, route, slugOf, stamp } from "./handoff.mjs";
import { STATE_DIR } from "./hook-io.mjs";
import { chatLanguage, fill, labels } from "./labels.mjs";
import { loadConfig } from "./openproject-client.mjs";
import { resolveMap } from "./project-map.mjs";

const LINK = /\bOP#(\d+)\b|\/work_packages\/(\d+)\b/g;
const FIRST_RUN_DAYS = 7;

export const linkedIds = (text) => [...new Set([...String(text ?? "").matchAll(LINK)].map((match) => Number(match[1] ?? match[2])))];

const assigneeId = (workPackage) => Number(workPackage._links.assignee?.href?.split("/").pop()) || null;

export function pickUpdates({ prs, workPackages, meId, targets }) {
  const latest = new Map();
  for (const pr of prs) {
    for (const id of linkedIds(pr.body)) {
      if (!latest.has(id) || latest.get(id).mergedAt < pr.mergedAt) latest.set(id, pr);
    }
  }
  const updates = [];
  const skipped = [];
  for (const id of [...latest.keys()].sort((a, b) => a - b)) {
    const workPackage = workPackages.get(id);
    const type = workPackage?._links.type.title;
    const status = workPackage?._links.status.title;
    const why = !workPackage ? "not found" : workPackage.closed ? "closed" : assigneeId(workPackage) !== meId ? "assigned to someone else" : !targets[type] ? `type ${type} has no merge status` : status === targets[type] ? `already ${status}` : null;
    if (why) skipped.push({ id, why });
    else updates.push({ id, subject: workPackage.subject, type, from: status, to: targets[type], lockVersion: workPackage.lockVersion, pr: latest.get(id) });
  }
  return { updates, skipped };
}

export function handoffBody(updates) {
  const rows = updates.map((update) => `- #${update.id} ${update.subject} (${update.type}, ${update.from} → ${update.to}) · merged in ${update.pr.repo}#${update.pr.number} ${update.pr.url} on ${update.pr.mergedAt.slice(0, 10)}`);
  const commands = updates.map((update) => `node <plugin>/scripts/openproject.mjs set ${update.id} --status "${update.to}"`);
  return `Status after merge for the user's own work packages, found by merged-sweep.mjs. Run each command without --apply, quote the preview lines, ask one approval for the whole batch, then run them again with --apply --lock <n>.\n\n${rows.join("\n")}\n\n\`\`\`\n${commands.join("\n")}\n\`\`\`\n`;
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

function mergedPrs(map, since) {
  const prs = [];
  for (const repo of map.repos ?? []) {
    const dir = isAbsolute(repo.path) ? repo.path : resolve(map.paths[0], repo.path);
    try {
      const listed = JSON.parse(execFileSync("gh", ["pr", "list", "--state", "merged", "--search", `merged:>=${since.slice(0, 19)}Z`, "--limit", "100", "--json", "number,title,body,mergedAt,url"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
      prs.push(...listed.filter((pr) => pr.mergedAt >= since).map((pr) => ({ ...pr, repo: repo.path })));
    } catch (error) {
      console.log(`skip ${repo.path}: ${String(error.stderr || error.message).split("\n")[0]}`);
    }
  }
  return prs;
}

async function main(argv) {
  const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const handoff = argv.includes("--handoff");
  const from = flag("--from");
  if (handoff && !from) {
    console.error('usage: merged-sweep.mjs [--since <ISO time>] [--handoff --from "<this session>"]');
    return 2;
  }
  const resolved = resolveMap(process.cwd());
  if (!resolved) throw new Error(`no project map covers ${process.cwd()}; run /tedy:setup`);
  const { map } = resolved;
  const targets = map.tracker?.merge_status;
  if (!targets) {
    console.log(`the map ${map.name} has no tracker.merge_status; add the status per work package type with /tedy:setup update`);
    return 1;
  }
  const startedAt = new Date().toISOString();
  const since = flag("--since") ?? readSince(map.name) ?? new Date(Date.now() - FIRST_RUN_DAYS * 86_400_000).toISOString();
  const prs = mergedPrs(map, since);
  const ids = [...new Set(prs.flatMap((pr) => linkedIds(pr.body)))];
  console.log(`merged since ${since}: ${prs.length} PR(s), ${ids.length} linked work package(s)`);
  let updates = [];
  if (ids.length) {
    const client = loadConfig();
    const meId = (await client.request("/api/v3/users/me")).id;
    const closedNames = new Set((await client.request("/api/v3/statuses"))._embedded.elements.filter((status) => status.isClosed).map((status) => status.name));
    const workPackages = new Map();
    for (const id of ids) {
      try {
        const workPackage = await client.request(`/api/v3/work_packages/${id}`);
        workPackages.set(id, { ...workPackage, closed: closedNames.has(workPackage._links.status.title) });
      } catch (error) {
        console.log(`#${id}: ${error.message}`);
      }
    }
    const picked = pickUpdates({ prs, workPackages, meId, targets });
    updates = picked.updates;
    for (const update of updates) console.log(`update #${update.id} ${update.type} ${update.from} → ${update.to} · ${update.pr.repo}#${update.pr.number}`);
    for (const skip of picked.skipped) console.log(`skip #${skip.id}: ${skip.why}`);
  }
  if (!handoff) return 0;
  if (updates.length) {
    const to = route(map, "pm").name;
    const title = `Status after merge: ${updates.length} work package(s)`;
    const dir = reportsDir(map);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `handoff-${stamp()}-to-${slugOf(to)}-${slugOf(title)}.md`);
    writeFileSync(path, render({ to, from, title, body: handoffBody(updates), created: startedAt }));
    console.log(path);
    console.log(`message: ${fill(labels(chatLanguage())["handoff.autoMessage"], { from, title, path })}`);
  }
  writeSince(map.name, startedAt);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`merged-sweep: ${error.message}`);
      process.exit(1);
    },
  );
}
