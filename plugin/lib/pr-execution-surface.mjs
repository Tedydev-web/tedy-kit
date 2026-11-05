import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const LOCKFILE = /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/;
const EXECUTED_CONFIG = /(^|\/)(?:[^/]+\.config\.[cm]?[jt]s|\.eslintrc[^/]*|\.prettierrc\.[^/]+|(?:jest|vitest)\.setup[^/]*|setupTests[^/]*|\.npmrc|\.yarnrc[^/]*|Makefile|tsconfig[^/]*\.json)$|(^|\/)\.husky\//;
const TEST_FILE = /(^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const DOWNLOADS = /(?:^|[\s;&|(])(?:npx|bunx|pnpx)\s|\b(?:pnpm|yarn)\s+dlx\b/;
const SCRIPT_FILE = /\/|\.(?:[cm]?[jt]s|sh|py)$/;
const NOT_JSON = "(not valid JSON at the head)";

const gitIn = (dir) => (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

function commitOf(git, ref) {
  try {
    return git("rev-parse", "--verify", "-q", `${ref}^{commit}`).trim();
  } catch {
    throw new Error(`${ref} is not a commit in this repository`);
  }
}

function packageAt(git, rev, file) {
  let text;
  try {
    text = git("show", `${rev}:${file}`);
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return null;
  }
}

const entries = (value) => (value && typeof value === "object" ? value : {});

function changedEntries(before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return names.filter((name) => before[name] !== after[name]).map((name) => ({ name, before: before[name] ?? null, after: after[name] ?? null }));
}

function scriptPaths(line, dir) {
  return line.split(/[\s;&|()<>=,"'`]+/).filter((token) => token && !token.startsWith("-") && SCRIPT_FILE.test(token) && !/^[a-z]+:\/\//i.test(token)).map((token) => posix.normalize(posix.join(dir, token)));
}

export function executionSurface(dir, base, head) {
  const git = gitIn(dir);
  const headSha = commitOf(git, head);
  commitOf(git, base);
  const mergeBase = git("merge-base", base, headSha).trim();
  const changed = git("diff", "--name-only", "-z", "--no-renames", mergeBase, headSha).split("\0").filter(Boolean);
  const changedSet = new Set(changed);
  const packages = git("ls-tree", "-r", "-z", "--name-only", headSha).split("\0").filter((file) => posix.basename(file) === "package.json");
  const surface = { base, head, headSha, mergeBase, changed: changed.length, scripts: [], dependencies: [], lockfiles: changed.filter((file) => LOCKFILE.test(file)), config: changed.filter((file) => EXECUTED_CONFIG.test(file)), named: [], downloads: [], tests: changed.filter((file) => TEST_FILE.test(file)).length };
  for (const file of changed.filter((path) => posix.basename(path) === "package.json")) {
    const before = packageAt(git, mergeBase, file) ?? {};
    const after = packageAt(git, headSha, file);
    if (after === null) {
      surface.scripts.push({ file, name: "", before: null, after: NOT_JSON });
      continue;
    }
    for (const entry of changedEntries(entries(before.scripts), entries(after.scripts))) surface.scripts.push({ file, ...entry });
    for (const section of DEPENDENCY_SECTIONS) for (const entry of changedEntries(entries(before[section]), entries(after[section]))) surface.dependencies.push({ file, section, ...entry });
    if (before.packageManager !== after.packageManager) surface.dependencies.push({ file, section: "packageManager", name: "", before: before.packageManager ?? null, after: after.packageManager ?? null });
  }
  for (const file of packages) {
    const scripts = entries(packageAt(git, headSha, file)?.scripts);
    const folder = posix.dirname(file);
    for (const [name, line] of Object.entries(scripts)) {
      if (typeof line !== "string") continue;
      for (const path of new Set(scriptPaths(line, folder))) if (changedSet.has(path)) surface.named.push({ file: path, by: `${file} scripts.${name}` });
      if (DOWNLOADS.test(line)) surface.downloads.push({ file, name, line });
    }
  }
  surface.lintSurfaceChanged = Boolean(surface.scripts.length || surface.config.length || surface.named.length || surface.dependencies.some((entry) => entry.section === "packageManager"));
  return surface;
}

const shown = (value) => (value === null ? "(none)" : value);
const listed = (label, items) => (items.length ? items.map((item) => `${label}: ${item}`) : [`${label}: none`]);

export function formatSurface(surface) {
  const lintParts = [["scripts", surface.scripts.length], ["config", surface.config.length], ["named by a script", surface.named.length], ["packageManager", surface.dependencies.some((entry) => entry.section === "packageManager")]].filter(([, hit]) => hit).map(([label]) => label);
  return [
    `execution surface of ${surface.head} (${surface.headSha.slice(0, 7)}) against ${surface.base} (merge base ${surface.mergeBase.slice(0, 7)}), ${surface.changed} changed file${surface.changed === 1 ? "" : "s"}`,
    ...listed("scripts", surface.scripts.map((entry) => (entry.name ? `${entry.file} scripts.${entry.name}: ${JSON.stringify(shown(entry.before))} -> ${JSON.stringify(shown(entry.after))}` : `${entry.file}: ${entry.after}`))),
    ...listed("dependencies", surface.dependencies.map((entry) => `${entry.file} ${entry.section}${entry.name ? `.${entry.name}` : ""}: ${shown(entry.before)} -> ${shown(entry.after)}`)),
    ...listed("lockfiles", surface.lockfiles),
    ...listed("config", surface.config),
    ...listed("named by a script", surface.named.map((entry) => `${entry.file} (${entry.by})`)),
    ...listed("downloads and runs", surface.downloads.map((entry) => `${entry.file} scripts.${entry.name}: ${entry.line}`)),
    `changed test files: ${surface.tests}`,
    surface.lintSurfaceChanged ? `typecheck/lint surface: changed (${lintParts.join(", ")})` : "typecheck/lint surface: unchanged; an unchanged script line and unchanged config run no file of this PR",
  ].join("\n");
}

export function run() {
  const [base, head, ...rest] = process.argv.slice(2);
  if (!base || !head || rest.length) {
    console.error("usage: pr-execution-surface.mjs <base ref> <head ref>   (run in the reviewed repository, e.g. origin/<base> refs/pr/<n>)");
    process.exit(2);
  }
  try {
    console.log(formatSurface(executionSurface(process.cwd(), base, head)));
  } catch (error) {
    console.error(`pr-execution-surface: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
