import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { listPending, parse, reportsDir, slugOf, stamp } from "./handoff.mjs";
import { cardRefusal, headerLength, oneLine, readCard } from "./pending-cards.mjs";
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
  const seen = new Set();
  return [root, ...repos].filter((dir) => existsSync(dir)).filter((dir) => {
    const real = realpathSync(dir);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

function walk(folder, problems) {
  let entries;
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    problems.push(`${folder}: ${error.code ?? error.message}`);
    return [];
  }
  return entries
    .filter((entry) => !entry.name.startsWith("."))
    .flatMap((entry) => (entry.isDirectory() ? walk(join(folder, entry.name), problems) : entry.isFile() ? [join(folder, entry.name)] : []));
}

export function draftFiles(dirs, problems = []) {
  return dirs.flatMap((dir) => {
    const drafts = join(dir, "plans", "drafts");
    return existsSync(drafts) && lstatSync(drafts).isDirectory() ? walk(drafts, problems).sort() : [];
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
    if (!(upstream && !track.includes("gone")) && !checkedOut.has(branch)) return [];
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
  const reports = existsSync(reportsDir(map)) ? realpathSync(reportsDir(map)) : null;
  if (reports && real.startsWith(reports + sep) && /^handoff-.*\.md$/.test(real.slice(reports.length + 1))) throw new Error(`${file} is a hand-off; close it with handoff.mjs done`);
  const to = join(plans, "archive", inside);
  if (existsSync(to)) throw new Error(`${to} is already archived; rename ${file} first`);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(real, to);
  const log = join(plans, "archive", "MOVES.tsv");
  if (!existsSync(log)) writeFileSync(log, "from\tto\n");
  appendFileSync(log, `${real}\t${to}\n`);
  return to;
}

export function stub(map, action) {
  const slug = slugOf(action);
  if (!slug) throw new Error(`the action has no words: ${action}`);
  const dir = join(map.paths[0], "plans", "drafts");
  mkdirSync(dir, { recursive: true });
  let file = join(dir, `${stamp()}-${slug}.md`);
  for (let n = 2; existsSync(file); n += 1) file = join(dir, `${stamp()}-${slug}-${n}.md`);
  writeFileSync(file, `${action.trim()}\n`);
  return file;
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const jobRunning = (job, root) => {
  if (!job || job === "none") return false;
  const path = resolve(root, job);
  return existsSync(path) && parse(readFileSync(path, "utf8")).status === "running";
};

function judged(path, text, root) {
  const found = readCard(text);
  if (!found) return null;
  const refusal = found.status === "refused" ? `refused: ${found.refused ?? "no reason given"}` : cardRefusal(found);
  return { path, ...found, refusal, running: jobRunning(found.job, root) };
}

function cardsIn(files, root, problems = []) {
  return files.flatMap((path) => {
    try {
      const found = judged(path, readFileSync(path, "utf8"), root);
      return found ? [found] : [];
    } catch (error) {
      problems.push(`${path}: ${error.code ?? error.message}`);
      return [];
    }
  });
}

export const cards = (map, problems = []) => cardsIn(draftFiles(repoDirs(map), problems), map.paths[0], problems);

export function card(map, kind, { title, job = "none", draft, records, preview, body }) {
  const slug = slugOf(String(title ?? ""));
  if (!slug) throw new Error(`the title has no words: ${title}`);
  if (preview !== undefined && kind !== "publish") throw new Error("only a publish card takes --preview");
  const draftPath = draft === undefined ? undefined : resolve(draft);
  if (draftPath !== undefined && !existsSync(draftPath)) throw new Error(`the draft ${draft} does not exist`);
  const header = [
    ["kind", kind],
    ["title", title],
    ["job", job === "none" ? job : resolve(job)],
    ["draft", draftPath],
    ["draft-sha", draftPath && sha256(draftPath)],
    ["records", records],
    ["preview", preview],
    ["created", new Date().toISOString()],
  ].filter(([, value]) => value !== undefined && value !== "");
  const text = `${header.map(([key, value]) => `${key}: ${oneLine(value)}`).join("\n")}\n\n${String(body ?? "").trim()}\n`;
  const refusal = cardRefusal(readCard(text) ?? { kind });
  if (refusal) throw new Error(`card refused: ${refusal}`);
  const dir = join(map.paths[0], "plans", "drafts");
  mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n += 1) {
    const file = join(dir, `${stamp()}-${kind}-${slug}${n === 1 ? "" : `-${n}`}.md`);
    try {
      writeFileSync(file, text, { flag: "wx" });
      return file;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

export function cardNote(file, text, { refuse = false } = {}) {
  const note = oneLine(text ?? "");
  if (!note) throw new Error("--text needs a line");
  const lines = readFileSync(file, "utf8").split("\n");
  if (!readCard(lines.join("\n"))) throw new Error(`${file} is not a card file: it has no kind: line`);
  const end = headerLength(lines);
  const header = lines.slice(0, end).filter((line) => !(refuse && line.startsWith("status: ")));
  writeFileSync(file, [...header, ...(refuse ? ["status: refused", `refused: ${note}`] : [`answer: ${note}`]), ...lines.slice(end)].join("\n"));
  return file;
}

export function cardCheck(file, map) {
  const root = map.paths[0];
  const found = judged(resolve(file), readFileSync(file, "utf8"), root);
  if (!found) throw new Error(`${file} is not a card file: it has no kind: line`);
  if (found.refusal) throw new Error(`card refused: ${found.refusal}`);
  if (found.running) throw new Error(`card refused: its job ${found.job} is still running and may rewrite the draft`);
  if (found["draft-sha"]) {
    const draft = resolve(root, found.draft);
    if (!existsSync(draft) || sha256(draft) !== found["draft-sha"]) throw new Error(`card refused: the draft changed since the card was written (${draft}); mark the card refused and have its job or session draft it again`);
  }
  return found.blocks.length;
}

const underDrafts = (path, map) => repoDirs(map).map((dir) => join(dir, "plans", "drafts")).filter((dir) => existsSync(dir)).some((dir) => path.startsWith(realpathSync(dir) + sep));

export function done(file, map) {
  const path = resolve(file);
  const root = map.paths[0];
  const own = existsSync(path) && statSync(path).isFile() ? judged(path, readFileSync(path, "utf8"), root) : null;
  const draft = own?.draft && existsSync(resolve(root, own.draft)) ? realpathSync(resolve(root, own.draft)) : null;
  const named = (other) => other.draft && existsSync(resolve(root, other.draft)) && realpathSync(resolve(root, other.draft)) === draft;
  const keep = !draft || !underDrafts(draft, map) || cards(map).some((other) => realpathSync(other.path) !== realpathSync(path) && named(other));
  const moved = [archive(file, map)];
  if (!keep) moved.push(archive(draft, map));
  return moved;
}

export function waitingText(map, { offline = false, handoffs = true, limit = Infinity, budgetMs = Infinity } = {}) {
  const dirs = repoDirs(map);
  const deadline = Date.now() + budgetMs;
  const problems = [];
  const drafts = draftFiles(dirs, problems);
  const found = cardsIn(drafts, map.paths[0], problems);
  const typed = new Set(found.map((item) => item.path));
  const open = found.filter((item) => !item.refusal);
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const unpushed = dirs.flatMap((dir) => {
    if (Date.now() > deadline) {
      problems.push(`${relative(map.paths[0], dir) || "."} git: skipped, the session-start time budget ran out`);
      return [];
    }
    return gitWaiting(dir).map((line) => `${relative(map.paths[0], dir) || "."} ${line}`);
  });
  const label = (dir) => relative(map.paths[0], dir) || ".";
  const prs = offline ? [] : dirs.filter(isRepoRoot).map((dir) => ({ dir, ...draftPrs(dir) }));
  const groups = [
    ["Hand-offs not taken yet", (handoffs ? listPending(reportsDir(map)) : []).map((item) => `to ${item.to}: ${item.title} ${item.path}`)],
    ["To publish", open.filter((item) => item.kind === "publish").map((item) => `${item.title} (${item.preview}, ${plural(item.blocks.length, "command")}${item.running ? ", job running" : ""}) ${item.path}`)],
    ["Questions", open.filter((item) => item.kind === "question").map((item) => `${item.title}${item.answer ? ` (answered: ${item.answer})` : ""} ${item.path}`)],
    ["For your information", open.filter((item) => item.kind === "notify").map((item) => `${item.title} ${item.path}`)],
    ["Refused cards", found.filter((item) => item.refusal).map((item) => `${item.title ?? "untitled"}: ${item.refusal} ${item.path}`)],
    ["Drafts waiting on the user", drafts.filter((path) => !typed.has(path))],
    ["Unpushed work", unpushed],
    ["Draft PRs", prs.flatMap(({ dir, items }) => items.map((line) => `${label(dir)} ${line}`))],
    ["Could not check", [...problems, ...prs.filter(({ error }) => error).map(({ dir, error }) => `${label(dir)} draft PRs: ${error}`)]],
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
    for (const to of done(args[0], resolved.map)) console.log(`archived: ${to}`);
    return 0;
  }
  if (command === "stub" && args.join(" ").trim()) {
    console.log(stub(resolved.map, args.join(" ")));
    return 0;
  }
  const flag = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
  if (command === "card" && args[0] && flag("title") && flag("body-file")) {
    console.log(card(resolved.map, args[0], { title: flag("title"), job: flag("job"), draft: flag("draft"), records: flag("records"), preview: flag("preview"), body: readFileSync(flag("body-file"), "utf8") }));
    return 0;
  }
  if (command === "card-note" && args[0] && flag("text")) {
    console.log(`noted: ${cardNote(args[0], flag("text"), { refuse: args.includes("--refuse") })}`);
    return 0;
  }
  if (command === "card-check" && args[0]) {
    console.log(`ok: ${args[0]} (${cardCheck(args[0], resolved.map)} block(s) may run)`);
    return 0;
  }
  console.error('usage: pending.mjs list [--offline] | done <file under plans/> | stub "<action>" | card <publish|question|notify> --title <t> --body-file <f> [--job <f>] [--draft <f>] [--records <k,k>] [--preview ready|run] | card-note <card> --text <line> [--refuse] | card-check <card>');
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
