import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { findComments } from "./comment-scan.mjs";

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const PATH_SPAN = /`((?:plugin|docs|scripts)\/[\w./-]+?)(?::(\d+)(?:-(\d+))?)?`/g;
const FENCE = /^\s*(?:```|~~~)/;
const MANIFEST = "plugin/.claude-plugin/plugin.json";
const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n/;
const CARD = /^---\n(?:(?!---\n)[^\n]*\n)*?name: /;
const PYTHON_COMMENTS = fileURLToPath(new URL("../evals/probes/python-comments.py", import.meta.url));

const parts = (version) => version.split(".").map(Number);
const behind = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  const at = x.findIndex((n, i) => n !== y[i]);
  return at >= 0 && x[at] < y[at];
};
const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 26 });

const latestRelease = (tags) => tags.filter((tag) => RELEASE_TAG.test(tag)).map((tag) => tag.slice(1)).reduce((a, b) => (a && !behind(a, b) ? a : b), null);

export function latestReleaseTag(repo) {
  const latest = latestRelease(git(repo, "tag").split("\n").filter(Boolean));
  return latest && `v${latest}`;
}

export function showAt(repo, ref, path) {
  try {
    return execFileSync("git", ["-C", repo, "show", `${ref}:${path}`], { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return undefined;
  }
}

export function tagVersionErrors({ tags, manifestAt, headVersion }) {
  const releases = tags.filter((tag) => RELEASE_TAG.test(tag));
  const errors = releases.flatMap((tag) => (manifestAt(tag) === tag.slice(1) ? [] : [`tag ${tag} holds plugin.json version ${manifestAt(tag)}`]));
  const latest = latestRelease(releases);
  if (latest && behind(headVersion, latest)) errors.push(`plugin.json at HEAD is ${headVersion}, behind the latest release tag v${latest}`);
  return errors;
}

export function kitTagVersions(repo) {
  const version = (text) => (text ? JSON.parse(text).version : undefined);
  const manifestAt = (tag) => version(showAt(repo, tag, MANIFEST));
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
  const card = (file) => CARD.test(readFileSync(join(repo, file), "utf8"));
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

export function skillSectionErrors(skills) {
  return skills.flatMap(({ name, text }) => {
    const body = text.replace(FRONT_MATTER, "");
    const laws = body.search(/^## Iron laws$/m);
    const notThis = body.search(/^## Not this skill$/m);
    if (laws < 0) return [`${name}: no ## Iron laws section`];
    const errors = body.slice(0, laws).trim().split(/\n\s*\n/).at(-1).startsWith("You ") ? [] : [`${name}: the paragraph before ## Iron laws is not a persona opening with "You "`];
    if (notThis < laws) errors.push(`${name}: no ## Not this skill section after ## Iron laws`);
    return errors;
  });
}

export function skillDescriptionErrors(skills) {
  return skills.flatMap(({ name, text }) => {
    const description = text.match(FRONT_MATTER)?.[1].match(/^description: (.*)$/m)?.[1];
    if (description === undefined || /^[|>]/.test(description)) return [`${name}: no one-line description in the front matter`];
    const errors = description.length < 1024 ? [] : [`${name}: the description is ${description.length} characters, not under 1,024`];
    if (/ #|: /.test(description)) errors.push(`${name}: the description holds " #" or ": ", which plain YAML reads as a comment or a mapping`);
    return errors;
  });
}

export function kitSkills(repo) {
  const root = join(repo, "plugin/skills");
  return readdirSync(root).filter((name) => existsSync(join(root, name, "SKILL.md"))).map((name) => ({ name, text: readFileSync(join(root, name, "SKILL.md"), "utf8") }));
}

export function kitArtifacts(repo) {
  const tracked = git(repo, "ls-files", "plugin/skills", "docs/adr", "docs/prior-art").split("\n").filter(Boolean);
  return tracked.filter((file) => /^plugin\/skills\/[^/]+\/SKILL\.md$/.test(file) || /^docs\/adr\/[^/]+\.md$/.test(file) || /^docs\/prior-art\/sweeps\/[^/]+\.md$/.test(file)
    || (/^docs\/prior-art\/[^/]+\.md$/.test(file) && CARD.test(readFileSync(join(repo, file), "utf8"))));
}

export function topicLineErrors(records) {
  return records.filter(({ text }) => !/^- Topic: \S+$/m.test(text)).map(({ file }) => `${file}: no "- Topic: <topic>" line`);
}

export function sourceCommentErrors({ scripts, python, cwd }) {
  const errors = scripts.flatMap(({ file, text }) => findComments(text).map((comment) => `${file}:${comment.line}: ${comment.text}`));
  if (!python.length) return errors;
  const run = spawnSync("python3", ["-B", PYTHON_COMMENTS, ...python], { cwd, encoding: "utf8", maxBuffer: 1 << 26 });
  if (run.error || run.status !== 0) return [...errors, `python3 could not scan the Python files: ${run.error?.message ?? (run.stderr.trim().split("\n").at(-1) || `exit ${run.status}`)}`];
  return [...errors, ...run.stdout.split("\n").filter(Boolean)];
}

export function kitSourceFiles(repo) {
  const tracked = git(repo, "ls-files").split("\n").filter(Boolean);
  return {
    scripts: tracked.filter((file) => /\.(?:mjs|cjs|js)$/.test(file)).map((file) => ({ file, text: readFileSync(join(repo, file), "utf8") })),
    python: tracked.filter((file) => file.endsWith(".py")),
    cwd: repo,
  };
}
