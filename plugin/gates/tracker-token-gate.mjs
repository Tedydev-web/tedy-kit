import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, matchesGlob, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { deny, logGate, readHookInput } from "../lib/hook-io.mjs";
import { expandHome, walkSegments } from "../lib/shell-segments.mjs";

const TOKEN_FILE = [/\.config\/op\/config\.json/, /["']op["']\s*[,/+]\s*["']config\.json["']/];
const CONFIG_FILE = join(homedir(), ".config", "op", "config.json");
const PATH_FIELDS = ["file_path", "path", "notebook_path"];
const GLOB = /[*?[]/;
const RECURSIVE_READERS = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack", "tar", "zip"]);
const LISTERS = new Set(["find", "fd", "fdfind"]);
const EXEC_FLAG = /^(-exec|-execdir|-ok|-okdir|-x|--exec|-X|--exec-batch)$/;
const PIPED_TO_RUNNER = /\|\s*(xargs|parallel|while|for|sh|bash|zsh|env)\b/;
const WRITE_VERB = /\b(POST|PATCH|PUT|DELETE)\b|(^|\s)(-X|--request)\b|method\s*[:=]|requests\.(post|patch|put|delete)\b|\.(post|patch|put|delete)\s*\(/i;

export const REASON =
  "tedy gate: the OpenProject token stays inside the kit's tracker scripts, and every tracker write goes through `openproject.mjs` (preview/apply, set, comment) so it gets the form check, lock, sidecar and read-back (pm/references/tracker-openproject.md). If the script lacks what you need, stop and tell the user; never write around it.";

function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

export function trackerHost(read = () => readFileSync(CONFIG_FILE, "utf8")) {
  try {
    return new URL(JSON.parse(read()).url).host;
  } catch {
    return null;
  }
}

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function bashPaths(command, cwd) {
  const paths = new Set();
  const searched = new Set();
  const piped = PIPED_TO_RUNNER.test(command);
  for (const { dir, tokens } of walkSegments(command, cwd)) {
    const name = basename(tokens[0] ?? "");
    const reader = RECURSIVE_READERS.has(name) || (LISTERS.has(name) && (piped || tokens.some((token) => EXEC_FLAG.test(token))));
    for (const token of tokens) {
      paths.add(resolve(dir, expandHome(token)));
      if (reader && !token.startsWith("-")) searched.add(resolve(dir, expandHome(token)));
      if (token.includes("=")) paths.add(resolve(dir, expandHome(token.slice(token.indexOf("=") + 1))));
    }
  }
  return { paths, searched };
}

const contains = (dir, path) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

function sameFile(path, config) {
  try {
    const [a, b] = [statSync(path), statSync(config)];
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function namesConfig(path, config) {
  const pattern = path.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, "*");
  if (!GLOB.test(pattern)) return real(path) === config || sameFile(path, config);
  try {
    return matchesGlob(config, pattern);
  } catch {
    return false;
  }
}

export function evaluate(toolInput, host, { configFile = CONFIG_FILE, cwd = process.cwd() } = {}) {
  const texts = strings(toolInput);
  if (texts.some((text) => TOKEN_FILE.some((pattern) => pattern.test(text)))) return REASON;
  if (host && texts.some((text) => text.includes(host) && WRITE_VERB.test(text))) return REASON;
  if (!existsSync(configFile)) return null;
  const config = real(configFile);
  const configDir = dirname(config);
  if (typeof toolInput?.command === "string") {
    const { paths, searched } = bashPaths(toolInput.command, cwd);
    if ([...paths].some((path) => namesConfig(path, config)) || [...searched].some((path) => contains(real(path), configDir))) return REASON;
  }
  for (const field of PATH_FIELDS) {
    if (typeof toolInput?.[field] !== "string") continue;
    const path = resolve(cwd, expandHome(toolInput[field]));
    if (namesConfig(path, config)) return REASON;
    const target = real(path);
    if (field === "path" && contains(target, configDir)) return REASON;
  }
  return null;
}

export function run() {
  const input = readHookInput({ askOnFailure: true });
  try {
    const reason = evaluate(input.tool_input, trackerHost(), { cwd: input.cwd ?? process.cwd() });
    if (reason) {
      logGate({ hook: "tracker-token-gate", decision: "deny", tool: input.tool_name, cwd: input.cwd });
      deny(reason);
    }
  } catch (error) {
    logGate({ hook: "tracker-token-gate", decision: "deny-on-error", error: error.message });
    deny(`tedy gate: could not check this call for the tracker token (${error.message}). ${REASON}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
