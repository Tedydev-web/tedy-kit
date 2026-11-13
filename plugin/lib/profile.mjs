import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLAUDE_SETTINGS, KIT_PUBLISH_ASK_RULES, plannedPermissions, readSettings, retiredDenyRules, unchanged, writePermissions } from "./publish-approval-settings.mjs";

const SHARED = fileURLToPath(new URL("../shared/", import.meta.url));
const PERSONAL_GATES = ["noComments", "draftPrOnly", "ghWrites", "publishQuote"];
const INIT_GATES = ["ghWrites", "publishQuote"];
const CONVENTION_GATES = ["noComments", "draftPrOnly"];
const OBSOLETE_PUBLISH_APPROVAL = Object.freeze(["ask", "answer"]);

export const DEFAULT_CONFIG = Object.freeze({
  gates: Object.freeze({ noComments: false, draftPrOnly: false, ghWrites: false, publishQuote: false, pushExempt: Object.freeze([]) }),
  language: Object.freeze({ chat: "en" }),
});

export const profileDir = (env = process.env) => env.TEDY_PROFILE_DIR || join(homedir(), ".config", "tedy");

const expandHome = (path) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);

function checkKeys(file, value, allowed, prefix) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${file}: unknown key "${prefix}${key}"`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function loadConfig(dir = profileDir()) {
  const file = join(dir, "config.json");
  if (!existsSync(file)) return structuredClone(DEFAULT_CONFIG);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: not valid JSON (${error.message})`);
  }
  if (!isObject(raw)) throw new Error(`${file}: must be a JSON object`);
  checkKeys(file, raw, ["gates", "language"], "");
  const gates = raw.gates ?? {};
  const language = raw.language ?? {};
  if (!isObject(gates)) throw new Error(`${file}: gates must be an object`);
  if (!isObject(language)) throw new Error(`${file}: language must be an object`);
  checkKeys(file, gates, [...PERSONAL_GATES, "publishApproval", "roleGate", "pushExempt"], "gates.");
  checkKeys(file, language, ["chat"], "language.");
  for (const key of PERSONAL_GATES) if (key in gates && typeof gates[key] !== "boolean") throw new Error(`${file}: gates.${key} must be a boolean`);
  if ("publishApproval" in gates && !OBSOLETE_PUBLISH_APPROVAL.includes(gates.publishApproval)) throw new Error(`${file}: gates.publishApproval is obsolete and, while it stays, must be "ask" or "answer"`);
  if ("pushExempt" in gates && !(Array.isArray(gates.pushExempt) && gates.pushExempt.every((path) => typeof path === "string" && path))) throw new Error(`${file}: gates.pushExempt must be an array of strings`);
  if ("chat" in language && !(typeof language.chat === "string" && language.chat.trim())) throw new Error(`${file}: language.chat must be a non-empty string`);
  return {
    gates: {
      ...Object.fromEntries(PERSONAL_GATES.map((key) => [key, gates[key] ?? DEFAULT_CONFIG.gates[key]])),
      pushExempt: (gates.pushExempt ?? []).map(expandHome),
    },
    language: { chat: language.chat ?? DEFAULT_CONFIG.language.chat },
  };
}

export function resolveShared(rel, dir = profileDir()) {
  const clean = normalize(rel);
  if (!rel || isAbsolute(rel) || clean.startsWith("..")) throw new Error(`${rel}: give a relative path inside the profile or plugin/shared`);
  const mine = join(dir, clean);
  if (existsSync(mine)) return mine;
  const engine = join(SHARED, clean);
  if (existsSync(engine)) return engine;
  throw new Error(`${clean}: neither ${mine} nor ${engine} exists`);
}

function files(dir, root = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === ".git") return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path, root) : [relative(root, path)];
  });
}

export const overrides = (dir = profileDir()) => files(dir).filter((rel) => existsSync(join(SHARED, rel))).sort();

export function initProfile(dir = profileDir(), conventions = []) {
  const unknown = conventions.filter((key) => !CONVENTION_GATES.includes(key));
  if (unknown.length) throw new Error(`init takes only ${CONVENTION_GATES.join(" and ")}, not ${unknown.join(", ")}`);
  const result = { created: [], kept: [] };
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "config.json");
  if (existsSync(config)) result.kept.push("config.json");
  else {
    const gates = { ...DEFAULT_CONFIG.gates, ...Object.fromEntries([...INIT_GATES, ...conventions].map((key) => [key, true])) };
    writeFileSync(config, `${JSON.stringify({ ...DEFAULT_CONFIG, gates }, null, 2)}\n`);
    result.created.push("config.json");
  }
  const rules = join(dir, "rules.md");
  if (existsSync(rules)) result.kept.push("rules.md");
  else {
    copyFileSync(join(SHARED, "rules-template.md"), rules);
    result.created.push("rules.md");
  }
  const projects = join(dir, "projects");
  if (existsSync(projects)) result.kept.push("projects/");
  else {
    mkdirSync(projects);
    result.created.push("projects/");
  }
  return result;
}

