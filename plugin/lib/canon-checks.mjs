import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

export function docReferenceErrors({ files, read, exists, ignored = () => false }) {
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
        if (path.includes("...") || ignored(path)) continue;
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
  const ignored = (path) => {
    try {
      git(repo, "check-ignore", "-q", path);
      return true;
    } catch {
      return false;
    }
  };
  return { files, read: (path) => readFileSync(join(repo, path), "utf8"), exists: (path) => existsSync(join(repo, path)) && (isFile(path) || !/\.\w+$/.test(path)), ignored };
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

export const inventoryDigest = ({ docsDigest, hookEvents, components }) => createHash("sha256").update(JSON.stringify({ docsDigest, hookEvents, components })).digest("hex").slice(0, 16);

export function surfaceFitErrors(inventory, fit) {
  const surfaces = [...inventory.components, ...fit.extraSurfaces];
  const digest = inventoryDigest(inventory);
  const errors = fit.inventory === digest ? [] : [`surface-fit.json was judged against inventory ${fit.inventory}, the snapshot is now ${digest}: re-judge every need against it, then set "inventory" to ${digest}`];
  const judged = (where, entries) => entries.flatMap(([surface, reason]) => [
    ...(String(reason ?? "").trim() ? [] : [`${where}: ${surface} has no reason`]),
    ...(surfaces.includes(surface) ? [] : [`${where}: ${surface} is not in the inventory`]),
  ]);
  errors.push(...judged("notUsed", Object.entries(fit.notUsed)));
  for (const { need, uses, rejected } of fit.needs) {
    errors.push(...judged(need, [...Object.entries(uses), ...Object.entries(rejected)]));
    errors.push(...surfaces.filter((s) => !(s in uses) && !(s in rejected) && !(s in fit.notUsed)).map((s) => `${need}: ${s} is neither used, rejected with a reason, nor in notUsed`));
    errors.push(...Object.keys(uses).filter((s) => s in fit.notUsed).map((s) => `${need}: ${s} is in notUsed but this need uses it`));
  }
  return errors;
}

export function inventoryVersionErrors(snapshot, installed) {
  const minor = (version) => version.split(".").slice(0, 2).join(".");
  if (!installed || !behind(minor(snapshot), minor(installed))) return [];
  return [`docs/canon/claude-code-inventory.json is from Claude Code ${snapshot}, installed is ${installed}: run python3 plugin/evals/probes/claude-code-inventory.py --json docs/canon/claude-code-inventory.json`];
}

export function installedClaudeVersion() {
  const result = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 30000 });
  return result.status === 0 ? result.stdout.match(/^(\d+\.\d+\.\d+)/)?.[1] ?? null : null;
}

export function kitSurfaceFit(repo) {
  const read = (file) => JSON.parse(readFileSync(join(repo, "docs/canon", file), "utf8"));
  return { inventory: read("claude-code-inventory.json"), fit: read("surface-fit.json") };
}

const PER_TURN_EVENTS = ["UserPromptSubmit", "UserPromptExpansion", "InstructionsLoaded", "SubagentStart"];

export function alwaysOnChars(texts) {
  return texts.reduce((sum, text) => {
    const front = text.match(FRONT_MATTER)?.[1] ?? "";
    return sum + ["description", "when_to_use"].reduce((n, key) => n + (front.match(new RegExp(`^${key}: (.*)$`, "m"))?.[1].length ?? 0), 0);
  }, 0);
}

export function footprintErrors({ chars, budget, tag, tagBudget, version, tagVersion }) {
  const errors = chars <= budget ? [] : [`the kit's always-on text is ${chars} characters, over its budget of ${budget} in docs/canon/footprint-budget.json`];
  if (tagBudget !== undefined && budget > tagBudget && version <= tagVersion) errors.push(`the always-on budget rose from ${tagBudget} at ${tag} to ${budget} without a new standard version`);
  return errors;
}

export function kitFootprint(repo) {
  const docs = [...kitSkills(repo).map(({ text }) => text), ...readdirSync(join(repo, "plugin/agents")).filter((f) => f.endsWith(".md")).map((f) => readFileSync(join(repo, "plugin/agents", f), "utf8"))];
  const BUDGET = "docs/canon/footprint-budget.json";
  const STANDARD = "docs/canon/standard.json";
  const tag = latestReleaseTag(repo);
  const at = (path) => {
    const text = tag && showAt(repo, tag, path);
    return text ? JSON.parse(text) : undefined;
  };
  return {
    chars: alwaysOnChars(docs),
    budget: JSON.parse(readFileSync(join(repo, BUDGET), "utf8")).alwaysOnChars,
    tag,
    tagBudget: at(BUDGET)?.alwaysOnChars,
    version: JSON.parse(readFileSync(join(repo, STANDARD), "utf8")).version,
    tagVersion: at(STANDARD)?.version ?? 0,
  };
}

const ASK_CARDS = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-hooks.mjs" ask-cards';

const onlyAskCards = (event, groups) => event === "UserPromptSubmit" && groups?.length === 1 && groups[0].hooks?.length === 1 && groups[0].hooks[0].type === "command" && groups[0].hooks[0].command === ASK_CARDS;

export function hookEventErrors(events, registered = {}) {
  return events.filter((event) => PER_TURN_EVENTS.includes(event) && !onlyAskCards(event, registered[event])).map((event) => `hooks.json registers ${event}, whose output enters the context on every prompt or every subagent spawn`);
}

export const kitHooks = (repo) => JSON.parse(readFileSync(join(repo, "plugin/hooks/hooks.json"), "utf8")).hooks ?? {};

export const kitHookEvents = (repo) => Object.keys(kitHooks(repo));

export function skillModelErrors(skills) {
  return skills.filter(({ text }) => /^model:/m.test(text.match(FRONT_MATTER)?.[1] ?? "")).map(({ name }) => `${name}: sets model: in its front matter, which switches the session model and starts a cold prompt cache`);
}
