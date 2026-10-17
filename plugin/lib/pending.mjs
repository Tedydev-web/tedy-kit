import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { listPending, reportsDir, slugOf, stamp } from "./handoff.mjs";
import { resolveMap } from "./project-map.mjs";

const capture = (command, args, cwd) => {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
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

const isRepoRoot = (dir) => capture("git", ["-C", dir, "rev-parse", "--show-toplevel"], dir)?.trim() === realpathSync(dir);

export function gitWaiting(dir) {
  const refs = capture("git", ["-C", dir, "for-each-ref", "refs/heads", "--format=%(refname)\t%(upstream:short)\t%(upstream:track)"], dir);
  if (refs === null || !isRepoRoot(dir)) return [];
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const checkedOut = new Set((capture("git", ["-C", dir, "worktree", "list", "--porcelain"], dir) ?? "").split("\n").filter((line) => line.startsWith("branch refs/heads/")).map((line) => line.slice("branch refs/heads/".length)));
  return refs.split("\n").filter(Boolean).flatMap((line) => {
    const [ref, upstream, track] = line.split("\t");
    const branch = ref.slice("refs/heads/".length);
    if (upstream && !track.includes("gone")) {
      const ahead = Number(track.match(/ahead (\d+)/)?.[1] ?? 0);
      return ahead ? [`${branch}: ${plural(ahead, "commit")} ahead of ${upstream}`] : [];
    }
    if (!checkedOut.has(branch)) return [];
    const local = Number(capture("git", ["-C", dir, "rev-list", "--count", `refs/heads/${branch}`, "--not", "--remotes"], dir) ?? 0);
    return local ? [`${branch}: ${plural(local, "commit")} on no remote`] : [];
  });
}

export function draftPrs(dir) {
  try {
    const out = execFileSync("gh", ["pr", "list", "--draft", "--author", "@me", "--limit", "100", "--json", "number,title,url"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
    return { items: JSON.parse(out).map((pr) => `#${pr.number} ${pr.title} ${pr.url}`) };
  } catch (error) {
    const reason = String(error.stderr ?? "").split("\n").find((line) => line.trim()) ?? error.message;
    return /not a git repository|no git remotes|none of the git remotes/i.test(reason) ? { items: [] } : { items: [], error: reason.trim() };
  }
}

export function archive(file, map) {
  const path = resolve(file);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${file} is not a file`);
  const real = realpathSync(path);
  const plans = repoDirs(map).map((dir) => join(dir, "plans")).filter((dir) => existsSync(dir)).map((dir) => realpathSync(dir)).filter((root) => real.startsWith(root + sep)).sort((a, b) => b.length - a.length)[0];
  if (!plans) throw new Error(`${file} is not under plans/ of this project`);
  const inside = relative(plans, real);
  if (inside.startsWith(`archive${sep}`)) throw new Error(`${file} is already in plans/archive`);
  if (path.startsWith(reportsDir(map) + sep) && /^handoff-.*\.md$/.test(path.slice(reportsDir(map).length + 1))) throw new Error(`${file} is a hand-off; close it with handoff.mjs done`);
  const to = join(plans, "archive", inside);
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

export function waitingText(map, { offline = false, handoffs = true, limit = Infinity } = {}) {
  const dirs = repoDirs(map);
  const label = (dir) => relative(map.paths[0], dir) || ".";
  const prs = offline ? [] : dirs.filter(isRepoRoot).map((dir) => ({ dir, ...draftPrs(dir) }));
  const groups = [
    ["Hand-offs not taken yet", (handoffs ? listPending(reportsDir(map)) : []).map((item) => `to ${item.to}: ${item.title} ${item.path}`)],
    ["Drafts waiting on the user", draftFiles(dirs)],
    ["Unpushed work", dirs.flatMap((dir) => gitWaiting(dir).map((line) => `${label(dir)} ${line}`))],
    ["Draft PRs", prs.flatMap(({ dir, items }) => items.map((line) => `${label(dir)} ${line}`))],
    ["Could not check", prs.filter(({ error }) => error).map(({ dir, error }) => `${label(dir)} draft PRs: ${error}`)],
  ];
  return groups.filter(([, items]) => items.length).map(([title, items]) => `${title}:\n${items.slice(0, limit).map((item) => `- ${item}`).join("\n")}${items.length > limit ? `\n- … ${items.length - limit} more` : ""}`).join("\n\n");
}

function main([command, ...args]) {
  const resolved = resolveMap(process.cwd());
  if (!resolved) throw new Error(`no project map covers ${process.cwd()}; run /tedy:setup`);
  if (command === "list") {
    console.log(waitingText(resolved.map, { offline: args.includes("--offline") }) || "Nothing waits on the user.");
    return 0;
  }
  if (command === "done" && args[0]) {
    console.log(`archived: ${archive(args[0], resolved.map)}`);
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
