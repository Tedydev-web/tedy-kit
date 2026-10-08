import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHARED = fileURLToPath(new URL("../shared/", import.meta.url));
const PERSONAL_GATES = ["noComments", "draftPrOnly", "roleGate"];

export const DEFAULT_CONFIG = Object.freeze({
  gates: Object.freeze({ noComments: false, draftPrOnly: false, roleGate: false, pushExempt: Object.freeze([]) }),
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
  checkKeys(file, gates, [...PERSONAL_GATES, "pushExempt"], "gates.");
  checkKeys(file, language, ["chat"], "language.");
  for (const key of PERSONAL_GATES) if (key in gates && typeof gates[key] !== "boolean") throw new Error(`${file}: gates.${key} must be a boolean`);
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

export function initProfile(dir = profileDir()) {
  const result = { created: [], kept: [] };
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "config.json");
  if (existsSync(config)) result.kept.push("config.json");
  else {
    writeFileSync(config, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
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

function doctor(dir) {
  const lines = [`profile: ${dir}${existsSync(dir) ? "" : " (missing)"}`];
  let status = 0;
  if (!existsSync(join(dir, "config.json"))) lines.push("config: missing, defaults apply (personal gates off)");
  else {
    try {
      const on = PERSONAL_GATES.filter((key) => loadConfig(dir).gates[key]);
      lines.push(`config: ok (${on.length ? `personal gates on: ${on.join(", ")}` : "personal gates off"})`);
    } catch (error) {
      lines.push(`config: invalid: ${error.message}`);
      status = 1;
    }
  }
  lines.push(existsSync(join(dir, "rules.md")) ? "rules: present" : "rules: missing; run profile.mjs init");
  const shadowed = overrides(dir);
  lines.push(`overrides: ${shadowed.length ? shadowed.join(", ") : "none"}`);
  const maps = files(join(dir, "projects")).filter((rel) => !rel.includes("/") && rel.endsWith(".md") && !rel.startsWith("_")).length;
  lines.push(`projects: ${maps} map${maps === 1 ? "" : "s"}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return status;
}

const USAGE = "usage: profile.mjs <path <relative-path>|doctor|init>";

function main([command, arg]) {
  const dir = profileDir();
  if (command === "doctor") return doctor(dir);
  if (command === "init") {
    const { created, kept } = initProfile(dir);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
