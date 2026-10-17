import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { render, reportsDir, route, slugOf, stamp } from "./handoff.mjs";
import { STATE_DIR } from "./hook-io.mjs";
import { loadConfig } from "./openproject-client.mjs";
import { chatLanguage, fill, labels } from "./labels.mjs";
import { resolveMap } from "./project-map.mjs";

const LINK = /\bOP#(\d+)\b|\/work_packages\/(\d+)\b/g;
const FIRST_RUN_DAYS = 7;

export const linkedIds = (text) => [...new Set([...String(text ?? "").matchAll(LINK)].map((match) => Number(match[1] ?? match[2])))];

const assigneeId = (workPackage) => Number(workPackage._links.assignee?.href?.split("/").pop()) || null;

export const kindOf = (pr) => (!pr.mergedAt ? "open" : /^Revert\b/.test(pr.title ?? "") ? "revert" : "merged");

const newer = (held, pr) => !held || (kindOf(held) === "open" && kindOf(pr) !== "open") || (kindOf(pr) !== "open" && kindOf(held) !== "open" && held.mergedAt < pr.mergedAt);

export function pickUpdates({ prs, workPackages, meId, targets, notStarted = [] }) {
  const latest = new Map();
  for (const pr of prs) {
    for (const id of linkedIds(pr.body)) {
      if (newer(latest.get(id), pr)) latest.set(id, pr);
    }
  }
  const updates = [];
  const skipped = [];
  for (const id of [...latest.keys()].sort((a, b) => a - b)) {
    const workPackage = workPackages.get(id);
    const type = workPackage?._links.type.title;
    const status = workPackage?._links.status.title;
    const pr = latest.get(id);
    const kind = kindOf(pr);
    const to = targets[kind]?.[type];
    const why = !workPackage ? "not found" : workPackage.closed ? "closed" : assigneeId(workPackage) !== meId ? "assigned to someone else" : !to ? `type ${type} has no ${kind} status` : status === to ? `already ${status}` : kind === "open" && !notStarted.includes(status) ? `already started (${status})` : null;
    if (why) skipped.push({ id, why });
    else updates.push({ id, subject: workPackage.subject, type, from: status, to, lockVersion: workPackage.lockVersion, pr });
  }
  return { updates, skipped };
}

export function handoffBody(updates) {
  const event = (pr) => ({ open: `opened in ${pr.repo}#${pr.number} ${pr.url}`, revert: `reverted in ${pr.repo}#${pr.number} ${pr.url} on ${pr.mergedAt?.slice(0, 10)}`, merged: `merged in ${pr.repo}#${pr.number} ${pr.url} on ${pr.mergedAt?.slice(0, 10)}` })[kindOf(pr)];
  const rows = updates.map((update) => `- #${update.id} ${update.subject} (${update.type}, ${update.from} → ${update.to}) · ${event(update.pr)}`);
  const commands = updates.map((update) => `node <plugin>/scripts/openproject.mjs set ${update.id} --status "${update.to}"`);
  return `Status from the user's own PRs (opened, merged or reverted), found by merged-sweep.mjs. Run each command without --apply, quote the preview lines, ask one approval for the whole batch, then run them again with --apply --lock <n>.\n\n${rows.join("\n")}\n\n\`\`\`\n${commands.join("\n")}\n\`\`\`\n`;
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
  for (const repo of map.repos ?? []) {
    const dir = isAbsolute(repo.path) ? repo.path : resolve(map.paths[0], repo.path);
    const list = (args) => JSON.parse(execFileSync("gh", ["pr", "list", ...args, "--limit", "100", "--json", "number,title,body,mergedAt,createdAt,url"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    try {
      prs.push(...list(["--state", "merged", "--search", `merged:>=${since.slice(0, 19)}Z`]).filter((pr) => pr.mergedAt >= since).map((pr) => ({ ...pr, repo: repo.path })));
      if (withOpen) prs.push(...list(["--state", "open", "--author", "@me"]).filter((pr) => pr.createdAt >= since).map((pr) => ({ ...pr, mergedAt: null, repo: repo.path })));
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
  const targets = { merged: map.tracker?.merge_status, open: map.tracker?.open_status, revert: map.tracker?.revert_status };
  if (!targets.merged) {
    console.log(`the map ${map.name} has no tracker.merge_status; add the status per work package type with /tedy:setup update`);
    return 1;
  }
  const startedAt = new Date().toISOString();
  const since = flag("--since") ?? readSince(map.name) ?? new Date(Date.now() - FIRST_RUN_DAYS * 86_400_000).toISOString();
  const prs = listedPrs(map, since, Boolean(targets.open));
  const ids = [...new Set(prs.flatMap((pr) => linkedIds(pr.body)))];
  console.log(`since ${since}: ${prs.filter((pr) => pr.mergedAt).length} merged and ${prs.filter((pr) => !pr.mergedAt).length} newly opened PR(s), ${ids.length} linked work package(s)`);
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
    const picked = pickUpdates({ prs, workPackages, meId, targets, notStarted: map.tracker?.not_started ?? [] });
    updates = picked.updates;
    for (const update of updates) console.log(`update #${update.id} ${update.type} ${update.from} → ${update.to} · ${kindOf(update.pr)} ${update.pr.repo}#${update.pr.number}`);
    for (const skip of picked.skipped) console.log(`skip #${skip.id}: ${skip.why}`);
  }
  if (!handoff) return 0;
  const autoMessage = labels(chatLanguage())["handoff.autoMessage"];
  if (updates.length) {
    const to = route(map, "pm").name;
    const title = `Status from PRs: ${updates.length} work package(s)`;
    const dir = reportsDir(map);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `handoff-${stamp()}-to-${slugOf(to)}-${slugOf(title)}.md`);
    writeFileSync(path, render({ to, from, title, body: handoffBody(updates), created: startedAt }));
    console.log(path);
    console.log(`message: ${fill(autoMessage, { from, title, path })}`);
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
