import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const PATH_SPAN = /`((?:plugin|docs|scripts)\/[\w./-]+?)(?::(\d+)(?:-(\d+))?)?`/g;
const FENCE = /^\s*(?:```|~~~)/;
const MANIFEST = "plugin/.claude-plugin/plugin.json";

const parts = (version) => version.split(".").map(Number);
const behind = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  const at = x.findIndex((n, i) => n !== y[i]);
  return at >= 0 && x[at] < y[at];
};
const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 26 });

export function tagVersionErrors({ tags, manifestAt, headVersion }) {
  const releases = tags.filter((tag) => RELEASE_TAG.test(tag));
  const errors = releases.flatMap((tag) => (manifestAt(tag) === tag.slice(1) ? [] : [`tag ${tag} holds plugin.json version ${manifestAt(tag)}`]));
  const latest = releases.map((tag) => tag.slice(1)).reduce((a, b) => (a && !behind(a, b) ? a : b), null);
  if (latest && behind(headVersion, latest)) errors.push(`plugin.json at HEAD is ${headVersion}, behind the latest release tag v${latest}`);
  return errors;
}

export function kitTagVersions(repo) {
  const version = (text) => (text ? JSON.parse(text).version : undefined);
  const manifestAt = (tag) => {
    try {
      return version(git(repo, "show", `${tag}:${MANIFEST}`));
    } catch {
      return undefined;
    }
  };
  return { tags: git(repo, "tag").split("\n").filter(Boolean), manifestAt, headVersion: version(readFileSync(join(repo, MANIFEST), "utf8")) };
}

export function docReferenceErrors({ files, read, exists }) {
  const errors = [];
  for (const file of files) {
    let fenced = false;
    read(file).split("\n").forEach((line, index) => {
      if (FENCE.test(line)) fenced = !fenced;
      if (fenced) return;
      const where = `${file}:${index + 1}`;
      for (const [, target] of line.matchAll(LINK)) {
        if (/^(?:[a-z][\w+.-]*:|#)/i.test(target)) continue;
        const path = decodeURIComponent(target.split("#")[0]);
        if (path && !exists(normalize(path.startsWith("/") ? path.slice(1) : join(dirname(file), path)))) errors.push(`${where}: link ${path} does not resolve`);
      }
      for (const [, path, start, end] of line.matchAll(PATH_SPAN)) {
        if (path.includes("...")) continue;
        if (!exists(path)) {
          errors.push(`${where}: ${path} does not exist`);
          continue;
        }
        const last = Number(end ?? start ?? 0);
        const lines = last ? read(path).split("\n").length - (read(path).endsWith("\n") ? 1 : 0) : 0;
        if (last > lines) errors.push(`${where}: ${path} has ${lines} lines, not line ${last}`);
      }
    });
  }
  return errors;
}

export function kitDocFiles(repo) {
  const card = (file) => /^---\n(?:(?!---\n)[^\n]*\n)*?name: /.test(readFileSync(join(repo, file), "utf8"));
  const files = git(repo, "ls-files", "README.md", "docs", "plugin").split("\n")
    .filter((file) => file.endsWith(".md") && !file.startsWith("docs/adr/") && !file.startsWith("docs/prior-art/sweeps/") && !card(file));
  const isFile = (path) => existsSync(join(repo, path)) && statSync(join(repo, path)).isFile();
  return { files, read: (path) => readFileSync(join(repo, path), "utf8"), exists: (path) => existsSync(join(repo, path)) && (isFile(path) || !/\.\w+$/.test(path)) };
}

export function retiredReferenceErrors({ retired, scanned }) {
  return scanned.flatMap(({ file, text }) => retired.filter((name) => text.includes(name)).map((name) => `${file} names the retired ${name}`));
}

export function kitRetiredNames(repo) {
  const now = git(repo, "ls-files").split("\n").filter(Boolean);
  const present = new Set(now.map((file) => basename(file)));
  const deleted = git(repo, "log", "--diff-filter=D", "--name-only", "--format=", "--", "plugin").split("\n").filter(Boolean).map((file) => basename(file));
  const retired = [...new Set(deleted)].filter((name) => !present.has(name) && /\.(?:mjs|md|json|sh|py)$/.test(name) && !/^(?:SKILL|README)\.md$/.test(name)).sort();
  const scanned = now.filter((file) => (file.startsWith("plugin/") || file === "README.md") && /\.(?:mjs|md|json|sh|py)$/.test(file))
    .map((file) => ({ file, text: readFileSync(join(repo, file), "utf8") }));
  return { retired, scanned };
}
