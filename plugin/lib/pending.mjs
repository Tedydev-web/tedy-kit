import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { listPending, reportsDir, slugOf, stamp } from "./handoff.mjs";
import { resolveMap } from "./project-map.mjs";

const capture = (command, args, cwd) => {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 });
  } catch {
    return null;
  }
};

export function repoDirs(map) {
  const root = map.paths[0];
  const repos = (map.repos ?? []).filter((repo) => !repo.readonly).map((repo) => (isAbsolute(repo.path) ? repo.path : resolve(root, repo.path)));
  return [...new Set([root, ...repos])].filter((dir) => existsSync(dir));
}

export function draftFiles(dirs) {
  return dirs.flatMap((dir) => {
    const drafts = join(dir, "plans", "drafts");
    if (!existsSync(drafts)) return [];
    return readdirSync(drafts, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  });
}

export function gitWaiting(dir) {
  const refs = capture("git", ["-C", dir, "for-each-ref", "refs/heads", "--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)"], dir);
  if (refs === null || capture("git", ["-C", dir, "rev-parse", "--show-toplevel"], dir)?.trim() !== resolve(dir)) return [];
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const checkedOut = new Set((capture("git", ["-C", dir, "worktree", "list", "--porcelain"], dir) ?? "").split("\n").filter((line) => line.startsWith("branch refs/heads/")).map((line) => line.slice("branch refs/heads/".length)));
  return refs.split("\n").filter(Boolean).flatMap((line) => {
    const [branch, upstream, track] = line.split("\t");
    if (upstream) {
      const ahead = Number(track.match(/ahead (\d+)/)?.[1] ?? 0);
      return ahead ? [`${branch}: ${plural(ahead, "commit")} ahead of ${upstream}`] : [];
    }
    if (!checkedOut.has(branch)) return [];
    const local = Number(capture("git", ["-C", dir, "rev-list", "--count", branch, "--not", "--remotes"], dir) ?? 0);
    return local ? [`${branch}: ${plural(local, "commit")} on no remote`] : [];
  });
}

export function draftPrs(dir) {
  const out = capture("gh", ["pr", "list", "--draft", "--author", "@me", "--json", "number,title,url"], dir);
  return out ? JSON.parse(out).map((pr) => `#${pr.number} ${pr.title} ${pr.url}`) : [];
}

export function archive(file) {
  const path = resolve(file);
  const marker = `${sep}plans${sep}`;
  const at = path.lastIndexOf(marker);
  if (at === -1 || path.slice(at + marker.length).startsWith(`archive${sep}`)) throw new Error(`${file} is not under a plans directory`);
  const plans = path.slice(0, at + marker.length - 1);
  const to = join(plans, "archive", path.slice(at + marker.length));
  if (existsSync(to)) throw new Error(`${to} is already archived; rename ${file} first`);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(path, to);
  const log = join(plans, "archive", "MOVES.tsv");
  if (!existsSync(log)) writeFileSync(log, "from\tto\n");
  appendFileSync(log, `${path}\t${to}\n`);
  return to;
}

export function stub(map, action) {
  const dir = join(map.paths[0], "plans", "drafts");
  mkdirSync(dir, { recursive: true });
  const slug = slugOf(action);
  if (!slug) throw new Error(`the action has no words: ${action}`);
  let file = join(dir, `${stamp()}-${slug}.md`);
  for (let n = 2; existsSync(file); n += 1) file = join(dir, `${stamp()}-${slug}-${n}.md`);
  writeFileSync(file, `${action.trim()}\n`);
  return file;
}

export function waitingText(map, { offline = false, handoffs = true } = {}) {
  const dirs = repoDirs(map);
  const label = (dir) => relative(map.paths[0], dir) || ".";
  const groups = [
    ["Hand-offs not taken yet", (handoffs ? listPending(reportsDir(map)) : []).map((item) => `to ${item.to}: ${item.title} ${item.path}`)],
    ["Drafts waiting on the user", draftFiles(dirs)],
    ["Unpushed work", dirs.flatMap((dir) => gitWaiting(dir).map((line) => `${label(dir)} ${line}`))],
    ["Draft PRs", offline ? [] : dirs.flatMap((dir) => draftPrs(dir).map((line) => `${label(dir)} ${line}`))],
  ];
  return groups.filter(([, items]) => items.length).map(([title, items]) => `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`).join("\n\n");
}

function main([command, ...args]) {
  const resolved = resolveMap(process.cwd());
  if (!resolved) throw new Error(`no project map covers ${process.cwd()}; run /tedy:setup`);
  if (command === "list") {
    console.log(waitingText(resolved.map, { offline: args.includes("--offline") }) || "Nothing waits on the user.");
    return 0;
  }
  if (command === "done" && args[0]) {
    console.log(`archived: ${archive(args[0])}`);
    return 0;
  }
  if (command === "stub" && args.join(" ").trim()) {
    console.log(stub(resolved.map, args.join(" ")));
    return 0;
  }
  console.error('usage: pending.mjs list [--offline] | done <file under plans/> | stub "<action>"');
  return 2;
}

export function run() {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`pending: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
