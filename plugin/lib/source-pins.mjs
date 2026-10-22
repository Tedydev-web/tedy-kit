import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { STATE_DIR } from "./hook-io.mjs";

const CITE = /(?<![\w./-])([\w.-][\w./-]*):\d+(?:-\d+)?@(\w(?:[\w./-]*\w)?)/g;
const RECHECK = "re-read the changed sources, fix the draft, lint it again and ask the user again";
const FIGMA_LINK = /figma\.com\/(?:design|file)\/([A-Za-z0-9]+)([^\s)"'`]*)/g;
const DOC_LINK = /docs\.google\.com\/document\/d\/([\w-]+)/g;

export function cites(text) {
  const found = new Map();
  for (const [, path, branch] of text.matchAll(CITE)) found.set(`${branch}\n${path}`, { path, branch });
  return [...found.values()];
}

export function linkedDocs(text) {
  const figma = new Map();
  for (const [, file, rest] of text.matchAll(FIGMA_LINK)) {
    if (!figma.has(file)) figma.set(file, new Set());
    const node = rest.match(/[?&]node-id=(\d+)[-:](\d+)/);
    if (node) figma.get(file).add(`${node[1]}:${node[2]}`);
  }
  return {
    figma: [...figma].map(([file, nodes]) => ({ file, nodes: [...nodes] })),
    docs: [...new Set([...text.matchAll(DOC_LINK)].map((match) => match[1]))],
  };
}

export const mapRepos = (map) =>
  (map?.repos ?? []).map((repo) => ({ name: repo.path, dir: isAbsolute(repo.path) ? repo.path : resolve(map.paths?.[0] ?? process.cwd(), repo.path), branch: repo.branch ?? "dev" }));

export const runGit = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function pinRepos(list, repos, git = runGit) {
  const pins = new Map();
  const problems = [];
  for (const { path, branch } of list) {
    const ref = `refs/remotes/origin/${branch}`;
    const holders = repos.flatMap((repo) => {
      const sha = git(repo.dir, ["for-each-ref", "--format=%(objectname)", ref]);
      return sha && git(repo.dir, ["ls-tree", "--name-only", sha, "--", path]) ? [{ repo, sha }] : [];
    });
    if (!holders.length) problems.push(`\`${path}@${branch}\` is cited, but no repo in the project map has ${path} at origin/${branch}; fetch that repo or fix the cite`);
    for (const { repo, sha } of holders) {
      const key = `${repo.name}\n${branch}`;
      if (!pins.has(key)) pins.set(key, { kind: "git", repo: repo.name, ref: `origin/${branch}`, sha, paths: [] });
      pins.get(key).paths.push(path);
    }
  }
  return { pins: [...pins.values()], problems };
}

export function recheckRepos(pins, repos, git = runGit) {
  const refusals = [];
  const notices = [];
  for (const pin of pins.filter((candidate) => candidate.kind === "git")) {
    const repo = repos.find((candidate) => candidate.name === pin.repo);
    if (!repo) {
      refusals.push(`refused: ${pin.repo} is pinned but the project map no longer lists it; ${RECHECK}`);
      continue;
    }
    const branch = pin.ref.slice("origin/".length);
    git(repo.dir, ["fetch", "-q", "origin", branch]);
    const now = git(repo.dir, ["rev-parse", `refs/remotes/origin/${branch}`]);
    if (now === pin.sha) continue;
    const moved = `${pin.repo} ${pin.ref} moved from ${pin.sha.slice(0, 8)} to ${now.slice(0, 8)} since the draft was linted`;
    const touched = git(repo.dir, ["diff", "--name-only", pin.sha, now, "--", ...pin.paths]).split("\n").filter(Boolean);
    if (!touched.length) {
      notices.push(`notice: ${moved}; no cited path changed, so it posts as drafted`);
      continue;
    }
    const commits = git(repo.dir, ["log", "--format=%h %s", `${pin.sha}..${now}`, "--", ...pin.paths]).split("\n").filter(Boolean);
    refusals.push([`refused: ${moved} and changed what the draft cites`, `  files: ${touched.join(", ")}`, ...commits.map((line) => `  commit ${line}`), `  ${RECHECK}`].join("\n"));
  }
  return { refusals, notices };
}

export function versionCheck(source, before, now, { kept, changed } = {}) {
  if (before === now) return {};
  const moved = `${source} changed from ${before} to ${now} since the draft was linted`;
  if (kept) return { notice: `notice: ${moved}; ${kept}, so it posts as drafted` };
  return { refusal: `refused: ${moved}${changed ? ` and ${changed}` : ""}; ${RECHECK}` };
}

export const describePin = (pin) =>
  pin.kind === "git"
    ? `pinned: ${pin.repo} ${pin.ref}@${pin.sha.slice(0, 8)} · ${pin.paths.join(", ")}`
    : pin.kind === "figma"
      ? `pinned: Figma ${pin.file} version ${pin.version}${pin.nodes?.length ? ` · node ${pin.nodes.join(", ")}` : ""}`
      : `pinned: Google Doc ${pin.doc} ${pin.field} ${pin.value}`;

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
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (record.sha256 && record.sha256 !== digest(readFileSync(file, "utf8"))) return { refusal: `refused: ${file} changed after its sources were pinned; ${again}` };
  return { sources: record.sources };
}

export function requirePin(file, relint, find, what) {
  const { sources, refusal } = pinnedSources(file, relint);
  if (refusal) throw new Error(refusal);
  const pin = sources.find(find);
  if (!pin) throw new Error(`refused: ${file} has no pinned ${what}; run ${relint}, then ask the user again`);
  return pin;
}

export function applyVerdict({ notice, refusal }) {
  if (refusal) throw new Error(refusal);
  if (notice) console.log(notice);
}
