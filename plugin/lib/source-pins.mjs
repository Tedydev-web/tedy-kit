import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { STATE_DIR } from "./hook-io.mjs";
import { resolveMap } from "./project-map.mjs";

const GIT_TIMEOUT_MS = 60_000;
export const RECHECK ="re-read the changed sources, fix the draft, lint it again and ask the user again";
const FIGMA_LINK = /figma\.com\/(?:design|file|proto|board)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?([^\s)"'`<>]*)/g;
const DOC_LINK = /(?:https?:\/\/)?docs\.google\.com\/(?:a\/[^/\s]+\/)?document\/(?:u\/\d+\/)?d\/(e\/)?([\w-]+)[^\s)"'`<>]*|drive\.google\.com\/open\?(?:[^\s#)"'`<>]*?&)?id=([\w-]+)/g;
const NODE_ID = /^I?\d+:\d+(?:;\d+:\d+)*$/;
const NAME_BEFORE = "(?<![\\p{L}\\p{N}\\p{M}_.-])";
const NAME_AFTER = "(?![\\p{L}\\p{N}\\p{M}_-]|\\.[\\p{L}\\p{N}])";

const unique = (list) => [...new Set(list)];

const decodeRuns = (text) =>
  text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });

export function namedIn(texts, path) {
  const name = path.split("/").pop().normalize("NFC");
  const pattern = new RegExp(`${NAME_BEFORE}${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${NAME_AFTER}`, "u");
  return texts.some((text) => [text, decodeRuns(text)].some((candidate) => pattern.test(candidate.normalize("NFC"))));
}

export const branchTokens = (text) => unique([...text.matchAll(/@(\w[\w./-]*)/g)].map((match) => match[1].replace(/[./-]+$/, "")));

export function nodeId(raw) {
  let id;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  id = id.replaceAll("-", ":");
  return NODE_ID.test(id) ? id : null;
}

export function linkedDocs(text) {
  const figma = new Map();
  const docs = [];
  const problems = [];
  for (const [, main, branch, rest] of text.matchAll(FIGMA_LINK)) {
    const file = branch ?? main;
    const entry = figma.get(file) ?? { file, nodes: [], whole: false };
    const node = nodeId(rest.match(/[?&]node-id=([\w%:;-]+)/)?.[1] ?? "");
    if (node && !entry.nodes.includes(node)) entry.nodes.push(node);
    if (!node) entry.whole = true;
    figma.set(file, entry);
  }
  for (const [link, published, doc, opened] of text.matchAll(DOC_LINK)) {
    if (published) problems.push(`${link} is a published-to-web copy of a Google Doc, which cannot be pinned; link the Doc itself (docs.google.com/document/d/<id>)`);
    else docs.push(doc ?? opened);
  }
  return { figma: [...figma.values()], docs: unique(docs), problems };
}

