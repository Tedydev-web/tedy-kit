import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deny, logGate, readHookInput } from "./hook-io.mjs";

const TOKEN_FILE = [/\.config\/op\/config\.json/, /["']op["']\s*[,/+]\s*["']config\.json["']/];
const WRITE_VERB = /\b(POST|PATCH|PUT|DELETE)\b|(^|\s)(-X|--request)\b|method\s*[:=]|requests\.(post|patch|put|delete)\b|\.(post|patch|put|delete)\s*\(/i;

export const REASON =
  "tedy gate: the OpenProject token stays inside the kit's tracker scripts, and every tracker write goes through `openproject.mjs` (preview/apply, set, comment) so it gets the form check, lock, sidecar and read-back (pm/references/tracker-openproject.md). If the script lacks what you need, stop and tell the user; never write around it.";

function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

export function trackerHost(read = () => readFileSync(join(homedir(), ".config", "op", "config.json"), "utf8")) {
  try {
    return new URL(JSON.parse(read()).url).host;
  } catch {
    return null;
  }
}

export function evaluate(toolInput, host) {
  const texts = strings(toolInput);
  if (texts.some((text) => TOKEN_FILE.some((pattern) => pattern.test(text)))) return REASON;
  if (host && texts.some((text) => text.includes(host) && WRITE_VERB.test(text))) return REASON;
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = readHookInput();
  try {
    const reason = evaluate(input.tool_input, trackerHost());
    if (reason) {
      logGate({ hook: "tracker-token-gate", decision: "deny", tool: input.tool_name, cwd: input.cwd });
      deny(reason);
    }
  } catch (error) {
    logGate({ hook: "tracker-token-gate", decision: "allow-on-error", error: error.message });
  }
}
