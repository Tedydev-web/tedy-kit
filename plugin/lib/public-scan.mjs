import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { SECRET_SHAPE } from "./api-request.mjs";

const HOME_PATH = /\/(?:home|Users)\/[A-Za-z0-9._-]+\//;
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
const LONG_HEX = /\b[A-Fa-f0-9]{32,}\b/g;
const TOKEN_SHAPE = new RegExp(SECRET_SHAPE.source);
const QUOTED_SECRET = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)["']?\s*[:=]\s*["'][^"'\s$<>{}]{8,}["']/i;
const KEY_MATERIAL = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/;
const ALLOWED_LOCAL = new Set(["git", "noreply"]);
const ALLOWED_DOMAIN = /(^|\.)(users\.noreply\.github\.com|example\.(com|org|net))$/i;
const OBJECT_HEADER = /^(tree|parent|object) [0-9a-f]{40}$/;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function loadDenylist(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((text, index) => ({ line: index + 1, term: text.trim() }))
    .filter(({ term }) => term && !term.startsWith("#"))
    .map(({ line, term }) => ({ rule: `denylist#${line}`, pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, "iu") }));
}

function emailHit(line) {
  for (const match of line.matchAll(EMAIL)) {
    const local = match[0].slice(0, match[0].indexOf("@"));
    if (!ALLOWED_LOCAL.has(local.toLowerCase()) && !ALLOWED_DOMAIN.test(match[1])) return true;
  }
  return false;
}

function lineRules(line, denylist) {
  const rules = [];
  if (HOME_PATH.test(line)) rules.push("home-path");
  if (emailHit(line)) rules.push("email");
  const withoutHex = line.replace(LONG_HEX, "");
  if (TOKEN_SHAPE.test(withoutHex) || QUOTED_SECRET.test(line) || KEY_MATERIAL.test(line)) rules.push("secret");
  if (withoutHex !== line) rules.push("long-hex");
  for (const entry of denylist) if (entry.pattern.test(line)) rules.push(entry.rule);
  return rules;
}

export function scanText(label, text, denylist, skipLine = () => false) {
  const hits = [];
  text.split("\n").forEach((line, index) => {
    if (skipLine(line)) return;
    for (const rule of lineRules(line, denylist)) hits.push({ label, line: index + 1, rule });
  });
  return hits;
}

function scanPath(label, path, denylist) {
  return lineRules(path, denylist).map((rule) => ({ label, line: 0, rule }));
}

function scanContent(label, buffer, denylist) {
  if (buffer.subarray(0, 8000).includes(0)) return [{ label, line: 0, rule: "binary-unscanned" }];
  return scanText(label, buffer.toString("utf8"), denylist);
}

function isGitWorkTree(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    return false;
  }
}

function walk(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED_DIRS.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, root);
    return entry.isFile() ? [relative(root, path)] : [];
  });
}

function treeFiles(dir) {
  if (!isGitWorkTree(dir)) return walk(dir);
  return execFileSync("git", ["-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0")
    .filter((path) => path && existsSync(join(dir, path)) && statSync(join(dir, path)).isFile());
}

const ordered = (hits) => hits.sort((a, b) => a.label.localeCompare(b.label) || a.line - b.line || a.rule.localeCompare(b.rule));

export function scanTree(dir, denylist) {
  return ordered(treeFiles(dir).flatMap((path) => [...scanPath(path, path, denylist), ...scanContent(path, readFileSync(join(dir, path)), denylist)]));
}

function headerOrSignature() {
  let inSignature = false;
  return (line) => {
    if (inSignature && line.startsWith(" ")) return true;
    inSignature = line.startsWith("gpgsig");
    return inSignature || OBJECT_HEADER.test(line);
  };
}

export function scanHistory(repo, denylist) {
  const listing = execFileSync("git", ["-C", repo, "rev-list", "--all", "--objects"], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n").filter(Boolean);
  if (!listing.length) return [];
  const names = new Map(listing.map((entry) => {
    const space = entry.indexOf(" ");
    return space === -1 ? [entry, ""] : [entry.slice(0, space), entry.slice(space + 1)];
  }));
  const batch = execFileSync("git", ["-C", repo, "cat-file", "--batch"], { input: `${[...names.keys()].join("\n")}\n`, maxBuffer: 1 << 30 });
  const hits = [];
  for (const path of new Set(names.values())) if (path) hits.push(...scanPath(path, path, denylist));
  let position = 0;
  while (position < batch.length) {
    const end = batch.indexOf(10, position);
    const [sha, type, size] = batch.subarray(position, end).toString("utf8").split(" ");
    const content = batch.subarray(end + 1, end + 1 + Number(size));
    position = end + 1 + Number(size) + 1;
    const short = sha.slice(0, 7);
    if (type === "blob") hits.push(...scanContent(`${names.get(sha) || "(unnamed)"}@${short}`, content, denylist));
    if (type === "commit" || type === "tag") hits.push(...scanText(`${type} ${short}`, content.toString("utf8"), denylist, headerOrSignature()));
  }
  return ordered(hits);
}

const USAGE = "usage: public-scan.mjs <tree|history> <dir> [--denylist <file>]";

function main(argv) {
  const [mode, dir] = argv;
  const flag = argv.indexOf("--denylist");
  if (!["tree", "history"].includes(mode) || !dir || (flag !== -1 && !argv[flag + 1])) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const denylist = flag === -1 ? [] : loadDenylist(argv[flag + 1]);
  const hits = mode === "tree" ? scanTree(dir, denylist) : scanHistory(dir, denylist);
  const lines = [...new Set(hits.map((hit) => `${hit.label}:${hit.line} ${hit.rule}`))];
  if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
  process.stderr.write(lines.length ? `public-scan: ${lines.length} hit(s) in ${new Set(hits.map((hit) => hit.label)).size} file(s)\n` : `public-scan: clean (${denylist.length} denylist terms)\n`);
  return lines.length ? 1 : 0;
}

export function run() {
  process.exit(main(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
