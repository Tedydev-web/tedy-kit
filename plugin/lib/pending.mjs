import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { age, launchRecordPath, listJobs, parse, readRecord, slugOf, stamp } from "./job-files.mjs";
import { close as closeJob, jobBusy, olderKitStatus } from "./job.mjs";
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

const startMarker = (path) => join(dirname(path), `.${basename(path)}.started`);

function claimedAt(path) {
  try {
    return readFileSync(startMarker(path), "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function judged(path, text, root, { ownClaim = false, session } = {}) {
  const read = readCard(text);
  if (!read) return null;
  const claimed = ownClaim || read.status === "refused" || read.status === "started" ? null : claimedAt(path);
  const found = claimed === null ? read : { ...read, status: "started", started: claimed || undefined };
  const refusal =
    found.status === "refused" ? `refused: ${found.refused ?? "no reason given"}`
    : found.status === "started" ? `started at ${found.started ?? "an unknown time"}: its commands may already have written; check their read-backs, then pending.mjs done the card, or card-note --refuse it`
    : cardRefusal(found, root);
  const running = jobRunning(found.job, root);
  const job = found.job === "none" ? null : resolve(root, found.job);
  const agent = Boolean(job) && existsSync(job) && jobBusy(job, session);
  return { path, ...found, refusal, running, busy: agent || (running && found.kind !== "question") };
}

function cardsIn(files, root, problems = [], session) {
  return files.flatMap((path) => {
    try {
      const found = judged(path, readFileSync(path, "utf8"), root, { session });
      return found ? [found] : [];
    } catch (error) {
      problems.push(`${path}: ${error.code ?? error.message}`);
      return [];
    }
  });
}

export const cards = (map, problems = [], session) => cardsIn(draftFiles(repoDirs(map), problems), map.paths[0], problems, session);

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
  const refusal = cardRefusal(readCard(text) ?? { kind }, map.paths[0]);
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

function setHeader(file, drop, add) {
  const lines = readFileSync(file, "utf8").split("\n");
  if (!readCard(lines.join("\n"))) throw new Error(`${file} is not a card file: it has no kind: line`);
  const end = headerLength(lines);
  const header = lines.slice(0, end).filter((line) => !drop.some((key) => line.startsWith(`${key}: `)));
  writeFileSync(file, [...header, ...add, ...lines.slice(end)].join("\n"));
  return file;
}

export function cardNote(file, text, { refuse = false } = {}) {
  const note = oneLine(text ?? "");
  if (!note) throw new Error("--text needs a line");
  return refuse ? setHeader(file, ["status"], ["status: refused", `refused: ${note}`]) : setHeader(file, [], [`answer: ${note}`]);
}

export function cardStart(file, map, approved) {
  const count = checkCard(file, map, true);
  const blocks = readCard(readFileSync(file, "utf8")).blocks.map((block) => block.n);
  const given = [...new Set(approved)].sort((a, b) => a - b);
  if (given.join(",") !== [...blocks].sort((a, b) => a - b).join(",")) throw new Error(`card refused: the approval covers block(s) ${given.length ? given.join(", ") : "none"} of ${blocks.join(", ")}; a card runs only when every block was approved, so nothing ran`);
  const at = new Date().toISOString();
  try {
    writeFileSync(startMarker(resolve(file)), `${at}\n`, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`card refused: started at ${claimedAt(resolve(file)) || "an unknown time"} by another session; run nothing from it`);
  }
  setHeader(file, ["status"], ["status: started", `started: ${at}`]);
  return count;
}

export const cardCheck = (file, map) => checkCard(file, map, false);

function checkCard(file, map, ownClaim) {
  const root = map.paths[0];
  const found = judged(resolve(file), readFileSync(file, "utf8"), root, { ownClaim });
  if (!found) throw new Error(`${file} is not a card file: it has no kind: line`);
  if (found.refusal) throw new Error(`card refused: ${found.refusal}`);
  if (found.busy) throw new Error(`card refused: its job ${found.job} is still running and may rewrite the draft`);
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
  rmSync(startMarker(path), { force: true });
  if (!keep) moved.push(archive(draft, map));
  return moved;
}

function jobState(job, problems) {
  if (job.status !== "running") return job.status;
  try {
    return olderKitStatus(readRecord(launchRecordPath(job.path))) ?? job.status;
  } catch (error) {
    problems.push(`jobs: ${error.message}`);
    return job.status;
  }
}

function realOrNull(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function ofJob(job) {
  if (job === undefined) return null;
  const real = realOrNull(resolve(job));
  if (!real) throw new Error(`the job file ${job} does not exist`);
  return (path) => realOrNull(path) === real;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const publishLine = (item) => `${item.title} (${item.preview}, ${plural(item.blocks.length, "command")}${item.busy ? ", job running" : ""}${item.answer ? `, held: ${item.answer}` : ""}) ${item.path}`;
const questionLine = (item) => `${item.title}${item.answer ? ` (answered: ${item.answer})` : item.busy ? " (job running)" : ""} ${item.path}`;
const askable = (item, held) => !item.refusal && (item.kind === "publish" ? !item.busy && (held || !item.answer) : item.kind === "question" && !item.answer && !item.busy);
const render = (groups, limit) => groups.filter(([, items]) => items.length).map(([title, items]) => `${title}:\n${items.slice(0, limit).map((item) => `- ${item}`).join("\n")}${items.length > limit ? `\n- … ${items.length - limit} more` : ""}`).join("\n\n");

export function waitingText(map, { offline = false, limit = Infinity, budgetMs = Infinity, job, ask = false, held = true, session } = {}) {
  const dirs = repoDirs(map);
  const deadline = Date.now() + budgetMs;
  const problems = [];
  const drafts = draftFiles(dirs, problems);
  const root = map.paths[0];
  const named = ofJob(job);
  const found = cardsIn(drafts, root, problems, session).filter((item) => !named || (item.job !== "none" && named(resolve(root, item.job))));
  if (ask) {
    const asked = found.filter((item) => askable(item, held));
    return render([["To publish", asked.filter((item) => item.kind === "publish").map(publishLine)], ["Questions", asked.filter((item) => item.kind === "question").map(questionLine)]], limit);
  }
  const typed = new Set(found.map((item) => item.path));
  const open = found.filter((item) => !item.refusal);
  const cardGroups = [
    ["Jobs", listJobs(map).filter((item) => !named || named(item.path)).map((item) => `${item.role}: ${item.title} (${jobState(item, problems)}, ${age(item.created)}) ${item.path}`)],
    ["To publish", open.filter((item) => item.kind === "publish").map(publishLine)],
    ["Questions", open.filter((item) => item.kind === "question").map(questionLine)],
    ["For your information", open.filter((item) => item.kind === "notify").map((item) => `${item.title} ${item.path}`)],
    ["Started, not closed", found.filter((item) => item.status === "started").map((item) => `${item.title} (started ${item.started ?? "an unknown time"}) ${item.path}`)],
    ["Refused cards", found.filter((item) => item.refusal && item.status !== "started").map((item) => `${item.title ?? "untitled"}: ${item.refusal} ${item.path}`)],
  ];
  if (named) return render([...cardGroups, ["Could not check", problems]], limit);
  const unpushed = dirs.flatMap((dir) => {
    if (Date.now() > deadline) {
      problems.push(`${relative(root, dir) || "."} git: skipped, the session-start time budget ran out`);
      return [];
    }
    return gitWaiting(dir).map((line) => `${relative(root, dir) || "."} ${line}`);
  });
  const label = (dir) => relative(root, dir) || ".";
  const prs = offline ? [] : dirs.filter(isRepoRoot).map((dir) => ({ dir, ...draftPrs(dir) }));
  return render([
    ...cardGroups,
    ["Drafts waiting on the user", drafts.filter((path) => !typed.has(path))],
    ["Unpushed work", unpushed],
    ["Draft PRs", prs.flatMap(({ dir, items }) => items.map((line) => `${label(dir)} ${line}`))],
    ["Could not check", [...problems, ...prs.filter(({ error }) => error).map(({ dir, error }) => `${label(dir)} draft PRs: ${error}`)]],
  ], limit);
}

const PR_REFS = [
  [/https?:\/\/[^\s/]+\/[\w.-]+\/[\w.-]+\/pull\/\d+/g, ([url]) => ({ label: url, args: ["pr", "view", url] })],
  [/(?<![\w./-])([\w.-]+\/[\w.-]+)#(\d+)\b/g, ([label, repo, number]) => ({ label, args: ["pr", "view", number, "--repo", repo] })],
  [/(?<![\w/#&])#(\d+)\b/g, ([label, number]) => ({ label, args: ["pr", "view", number] })],
];

export function outcomeRefs(text) {
  let inside = false;
  const lines = [];
  for (const line of text.split("\n")) {
    if (/^## Outcome\s*$/.test(line)) inside = true;
    else if (/^## Note /.test(line)) inside = false;
    else if (inside) lines.push(line);
  }
  const body = lines.join("\n");
  const refs = PR_REFS.flatMap(([pattern, ref]) => [...body.matchAll(pattern)].map(ref));
  return refs.filter((ref, index) => refs.findIndex((other) => other.label === ref.label) === index);
}

export function finishedJobs(map, found = cards(map)) {
  const root = map.paths[0];
  const named = new Set(found.filter((item) => item.job !== "none").map((item) => realOrNull(resolve(root, item.job))));
  return listJobs(map)
    .filter((job) => job.status === "done" && !named.has(realOrNull(job.path)))
    .map((job) => ({ ...job, prs: job.role === "dev" ? outcomeRefs(readFileSync(job.path, "utf8")) : [] }));
}

export const prState = (ref, cwd) => execFileSync("gh", [...ref.args, "--json", "state", "--jq", ".state"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).trim();

function openPr(job, state, root) {
  const cwd = [job.repo, job.cwd].find((dir) => dir && existsSync(dir)) ?? root;
  for (const ref of job.prs) {
    let current;
    try {
      current = state(ref, cwd);
    } catch (error) {
      const why = String(error.stderr ?? "").split("\n").find((line) => line.trim()) ?? error.message;
      return `the state of its PR ${ref.label} could not be read (${why.trim()}), so it stays open`;
    }
    if (current !== "MERGED" && current !== "CLOSED") return `its PR ${ref.label} is ${current.toLowerCase() || "in an unknown state"}; it closes once the PR is merged or closed, or when the user asks`;
  }
  return null;
}

export function closeFinished(map, file, { state = prState } = {}) {
  const only = ofJob(file);
  const found = finishedJobs(map).filter((job) => !only || only(job.path));
  if (only && !found.length) return [`kept ${file}: it is not done, or a card still names it`];
  return found.map((job) => {
    const open = openPr(job, state, map.paths[0]);
    if (open) return `kept ${job.path}: ${open}`;
    try {
      return closeJob(map, job.path);
    } catch (error) {
      return `kept ${job.path}: ${error.message}`;
    }
  });
}

function main([command, ...args]) {
  const resolved = resolveMap(process.cwd());
  if (!resolved) throw new Error(`no project map covers ${process.cwd()}; run /tedy:setup`);
  const flag = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
  if (command === "list" && !(args.includes("--job") && !flag("job"))) {
    const job = flag("job");
    console.log(waitingText(resolved.map, { offline: args.includes("--offline"), job }) || (job ? `Nothing waits on the user from ${job}.` : "Nothing waits on the user."));
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
  if (command === "card-start" && args[0] && args.includes("--approved")) {
    console.log(`started: ${args[0]} (${cardStart(args[0], resolved.map, String(flag("approved") ?? "").split(",").filter(Boolean))} block(s) to run in order)`);
    return 0;
  }
  console.error('usage: pending.mjs list [--offline] [--job <job file>] | done <file under plans/> | stub "<action>" | card <publish|question|notify> --title <t> --body-file <f> [--job <f>] [--draft <f>] [--records <k,k>] [--preview ready|run] | card-note <card> --text <line> [--refuse] | card-check <card> | card-start <card> --approved <n,n,…>');
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
