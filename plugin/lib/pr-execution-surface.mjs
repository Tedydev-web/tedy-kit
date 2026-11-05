import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const LOCKFILE = /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/;
const EXECUTED_CONFIG = /(^|\/)(?:[^/]+\.config\.(?:[cm]?[jt]s|json)|\.(?:eslintrc|prettierrc|babelrc|stylelintrc|mocharc|nycrc|c8rc|swcrc|lintstagedrc|postcssrc|yarnrc)[^/]*|(?:jest|vitest)\.setup[^/]*|setupTests[^/]*|\.npmrc|\.pnpmfile\.cjs|bunfig\.toml|Makefile|(?:ts|js)config[^/]*\.json)$|(^|\/)\.husky\//;
const PACKAGE_CONFIG = ["eslintConfig", "prettier", "babel", "stylelint", "jest", "mocha", "ava", "nyc", "c8", "lint-staged"];
const TEST_FILE = /(^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const DOWNLOADS = /(?:^|[\s;&|(])(?:npx|bunx|pnpx)\s|\b(?:pnpm|yarn)\s+dlx\b/;
const VENDORED = /(^|\/)node_modules\//;
const LOCAL_SPECIFIER = /["'`](\.{1,2}\/[^"'`\s]*)["'`]/g;
const LINK_MODE = "120000";
const NOT_JSON = "(not valid JSON at the head)";
const NOT_CHECKED = "not checked: files imported more than one level from a config or a named script, packages a config names, and code a tool loads from node_modules";
const NOT_COMPLETE = "running any project script (tests, typecheck, lint) runs code from this PR; this list is only what the kit can see, not a complete list";

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

function changedPaths(git, from, to) {
  const fields = git("diff", "--raw", "-z", "--no-renames", from, to).split("\0");
  const changed = [];
  const symlinks = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [before, after] = fields[index].slice(1).split(" ");
    changed.push(fields[index + 1]);
    if (before === LINK_MODE || after === LINK_MODE) symlinks.push(fields[index + 1]);
  }
  return { changed, symlinks };
}

const inside = (file, path) => path === "." || file === path || file.startsWith(`${path}/`);

function scriptPaths(line, folder) {
  const root = posix.normalize(folder);
  return line.split(/[\s;&|()<>=,"'`]+/).filter((token) => token && !token.startsWith("-") && !/^[a-z]+:\/\//i.test(token)).map((token) => posix.normalize(posix.join(folder, token)).replace(/\/+$/, "")).filter((path) => path && path !== root && path !== "." && !path.startsWith("../"));
}

function importedPaths(text, file, changed) {
  const folder = posix.dirname(file);
  const hits = new Set();
  for (const [, specifier] of text.matchAll(LOCAL_SPECIFIER)) {
    const path = posix.normalize(posix.join(folder, specifier)).replace(/\/+$/, "");
    const stems = inside(folder, path) ? [posix.join(path, "index")] : [path, posix.join(path, "index")];
    for (const candidate of changed) if (candidate === path || stems.some((stem) => candidate.startsWith(`${stem}.`) && !candidate.includes("/", stem.length))) hits.add(candidate);
  }
  return [...hits];
}

function showAt(git, rev, file) {
  try {
    return git("show", `${rev}:${file}`);
  } catch {
    return "";
  }
}

export function executionSurface(dir, base, head) {
  const git = gitIn(dir);
  const headSha = commitOf(git, head);
  commitOf(git, base);
  const mergeBase = git("merge-base", base, headSha).trim();
  const { changed, symlinks } = changedPaths(git, mergeBase, headSha);
  const changedSet = new Set(changed);
  const tree = git("ls-tree", "-r", "-z", "--name-only", headSha).split("\0").filter((file) => file && !VENDORED.test(file));
  const files = new Set(tree);
  const folders = new Set(tree.flatMap((file) => file.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"))));
  const surface = { base, head, headSha, mergeBase, changed: changed.length, scripts: [], dependencies: [], lockfiles: changed.filter((file) => LOCKFILE.test(file)), config: changed.filter((file) => EXECUTED_CONFIG.test(file)), named: [], imported: [], vendored: changed.filter((file) => VENDORED.test(file)), symlinks, downloads: [], tests: changed.filter((file) => TEST_FILE.test(file)).length };
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
    for (const field of PACKAGE_CONFIG) if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) surface.config.push(`${file} ${field}`);
  }
  const importers = tree.filter((file) => EXECUTED_CONFIG.test(file) && !changedSet.has(file)).map((file) => ({ file, by: file, text: () => showAt(git, headSha, file) }));
  for (const file of tree.filter((path) => posix.basename(path) === "package.json")) {
    const manifest = packageAt(git, headSha, file);
    const folder = posix.dirname(file);
    for (const field of PACKAGE_CONFIG) if (manifest?.[field] !== undefined) importers.push({ file, by: `${file} ${field}`, text: () => JSON.stringify(manifest[field]) });
    for (const [name, line] of Object.entries(entries(manifest?.scripts))) {
      if (typeof line !== "string") continue;
      const by = `${file} scripts.${name}`;
      for (const path of new Set(scriptPaths(line, folder))) {
        const count = folders.has(path) ? changed.filter((candidate) => candidate.startsWith(`${path}/`)).length : 0;
        if (changedSet.has(path)) surface.named.push({ file: path, by });
        else if (count) surface.named.push({ file: `${path}/`, by, changed: count });
        if (files.has(path) && !changedSet.has(path)) importers.push({ file: path, by: path, text: () => showAt(git, headSha, path) });
      }
      if (DOWNLOADS.test(line)) surface.downloads.push({ file, name, line });
    }
  }
  surface.named = [...new Map(surface.named.map((entry) => [`${entry.file}\0${entry.by}`, entry])).values()];
  const seen = new Set();
  for (const { file, by, text } of importers) {
    if (seen.has(by)) continue;
    seen.add(by);
    for (const hit of importedPaths(text(), file, changed)) surface.imported.push({ file: hit, by });
  }
  surface.lintSurfaceChanged = Boolean(surface.scripts.length || surface.config.length || surface.named.length || surface.imported.length || surface.vendored.length || surface.symlinks.length || surface.dependencies.some((entry) => entry.section === "packageManager"));
  return surface;
}

const shown = (value) => (value === null ? "(none)" : value);
const listed = (label, items) => (items.length ? items.map((item) => `${label}: ${item}`) : [`${label}: none`]);

export function formatSurface(surface) {
  const lintParts = [["scripts", surface.scripts.length], ["config", surface.config.length], ["named by a script", surface.named.length], ["imported", surface.imported.length], ["node_modules", surface.vendored.length], ["symlinks", surface.symlinks.length], ["packageManager", surface.dependencies.some((entry) => entry.section === "packageManager")]].filter(([, hit]) => hit).map(([label]) => label);
  return [
    `execution surface of ${surface.head} (${surface.headSha.slice(0, 7)}) against ${surface.base} (merge base ${surface.mergeBase.slice(0, 7)}), ${surface.changed} changed file${surface.changed === 1 ? "" : "s"}`,
    ...listed("scripts", surface.scripts.map((entry) => (entry.name ? `${entry.file} scripts.${entry.name}: ${JSON.stringify(shown(entry.before))} -> ${JSON.stringify(shown(entry.after))}` : `${entry.file}: ${entry.after}`))),
    ...listed("dependencies", surface.dependencies.map((entry) => `${entry.file} ${entry.section}${entry.name ? `.${entry.name}` : ""}: ${shown(entry.before)} -> ${shown(entry.after)}`)),
    ...listed("lockfiles", surface.lockfiles),
    ...listed("config", surface.config),
    ...listed("named by a script", surface.named.map((entry) => `${entry.file} (${entry.changed ? `${entry.changed} changed file${entry.changed === 1 ? "" : "s"}, ` : ""}${entry.by})`)),
    ...listed("imported by an unchanged config or named script", surface.imported.map((entry) => `${entry.file} (${entry.by})`)),
    ...listed("committed under node_modules", surface.vendored),
    ...listed("symlinks", surface.symlinks),
    ...listed("downloads and runs", surface.downloads.map((entry) => `${entry.file} scripts.${entry.name}: ${entry.line}`)),
    `changed test files: ${surface.tests}`,
    surface.lintSurfaceChanged ? `typecheck/lint surface: changes seen (${lintParts.join(", ")})` : "typecheck/lint surface: no change seen",
    NOT_CHECKED,
    NOT_COMPLETE,
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
