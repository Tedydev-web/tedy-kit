import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, lstatSync, openSync, readSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { age, launchRecordPath, listJobs, parse, readRecord, slugOf, stamp, updateRecord } from "./job-files.mjs";
import { close as closeJob, closeHold, heldElsewhere, jobRecord, jobRole, olderKitStatus, resumeRefusal } from "./job.mjs";
import { CARD_KEYS, cardRefusal, headerLength, oneLine, readCard } from "./pending-cards.mjs";
import { claudeProcess } from "./job-session-hooks.mjs";
import { logRefusal } from "./hook-io.mjs";
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

const cardRefused = (layer, reason) => {
  logRefusal(layer, reason);
  return new Error(`card refused by ${layer}: ${reason}`);
};

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const PREFIX_BYTES = 4096;

function cardText(path) {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(PREFIX_BYTES);
    const length = readSync(descriptor, buffer, 0, PREFIX_BYTES, 0);
    const prefix = buffer.toString("utf8", 0, length);
    if (length < PREFIX_BYTES) return parse(prefix, CARD_KEYS).kind ? prefix : null;
    const complete = prefix.split("\n").slice(0, -1);
    if (headerLength(complete) === complete.length) return readFileSync(path, "utf8");
    return parse(prefix, CARD_KEYS).kind ? readFileSync(path, "utf8") : null;
  } finally {
    closeSync(descriptor);
  }
}

function jobStates(map, caller) {
  const known = new Map();
  return (job) => {
    if (!job || job === "none") return { running: false, closed: false, refusal: null };
    const path = resolve(map.paths[0], job);
    if (!known.has(path)) {
      const present = existsSync(path);
      const status = present ? parse(readFileSync(path, "utf8")).status : undefined;
      known.set(path, { running: status === "running", closed: status === "closed", refusal: present ? resumeRefusal(map, path, caller ?? {}) : null });
    }
    return known.get(path);
  };
}

function jobView(found, { running, closed, refusal }) {
  if (found.kind === "question") {
    if (found.answer) return { stuck: null, busy: false };
    return { stuck: refusal?.kind === "permanent" ? refusal.reason : null, busy: refusal?.kind === "busy" };
  }
  return { stuck: found.kind === "publish" && closed ? refusal?.reason ?? null : null, busy: Boolean(refusal?.agent) || (running && found.kind !== "notify") };
}

const startMarker = (path) => join(dirname(path), `.${basename(path)}.started`);

