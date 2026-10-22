import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { redact } from "./api-request.mjs";
import { loadConfig, profileDir } from "./profile.mjs";

export const STATE_DIR = process.env.TEDY_STATE_DIR ?? join(homedir(), ".local", "state", "tedy");

export function readHookInput({ askOnFailure = false } = {}) {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    logGate({ hook: basename(process.argv[1] ?? "", ".mjs"), decision: "hook-input-unreadable" });
    if (askOnFailure) {
      ask("tedy gate: could not read this tool call, so it was not checked. Allow it only if the user asked for it.");
      process.exit(0);
    }
    return {};
  }
}

export function logGate(entry) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const fields = Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, typeof value === "string" ? redact(value) : value]));
    appendFileSync(join(STATE_DIR, "gate-log.jsonl"), JSON.stringify({ at: new Date().toISOString(), root: process.env.CLAUDE_PLUGIN_ROOT, ...fields }) + "\n");
  } catch (error) {
    process.stderr.write(`tedy gate log failed: ${error.message}\n`);
  }
}

export const ALL_GATES_ON = Object.freeze({ noComments: true, draftPrOnly: true, roleGate: true, ghWrites: true, publishQuote: true, publishApproval: "ask", pushExempt: Object.freeze([]) });

export function gateSwitches() {
  try {
    const dir = profileDir();
    if (!existsSync(join(dir, "config.json")) && existsSync(join(dir, "rules.md"))) return ALL_GATES_ON;
    return loadConfig(dir).gates;
  } catch (error) {
    logGate({ hook: "profile-config", decision: "invalid-gates-on", error: error.message });
    return ALL_GATES_ON;
  }
}

export function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}

export function ask(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } }));
}

export function readTranscriptTail(path, bytes = 1_500_000) {
  if (!path) return [];
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (length < size) lines.shift();
    return lines.flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function isUserPrompt(entry) {
  if (entry?.type !== "user" || entry.isMeta) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.some((block) => block?.type === "text") && !content.some((block) => block?.type === "tool_result");
}

export function currentTurn(entries) {
  let start = entries.length;
  while (start > 0 && !isUserPrompt(entries[start - 1])) start -= 1;
  return entries.slice(start);
}

export function toolUses(entries) {
  return entries.flatMap((entry) => (entry.type === "assistant" ? entry.message?.content ?? [] : []).filter((block) => block.type === "tool_use"));
}