export const runGit = (dir, args) => execFileSync("git", ["--literal-pathspecs", "-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS }).trim();

function originHead(dir, git) {
  try {
    return git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, "");
  } catch {
    return null;
  }
}

export const mapRepos = (map, git = runGit) =>
  (map?.repos ?? []).map((repo) => {
    const dir = isAbsolute(repo.path) ? repo.path : resolve(map.paths?.[0] ?? process.cwd(), repo.path);
    const head = repo.branch ? null : originHead(dir, git);
    return { name: repo.path, dir, branches: repo.branch ? [repo.branch] : head ? [head] : [] };
  });

const gitReason = (error) => (error.code === "ETIMEDOUT" ? `timed out after ${GIT_TIMEOUT_MS / 1000} s` : (error.stderr?.toString().trim() || error.message).split("\n")[0]);

function remoteTip(git, dir, branch) {
  const ref = `refs/heads/${branch}`;
  const line = git(dir, ["ls-remote", "origin", ref]).split("\n").find((entry) => entry.split("\t")[1] === ref);
  return line ? line.split("\t")[0] : null;
}

function hasCommit(git, dir, sha) {
  try {
    git(dir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function fetchCommit(git, dir, branch, sha) {
  if (hasCommit(git, dir, sha)) return;
  git(dir, ["fetch", "-q", "origin", branch]);
  git(dir, ["cat-file", "-e", `${sha}^{commit}`]);
}

export function pinRepos(repos, text, git = runGit) {
  const tokens = branchTokens(text);
  const pins = [];
  const problems = [];
  for (const repo of repos) {
    if (!repo.branches.length) {
      problems.push(`${repo.name} has no branch in the project map and origin/HEAD is unset; set its branch in the map or run git -C ${repo.dir} remote set-head origin --auto`);
      continue;
    }
    let found = false;
    let failed = false;
    for (const branch of unique([...repo.branches, ...tokens])) {
      let sha;
      try {
        sha = remoteTip(git, repo.dir, branch);
        if (sha) fetchCommit(git, repo.dir, branch, sha);
      } catch (error) {
        problems.push(`cannot pin ${repo.name} origin/${branch}: ${gitReason(error)}`);
        failed = true;
        break;
      }
      if (!sha) continue;
      pins.push({ kind: "git", repo: repo.name, ref: `origin/${branch}`, sha });
      found ||= repo.branches.includes(branch);
    }
    if (!found && !failed) problems.push(`${repo.name} has no ${repo.branches.map((branch) => `origin/${branch}`).join(" or ")}; fix the branch in the project map or fetch the repo`);
  }
  return { pins, problems };
}

function changedPaths(git, dir, from, to) {
  const fields = git(dir, ["diff", "--name-status", "--no-renames", "-z", from, to]).split("\0");
  const paths = [];
  for (let index = 1; index < fields.length; index += 2) if (fields[index]) paths.push(fields[index]);
  return paths;
}

function recheckRepo(pin, repo, texts, git) {
  const branch = pin.ref.slice("origin/".length);
  const now = remoteTip(git, repo.dir, branch);
  if (!now) return { refusal: `refused: ${pin.repo} ${pin.ref} no longer exists on origin; ${RECHECK}` };
  if (now === pin.sha) return {};
  fetchCommit(git, repo.dir, branch, now);
  if (!hasCommit(git, repo.dir, pin.sha)) return { refusal: `refused: ${pin.repo} ${pin.ref}: the pinned commit ${pin.sha.slice(0, 8)} is not in the clone, so what changed cannot be listed; fetch it or lint again, then ask the user again` };
  const moved = `${pin.repo} ${pin.ref} moved from ${pin.sha.slice(0, 8)} to ${now.slice(0, 8)} since it was pinned`;
  const named = changedPaths(git, repo.dir, pin.sha, now).filter((path) => namedIn(texts, path));
  if (!named.length) return { notice: `notice: ${moved}; no changed file is named in the text being posted, so it posts as drafted` };
  const commits = git(repo.dir, ["log", "--format=%h %s", `${pin.sha}..${now}`, "--", ...named]).split("\n").filter(Boolean);
  return { refusal: [`refused: ${moved} and changed a file the text being posted names`, `  files: ${named.join(", ")}`, ...commits.map((line) => `  commit ${line}`), `  ${RECHECK}`].join("\n") };
}

export function recheckRepos(pins, repos, texts, git = runGit) {
  const refusals = [];
  const notices = [];
  for (const pin of pins.filter((candidate) => candidate.kind === "git")) {
    const repo = repos.find((candidate) => candidate.name === pin.repo);
    if (!repo) {
      refusals.push(`refused: ${pin.repo} is pinned but the project map no longer lists it; ${RECHECK}`);
      continue;
    }
    let verdict;
    try {
      verdict = recheckRepo(pin, repo, texts, git);
    } catch (error) {
      verdict = { refusal: `refused: ${pin.repo} ${pin.ref} could not be rechecked (${gitReason(error)}); fetch it, then publish again` };
    }
    if (verdict.refusal) refusals.push(verdict.refusal);
    if (verdict.notice) notices.push(verdict.notice);
  }
  return { refusals, notices };
}

export function versionCheck(source, before, now, { kept, changed } = {}) {
  if (before === now) return {};
  const moved = `${source} changed from ${before} to ${now} since it was pinned`;
  if (kept) return { notice: `notice: ${moved}; ${kept}, so it posts as drafted` };
  return { refusal: `refused: ${moved}${changed ? ` and ${changed}` : ""}; ${RECHECK}` };
}

export async function takePin(what, take) {
  try {
    return await take();
  } catch (error) {
    throw new Error(`cannot pin ${what}: ${error.message}; fix that, then run the lint or preview again. Nothing was written.`);
  }
}

export async function linkPins(text, extra = {}) {
  const links = linkedDocs(text);
  if (links.problems.length) throw new Error(`cannot pin ${links.problems.join("; ")}. Nothing was written.`);
  const figma = new Map();
  for (const { file, nodes = [], whole = false } of [...(extra.figma ?? []), ...links.figma]) {
    const entry = figma.get(file) ?? { nodes: [], whole: false };
    entry.nodes = unique([...entry.nodes, ...nodes]);
    entry.whole ||= whole;
    figma.set(file, entry);
  }
  const pins = [];
  if (figma.size) {
    const { client, figmaPin } = await import("./figma-comments.mjs");
    for (const [file, { nodes, whole }] of figma) pins.push(await takePin(`Figma file ${file}`, async () => figmaPin(client({ file }), nodes, whole)));
  }
  const docs = unique([...(extra.docs ?? []), ...links.docs]);
  if (docs.length) {
    const { gdocPin, session } = await import("./gdoc-comments.mjs");
    for (const doc of docs) pins.push(await takePin(`Google Doc ${doc}`, async () => gdocPin(await session({ doc }))));
  }
  return pins;
}

async function recheckLinked(pin, kept) {
  if (pin.kind === "figma") {
    const { client, recheckFigma } = await import("./figma-comments.mjs");
    return recheckFigma(client({ file: pin.file }), pin);
  }
  if (pin.kind === "gdoc") {
    const { recheckGdoc, session } = await import("./gdoc-comments.mjs");
    return recheckGdoc(await session({ doc: pin.doc }), pin, kept);
  }
  return { refusal: `refused: the sources record holds a pin of unknown kind ${JSON.stringify(pin.kind)}; ${RECHECK}` };
}

export async function recheckPins(sources, { texts = [], kept } = {}) {
  const git = sources.filter((pin) => pin.kind === "git");
  const { refusals, notices } = git.length ? recheckRepos(git, mapRepos(resolveMap(process.cwd())?.map), texts) : { refusals: [], notices: [] };
  for (const pin of sources.filter((candidate) => candidate.kind !== "git")) {
    let verdict;
    try {
      verdict = await recheckLinked(pin, kept);
    } catch (error) {
      verdict = { refusal: error.message.startsWith("refused:") ? error.message : `refused: ${pin.kind === "figma" ? `Figma ${pin.file}` : `Google Doc ${pin.doc}`} could not be rechecked (${error.message}); fix that, then publish again` };
    }
    if (verdict.refusal) refusals.push(verdict.refusal);
    if (verdict.notice) notices.push(verdict.notice);
  }
  return { refusals, notices };
}

export const describePin = (pin) => {
  if (pin.kind === "git") return `pinned: ${pin.repo} ${pin.ref}@${pin.sha.slice(0, 8)}`;
  if (pin.kind === "gdoc") return `pinned: Google Doc ${pin.doc} text ${pin.text.slice(0, 12)} via ${pin.method}`;
  const nodes = Object.entries(pin.nodes);
  return `pinned: Figma ${pin.file} lastModified ${pin.lastModified}${nodes.length ? ` · node ${nodes.map(([id, hash]) => `${id} ${hash.slice(0, 12)}`).join(", ")}` : ""}${pin.whole ? " · whole file" : ""}`;
};

const digest = (text) => createHash("sha256").update(text).digest("hex");

export const sourcesPath = (file) => join(STATE_DIR, "drafts", `${resolve(file).replace(/\//g, "_")}.sources.json`);

export function writeSources(file, sources, text) {
  const path = sourcesPath(file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ file: resolve(file), at: new Date().toISOString(), ...(text === undefined ? {} : { sha256: digest(text) }), sources }, null, 1)}\n`);
  return path;
}

export function pinnedSources(file, relint) {
  const path = sourcesPath(file);
  const again = `run ${relint}, then ask the user again`;
  if (!existsSync(path)) return { refusal: `refused: ${file} has no pinned sources; ${again}` };
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(record?.sources)) throw new Error("no sources list");
  } catch (error) {
    return { refusal: `refused: the sources record for ${file} cannot be read (${error.message}); ${again}` };
  }
  if (record.file !== resolve(file)) return { refusal: `refused: the sources record for ${file} was written for ${record.file}; ${again}` };
  if (typeof record.sha256 !== "string") return { refusal: `refused: ${file} has a sources record with no digest of its text; ${again}` };
  if (record.sha256 !== digest(readFileSync(file, "utf8"))) return { refusal: `refused: ${file} changed after its sources were pinned; ${again}` };
  return { sources: record.sources };
}

export async function recheckPinned(file, relint, { texts, kept, covers, what } = {}) {
  const { sources, refusal } = pinnedSources(file, relint);
  if (refusal) return { refusals: [refusal], notices: [] };
  if (covers && !sources.some(covers)) return { refusals: [`refused: ${file} has no pinned ${what}; run ${relint}, then ask the user again`], notices: [] };
  return recheckPins(sources, { texts, kept });
}

export const readPinsPath = (file) => join(STATE_DIR, "drafts", `${resolve(file).replace(/\//g, "_")}.read-pins.json`);

export function writeReadPins(file, sources) {
  const path = readPinsPath(file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ file: resolve(file), at: new Date().toISOString(), sources }, null, 1)}\n`);
  return path;
}

function loadReadPins(key) {
  const path = readPinsPath(key);
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (record?.file !== resolve(key) || !Array.isArray(record.sources)) throw new Error(`not a read pin record for ${key}`);
    return { sources: record.sources };
  } catch (error) {
    return { problem: `the read pins for ${key} cannot be read (${error.message}); run draft-lint.mjs pin-sources ${key} again, re-read the sources and lint again` };
  }
}

const pinLabel = (pin, nodes) => (pin.kind === "git" ? `${pin.repo} ${pin.ref}` : pin.kind === "gdoc" ? `Google Doc ${pin.doc}` : nodes.length ? `Figma ${pin.file} node ${nodes.join(", ")}` : `Figma ${pin.file} file`);

function uncovered(read, pin) {
  const same = read.filter((candidate) => candidate.kind === pin.kind && (pin.kind === "git" ? candidate.repo === pin.repo && candidate.ref === pin.ref : pin.kind === "gdoc" ? candidate.doc === pin.doc : candidate.file === pin.file));
  if (pin.kind !== "figma") return same.length ? null : pinLabel(pin, []);
  const missing = Object.keys(pin.nodes ?? {}).filter((id) => !same.some((candidate) => Object.hasOwn(candidate.nodes ?? {}, id)));
  if (missing.length) return pinLabel(pin, missing);
  return pin.whole && !same.some((candidate) => candidate.whole) ? pinLabel(pin, []) : null;
}

export async function settleReadPins(key, pins, { texts, kept } = {}) {
  const read = loadReadPins(key);
  if (read === null) return { pins, problems: [], lines: [`warning: no read pins for ${key}, so its sources were pinned now, at lint, and a change pushed while you read them is not seen; next time run draft-lint.mjs pin-sources ${key} before reading`] };
  if (read.problem) return { pins: [], problems: [read.problem], lines: [] };
  const extra = pins.flatMap((pin) => {
    const label = uncovered(read.sources, pin);
    return label ? [{ pin, label }] : [];
  });
  const { refusals, notices } = await recheckPins(read.sources, { texts, kept });
  return {
    pins: [...read.sources, ...extra.map(({ pin }) => pin)],
    problems: refusals.length ? [...refusals, `a source changed while it was being read; run draft-lint.mjs pin-sources ${key} again, re-read what changed, fix the draft and lint it again`] : [],
    lines: [...notices, ...extra.map(({ label }) => `warning: ${label} was not pinned by draft-lint.mjs pin-sources ${key}, so it was pinned now, at lint`)],
  };
}

export async function recordPins(file, text, pins, { pinnedAt = file, texts, kept } = {}) {
  const settled = await settleReadPins(pinnedAt, pins, { texts, kept });
  for (const line of settled.lines) console.log(line);
  for (const problem of settled.problems) console.log(`sources: ${problem}`);
  if (settled.problems.length) return null;
  writeSources(file, settled.pins, text);
  return settled.pins;
}

export async function requireFresh(file, relint, options) {
  const { refusals, notices } = await recheckPinned(file, relint, options);
  if (refusals.length) throw new Error(refusals.join("\n"));
  return notices;
}

export const sayNotices = (notices) => {
  for (const notice of notices) console.log(notice);
};
