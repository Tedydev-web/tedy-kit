import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { PROJECTS_ROOT, projectSlug } from "./memory-stats.mjs";

const STACK_MARKERS = [
  ["package.json", "node"],
  ["nest-cli.json", "nestjs"],
  ["foundry.toml", "foundry"],
  ["tact.config.json", "tact"],
  ["hardhat.config.ts", "hardhat"],
  ["hardhat.config.js", "hardhat"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
  ["pubspec.yaml", "flutter"],
];
const INTEGRATION_CANDIDATES = ["dev", "develop", "staging"];
const SKIP_DIRS = new Set(["node_modules", "worktrees", ".worktrees", ".git", "dist", "build", ".claude"]);
const MAX_SCANNED_FILES = 300;
const MAX_FILE_BYTES = 512 * 1024;

export function extractLinks(text) {
  const docs = new Map();
  const figma = new Map();
  for (const match of text.matchAll(/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]{20,})([^\s)"'>\]]*)/g)) {
    const tab = match[2].match(/[?&]tab=(t\.[a-z0-9]+)/)?.[1] ?? null;
    docs.set(`${match[1]} ${tab}`, { doc: match[1], tab });
  }
  for (const match of text.matchAll(/Google Doc\s+`([A-Za-z0-9_-]{30,})`/g)) {
    if (![...docs.values()].some((entry) => entry.doc === match[1])) docs.set(`${match[1]} null`, { doc: match[1], tab: null });
  }
  for (const match of text.matchAll(/figma\.com\/(?:design|file)\/([A-Za-z0-9]+)([^\s)"'>\]]*)/g)) {
    const node = match[2].match(/[?&]node-id=(\d+)[-:](\d+)/);
    const id = node ? `${node[1]}:${node[2]}` : null;
    figma.set(`${match[1]} ${id}`, { file: match[1], node: id });
  }
  return { docs: [...docs.values()], figma: [...figma.values()] };
}

export function detectStack(names) {
  return [...new Set(STACK_MARKERS.filter(([file]) => names.includes(file)).map(([, stack]) => stack))];
}

export function verifyScripts(pkg) {
  return Object.keys(pkg.scripts ?? {}).filter((name) => /typecheck|type-check|^tsc|lint|test|format|prettier|^check/.test(name));
}

export function guessIntegration(branches, mergedBases) {
  if (mergedBases.length) {
    const counts = new Map();
    for (const base of mergedBases) counts.set(base, (counts.get(base) ?? 0) + 1);
    const [branch, count] = [...counts].sort((a, b) => b[1] - a[1])[0];
    return { branch, evidence: `base of ${count}/${mergedBases.length} merged PRs` };
  }
  const branch = INTEGRATION_CANDIDATES.find((candidate) => branches.includes(candidate));
  return branch ? { branch, evidence: `origin/${branch} exists; no merged PRs read` } : { branch: null, evidence: "no dev, develop or staging branch and no merged PRs read" };
}

function git(dir, ...args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function githubMergedBases(slug) {
  if (!slug) return [];
  try {
    return execFileSync("gh", ["pr", "list", "--repo", slug, "--state", "merged", "--limit", "30", "--json", "baseRefName", "--jq", ".[].baseRefName"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function isRepository(dir) {
  return existsSync(join(dir, ".git"));
}

function describeRepo(root, dir, mergedBases) {
  const remote = git(dir, "remote", "get-url", "origin");
  const slug = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/)?.[1] ?? null;
  const branches = git(dir, "branch", "-r", "--format=%(refname:short)").split("\n").filter(Boolean).map((name) => name.replace(/^origin\//, ""));
  const names = readdirSync(dir);
  const pkgPath = join(dir, "package.json");
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : {};
  return {
    path: relative(root, dir) || ".",
    remote: slug ?? remote,
    head: git(dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, "") || null,
    integration: guessIntegration(branches, mergedBases(slug)),
    stack: detectStack(names),
    verify: verifyScripts(pkg),
  };
}

function markdownFiles(dir, depth = 3, found = []) {
  if (!existsSync(dir) || depth < 0 || found.length >= MAX_SCANNED_FILES) return found;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (SKIP_DIRS.has(name)) continue;
    const stat = statSync(path);
    if (stat.isDirectory()) markdownFiles(path, depth - 1, found);
    else if (name.endsWith(".md") && stat.size <= MAX_FILE_BYTES) found.push(path);
    if (found.length >= MAX_SCANNED_FILES) break;
  }
  return found;
}

export function discover(root, { mergedBases = githubMergedBases, memoryDir = join(PROJECTS_ROOT, projectSlug(root), "memory") } = {}) {
  const children = readdirSync(root).filter((name) => !SKIP_DIRS.has(name) && !name.startsWith(".")).map((name) => join(root, name));
  const repoDirs = children.filter((dir) => statSync(dir).isDirectory() && isRepository(dir));
  const repos = (repoDirs.length ? repoDirs : isRepository(root) ? [root] : []).map((dir) => describeRepo(root, dir, mergedBases));
  const instructionDirs = [root, ...repoDirs];
  const instructions = instructionDirs.flatMap((dir) => ["AGENTS.md", "CLAUDE.md"].map((name) => join(dir, name))).filter(existsSync);
  const readmes = instructionDirs.map((dir) => join(dir, "README.md")).filter(existsSync);
  const docs = markdownFiles(join(root, "docs"));
  const prdFiles = docs.filter((path) => /\/prd\/|product requirements/i.test(relative(root, path))).map((path) => relative(root, path));
  const memory = existsSync(memoryDir) ? readdirSync(memoryDir).filter((name) => name.endsWith(".md")).map((name) => join(memoryDir, name)) : [];
  const links = { docs: new Map(), figma: new Map() };
  for (const path of [...instructions, ...readmes, ...docs, ...memory]) {
    const source = path.startsWith(root) ? relative(root, path) : path.replace(homedir(), "~");
    const found = extractLinks(readFileSync(path, "utf8"));
    for (const [kind, key] of [["docs", (item) => `${item.doc} ${item.tab}`], ["figma", (item) => `${item.file} ${item.node}`]]) {
      for (const item of found[kind]) {
        const entry = links[kind].get(key(item)) ?? { ...item, sources: [] };
        if (!entry.sources.includes(source)) entry.sources.push(source);
        links[kind].set(key(item), entry);
      }
    }
  }
  return {
    root,
    repos,
    instructions: instructions.map((path) => relative(root, path)),
    prdFiles,
    links: { docs: [...links.docs.values()], figma: [...links.figma.values()] },
  };
}