const MIN_CLAUDE_VERSION = [2, 1, 301];
const RULES_BUDGET = 6300;

function git(dir, ...args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function claudeMdImports(env) {
  const file = env.TEDY_CLAUDE_MD || join(homedir(), ".claude", "CLAUDE.md");
  if (!existsSync(file)) return [true, `no ${file}`];
  const targets = readFileSync(file, "utf8").split("\n").flatMap((line) => line.match(/^@(\S+)/)?.slice(1) ?? []);
  const missing = targets.filter((target) => !existsSync(expandHome(target)));
  return missing.length ? [false, `missing: ${missing.join(", ")}`] : [true, `${targets.length} import${targets.length === 1 ? "" : "s"} found`];
}

function claudeVersion(env) {
  let text = env.TEDY_CLAUDE_VERSION;
  if (!text) {
    try {
      text = execFileSync("claude", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return [false, "could not run claude --version"];
    }
  }
  const found = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!found) return [false, `could not read a version from "${text.trim()}"`];
  const version = found.slice(1).map(Number);
  const below = version.findIndex((part, index) => part !== MIN_CLAUDE_VERSION[index]);
  const ok = below === -1 || version[below] > MIN_CLAUDE_VERSION[below];
  return [ok, `${found[0]}${ok ? "" : `, below ${MIN_CLAUDE_VERSION.join(".")}`}`];
}

function publishAskRules(file) {
  let ask;
  try {
    ({ ask } = readSettings(file));
  } catch (error) {
    return [false, `${error.message}; run profile.mjs publish-approval ask`];
  }
  const present = KIT_PUBLISH_ASK_RULES.filter((rule) => ask.includes(rule)).length;
  const count = `${present}/${KIT_PUBLISH_ASK_RULES.length} in ${file}`;
  return present === KIT_PUBLISH_ASK_RULES.length ? [true, count] : [false, `${count}, so a kit publish may not prompt; run profile.mjs publish-approval ask`];
}

function releaseWorktree(dir, env) {
  const file = env.TEDY_KNOWN_MARKETPLACES || join(homedir(), ".claude", "plugins", "known_marketplaces.json");
  let entry;
  try {
    entry = JSON.parse(readFileSync(file, "utf8"))["tedy-kit"];
  } catch {
    return [true, `no ${file}`];
  }
  const path = entry?.source?.path ?? entry?.installLocation;
  if (!path) return [true, "the tedy-kit marketplace is not a local directory"];
  const gitDir = git(path, "rev-parse", "--path-format=absolute", "--git-dir");
  if (!gitDir || gitDir === git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")) return [true, `${path} is not a linked worktree`];
  if (git(path, "status", "--porcelain")) return [false, `${path} has uncommitted changes`];
  const tag = git(path, "describe", "--exact-match", "--tags");
  const tagFile = join(dir, "release-tag");
  const expected = existsSync(tagFile) ? readFileSync(tagFile, "utf8").trim() : null;
  if (!expected) return [false, `${tagFile} is missing`];
  return tag === expected ? [true, `${path} at ${tag}`] : [false, `${path} is at ${tag ?? "no tag"}, ${tagFile} says ${expected}`];
}

function doctor(dir, env = process.env) {
  const lines = [];
  let status = 0;
  const check = (name, [ok, detail]) => {
    lines.push(`${ok ? "ok" : "fail"} ${name}: ${detail}`);
    if (!ok) status = 1;
  };
  const relativeDir = env.TEDY_PROFILE_DIR && !isAbsolute(env.TEDY_PROFILE_DIR);
  check("profile-dir", relativeDir ? [false, `TEDY_PROFILE_DIR must be an absolute path, got ${env.TEDY_PROFILE_DIR}`] : [true, `${dir}${existsSync(dir) ? "" : " (missing)"}`]);
  if (!existsSync(join(dir, "config.json"))) check("config", [true, existsSync(join(dir, "rules.md")) ? "missing; rules.md exists, so every personal gate is on" : "missing, defaults apply (personal gates off)"]);
  else {
    try {
      const on = PERSONAL_GATES.filter((key) => loadConfig(dir).gates[key]);
      check("config", [true, on.length ? `personal gates on: ${on.join(", ")}` : "personal gates off"]);
      if (JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).gates?.publishApproval === "answer") lines.push(OBSOLETE_ANSWER);
    } catch (error) {
      check("config", [false, `invalid: ${error.message}`]);
    }
  }
  check("claude-md-imports", claudeMdImports(env));
  check("claude-version", claudeVersion(env));
  check("publish-ask-rules", publishAskRules(CLAUDE_SETTINGS));
  check("release-worktree", releaseWorktree(resolve(dir), env));
  if (existsSync(join(dir, "rules.md"))) {
    const size = statSync(join(dir, "rules.md")).size;
    check("rules-size", [size <= RULES_BUDGET, `${size} bytes${size > RULES_BUDGET ? `, over ${RULES_BUDGET}` : ""}`]);
  }
  lines.push(existsSync(join(dir, "rules.md")) ? "rules: present" : "rules: missing; run profile.mjs init");
  const shadowed = overrides(dir);
  lines.push(`overrides: ${shadowed.length ? shadowed.join(", ") : "none"}`);
  const maps = files(join(dir, "projects")).filter((rel) => !rel.includes("/") && rel.endsWith(".md") && !rel.startsWith("_")).length;
  lines.push(`projects: ${maps} map${maps === 1 ? "" : "s"}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return status;
}

const OBSOLETE_ANSWER = 'obsolete: gates.publishApproval "answer" is read as ask, because a publish is approved once, at the command prompt (ADR 0022); run profile.mjs publish-approval ask to drop it, restore the kit publish ask rules and remove the retired deny rules';

function publishApproval(dir, restore, settingsFile = CLAUDE_SETTINGS) {
  const file = join(dir, "config.json");
  const current = readSettings(settingsFile);
  const retired = retiredDenyRules().filter((rule) => current.deny.includes(rule)).length;
  if (!restore) {
    const present = KIT_PUBLISH_ASK_RULES.filter((rule) => current.ask.includes(rule)).length;
    process.stdout.write(`publish approval: one prompt per publish, from the kit publish ask rules\nkit publish ask rules in ${settingsFile}: ${present}/${KIT_PUBLISH_ASK_RULES.length}\nretired deny rules in ${settingsFile}: ${retired}\n`);
    return 0;
  }
  if (!existsSync(file)) throw new Error(`${file} is missing; run profile.mjs init first`);
  loadConfig(dir);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const next = plannedPermissions(current);
  const lines = [];
  if (unchanged(current, next)) lines.push(`${settingsFile}: every kit publish ask rule is present and no retired deny rule is left, not written`);
  else {
    const { backup, removed, added } = writePermissions(settingsFile, current, next);
    lines.push(`${settingsFile}: restored ${added} kit publish ask rules, removed ${removed} retired rules; backup ${backup}`);
  }
  if (raw.gates && "publishApproval" in raw.gates) {
    const { publishApproval: dropped, ...gates } = raw.gates;
    writeFileSync(file, `${JSON.stringify({ ...raw, gates }, null, 2)}\n`);
    lines.push(`${file}: removed the obsolete gates.publishApproval "${dropped}"`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

const USAGE = "usage: profile.mjs <path <relative-path>|doctor|init [noComments] [draftPrOnly]|publish-approval [ask]>";

function main([command, arg, ...rest]) {
  const dir = profileDir();
  if (command === "doctor") return doctor(dir);
  if (command === "publish-approval" && arg === "answer" && !rest.length) {
    process.stderr.write(`publish-approval answer is gone: a publish is approved once, at the command prompt (ADR 0022); nothing was written. Run profile.mjs publish-approval ask to restore the kit publish ask rules.\n`);
    return 2;
  }
  if (command === "publish-approval" && !rest.length && (arg === undefined || arg === "ask")) {
    try {
      return publishApproval(dir, arg === "ask");
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
  }
  if (command === "init") {
    const conventions = [arg, ...rest].filter((key) => key !== undefined);
    if (!conventions.every((key) => CONVENTION_GATES.includes(key))) {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
    const { created, kept } = initProfile(dir, conventions);
    process.stdout.write(`profile: ${dir}\ncreated: ${created.join(", ") || "nothing"}\nkept: ${kept.join(", ") || "nothing"}\n`);
    return 0;
  }
  if (command === "path" && arg) {
    try {
      process.stdout.write(`${resolveShared(arg, dir)}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

export function run() {
  process.exit(main(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