function claimedAt(path) {
  try {
    return readFileSync(startMarker(path), "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function judged(path, text, map, { ownClaim = false, caller, state = jobStates(map, caller) } = {}) {
  const root = map.paths[0];
  const read = text === null ? null : readCard(text);
  if (!read) return null;
  const claimed = ownClaim || read.status === "refused" || read.status === "started" ? null : claimedAt(path);
  const found = claimed === null ? read : { ...read, status: "started", started: claimed || undefined };
  const delivered = found.kind === "question" && Boolean(found.answer);
  const refusal =
    delivered ? cardRefusal({ ...found, job: "none" }, root)
    : found.status === "refused" ? `refused: ${found.refused ?? "no reason given"}`
    : found.status === "started" ? `started at ${found.started ?? "an unknown time"}: its commands may already have written; check their read-backs, then pending.mjs done the card, or card-note --refuse it`
    : cardRefusal(found, root);
  const job = state(found.job);
  const { stuck, busy } = jobView(found, job);
  return { path, ...found, refusal: refusal ?? (found.status === "started" ? null : stuck), running: job.running, busy };
}

function cardsIn(files, map, problems = [], caller) {
  const state = jobStates(map, caller);
  return files.flatMap((path) => {
    try {
      const found = judged(path, cardText(path), map, { caller, state });
      return found ? [found] : [];
    } catch (error) {
      problems.push(`${path}: ${error.code ?? error.message}`);
      return [];
    }
  });
}

export const cards = (map, problems = [], caller) => cardsIn(draftFiles(repoDirs(map), problems), map, problems, caller);

export function card(map, kind, { title, job = "none", draft, records, preview, body }) {
  const slug = slugOf(String(title ?? ""));
  if (!slug) throw new Error(`the title has no words: ${title}`);
  if (preview !== undefined && kind !== "publish") throw new Error("only a publish card takes --preview");
  const jobPath = job === "none" ? job : resolve(map.paths[0], job);
  const draftPath = draft === undefined ? undefined : resolve(draft);
  if (draftPath !== undefined && !existsSync(draftPath)) throw new Error(`the draft ${draft} does not exist`);
  const header = [
    ["kind", kind],
    ["title", title],
    ["job", jobPath],
    ["draft", draftPath],
    ["draft-sha", draftPath && sha256(draftPath)],
    ["records", records],
    ["preview", preview],
    ["created", new Date().toISOString()],
  ].filter(([, value]) => value !== undefined && value !== "");
  const text = `${header.map(([key, value]) => `${key}: ${oneLine(value)}`).join("\n")}\n\n${String(body ?? "").trim()}\n`;
  const refusal = cardRefusal(readCard(text) ?? { kind }, map.paths[0]);
  if (refusal) throw cardRefused("card", refusal);
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

export function cardStart(file, map, caller) {
  const count = checkCard(file, map, true, caller);
  const at = new Date().toISOString();
  try {
    writeFileSync(startMarker(resolve(file)), `${at}\n`, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw cardRefused("card-start", `started at ${claimedAt(resolve(file)) || "an unknown time"} by another session; run nothing from it`);
  }
  setHeader(file, ["status"], ["status: started", `started: ${at}`]);
  return count;
}

export const cardCheck = (file, map, caller) => checkCard(file, map, false, caller);

function checkCard(file, map, ownClaim, caller) {
  const root = map.paths[0];
  const layer = ownClaim ? "card-start" : "card-check";
  const found = judged(resolve(file), readFileSync(file, "utf8"), map, { ownClaim, caller });
  if (!found) throw new Error(`${file} is not a card file: it has no kind: line`);
  if (found.refusal) throw cardRefused(layer, found.refusal);
  if (found.busy) throw cardRefused(layer, `its job ${found.job} is still running and may rewrite the draft, or another live cockpit runs it`);
  if (found["draft-sha"]) {
    const draft = resolve(root, found.draft);
    if (!existsSync(draft) || sha256(draft) !== found["draft-sha"]) throw cardRefused(layer, `the draft changed since the card was written (${draft}); mark the card refused and have its job or session draft it again, or, after a draft-lint.mjs carry, write a new card`);
  }
  return found.blocks.length;
}

const underDrafts = (path, map) => repoDirs(map).map((dir) => join(dir, "plans", "drafts")).filter((dir) => existsSync(dir)).some((dir) => path.startsWith(realpathSync(dir) + sep));

export function done(file, map) {
  const path = resolve(file);
  const root = map.paths[0];
  const own = existsSync(path) && statSync(path).isFile() ? judged(path, readFileSync(path, "utf8"), map) : null;
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
export const clean = (text) => String(text).replace(/[\p{Cc}\p{Cf}`]/gu, " ").replace(/\s+/g, " ").trim();
export const clip = (text, size = 120) => {
  const value = clean(text);
  return value.length > size ? `${value.slice(0, size - 1)}…` : value;
};
const publishLine = (item) => `${clip(item.title)} (${item.preview}, ${plural(item.blocks.length, "command")}${item.busy ? ", job running" : ""}${item.answer ? `, held: ${clip(item.answer, 40)}` : ""}) ${item.path}`;
const questionLine = (item) => `${clip(item.title)}${item.answer ? ` (answered: ${clip(item.answer, 40)})` : item.busy ? " (job running)" : ""} ${item.path}`;
const askable = (item, held) => !item.refusal && (item.kind === "publish" ? !item.busy && (held || !item.answer) : item.kind === "question" && !item.answer && !item.busy);
export const MORE = "/tedy:pending lists them all";
const render = (groups, limit) => groups.filter(([, items]) => items.length).map(([title, items]) => `${title}:\n${items.slice(0, limit).map((item) => `- ${clean(item)}`).join("\n")}${items.length > limit ? `\n- … ${items.length - limit} more; ${MORE}` : ""}`).join("\n\n");

export function waitingText(map, { offline = false, limit = Infinity, budgetMs = Infinity, job, ask = false, held = true, caller, found: given, skipAsked = false, clipReasons = false } = {}) {
  const root = map.paths[0];
  const named = ofJob(job);
  const ofNamed = (item) => !named || (item.job !== "none" && named(resolve(root, item.job)));
  if (ask) {
    const read = given ?? cards(map, [], caller);
    const asked = read.filter((item) => ofNamed(item) && askable(item, held));
    const delivered = read.filter((item) => ofNamed(item) && !item.refusal && item.kind === "question" && item.answer);
    return render([["To publish", asked.filter((item) => item.kind === "publish").map(publishLine)], ["Questions", asked.filter((item) => item.kind === "question").map(questionLine)], ["Answered and delivered, archive each with pending.mjs done", delivered.map(questionLine)]], limit);
  }
  const dirs = repoDirs(map);
  const deadline = Date.now() + budgetMs;
  const problems = [];
  const drafts = draftFiles(dirs, problems);
  const found = (given ?? cardsIn(drafts, map, problems, caller)).filter(ofNamed);
  const typed = new Set(found.map((item) => item.path));
  const open = found.filter((item) => !item.refusal && !(skipAsked && askable(item, true)));
  const cardGroups = [
    ["Jobs", listJobs(map).filter((item) => !named || named(item.path)).map((item) => `${item.role}: ${clip(item.title)} (${jobState(item, problems)}, ${age(item.created)}) ${item.path}`)],
    ["To publish", open.filter((item) => item.kind === "publish").map(publishLine)],
    ["Questions", open.filter((item) => item.kind === "question").map(questionLine)],
    ["For your information", open.filter((item) => item.kind === "notify").map((item) => `${clip(item.title)} ${item.path}`)],
    ["Started, not closed", found.filter((item) => item.status === "started").map((item) => `${clip(item.title)} (started ${item.started ?? "an unknown time"}) ${item.path}`)],
    ["Refused cards", found.filter((item) => item.refusal && item.status !== "started").map((item) => `${clip(item.title ?? "untitled")}: ${clipReasons ? clip(item.refusal) : item.refusal} ${item.path}`)],
  ];
  const unchecked = (list) => (clipReasons ? list.map((problem) => clip(problem)) : list);
  if (named) return render([...cardGroups, ["Could not check", unchecked(problems)]], limit);
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
    ["Could not check", unchecked([...problems, ...prs.filter(({ error }) => error).map(({ dir, error }) => `${label(dir)} draft PRs: ${error}`)])],
  ], limit);
}

export function finishedJobs(map, found, problems = []) {
  const read = found ?? cards(map, problems);
  if (problems.length) throw new Error(`a card could not be read (${problems.join("; ")}), so no job was closed`);
  const root = map.paths[0];
  const named = new Set(read.filter((item) => item.job !== "none" && item.kind !== "notify").map((item) => realOrNull(resolve(root, item.job))));
  return listJobs(map).filter((job) => job.status === "done" && !named.has(realOrNull(job.path)));
}

export const openPrs = (branch, cwd) => execFileSync("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[].url"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).split("\n").map((line) => line.trim()).filter(Boolean);

function devHold(job, list) {
  let record;
  try {
    record = jobRecord(job.path);
  } catch (error) {
    return `${error.message}, so it stays open`;
  }
  if (!record?.repo || !record?.branch || !existsSync(record.repo)) return "its launch record names no repository and branch, so the kit cannot tell whether a PR from it is open; close it with plain job.mjs close when the user asks";
  let urls;
  try {
    urls = list(record.branch, record.repo);
  } catch (error) {
    const why = String(error.stderr ?? "").split("\n").find((line) => line.trim()) ?? error.message;
    return `the open PRs of its branch ${record.branch} could not be read (${why.trim()}), so it stays open`;
  }
  return urls.length ? `its branch ${record.branch} has an open PR (${urls.join(", ")}); it closes once that PR is merged or closed, or when the user asks` : null;
}

function trustedRole(job) {
  try {
    return jobRole(job.path);
  } catch (error) {
    return { role: null, why: `${error.message}, so it stays open` };
  }
}

export function settleClosedJob(map, file) {
  const root = map.paths[0];
  const real = realOrNull(resolve(file));
  const problems = [];
  const named = cards(map, problems).filter((item) => item.job !== "none" && realOrNull(resolve(root, item.job)) === real);
  const lines = named.map((item) => {
    if (item.kind === "question" && item.answer) return `archived ${done(item.path, map)[0]}: its answer was delivered`;
    if (item.kind !== "question" || item.status === "refused" || item.status === "started") return `still names the job: ${item.path} (${item.kind}${item.refusal ? `, ${clip(item.refusal)}` : ""})`;
    const reason = item.refusal ?? `${file} is closed; start a new job instead`;
    cardNote(item.path, reason, { refuse: true });
    return `archived ${done(item.path, map)[0]}: refused, ${reason}`;
  });
  return [...lines, ...problems.map((problem) => `could not check: ${problem}`)];
}

export function closeFinished(map, file, { list = openPrs, caller = {} } = {}) {
  const only = ofJob(file);
  const found = finishedJobs(map).filter((job) => !only || only(job.path));
  if (only && !found.length) return [`kept ${file}: it is not done, or a card still names it`];
  return found.map((job) => {
    const { role, why } = trustedRole(job);
    if (!role) return `kept ${job.path}: ${why}`;
    const open = role === "dev" ? devHold(job, list) : null;
    if (open) {
      updateRecord(launchRecordPath(job.path), (record) => (record ? { ...record, close_kept_at: new Date().toISOString() } : undefined));
      return `kept ${job.path}: ${open}`;
    }
    const other = closeHold(job.path) ? null : heldElsewhere(job.path, caller);
    if (other) return `kept ${job.path}: its agent belongs to another live cockpit session (${other}), which may still resume it; close it there`;
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
    console.log(waitingText(resolved.map, { offline: args.includes("--offline"), job, caller: { cockpit: claudeProcess() } }) || (job ? `Nothing waits on the user from ${job}.` : "Nothing waits on the user."));
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
    console.log(`ok: ${args[0]} (${cardCheck(args[0], resolved.map, { cockpit: claudeProcess() })} block(s) may run)`);
    return 0;
  }
  if (command === "card-start" && args.length === 1) {
    console.log(`started: ${args[0]} (${cardStart(args[0], resolved.map, { cockpit: claudeProcess() })} block(s) to run in order)`);
    return 0;
  }
  console.error('usage: pending.mjs list [--offline] [--job <job file>] | done <file under plans/> | stub "<action>" | card <publish|question|notify> --title <t> --body-file <f> [--job <f>] [--draft <f>] [--records <k,k>] [--preview ready|run] | card-note <card> --text <line> [--refuse] | card-check <card> | card-start <card>');
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
