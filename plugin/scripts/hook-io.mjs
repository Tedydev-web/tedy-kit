import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_DIR = process.env.TEDY_STATE_DIR ?? join(homedir(), ".local", "state", "tedy");

export function readHookInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

export function logGate(entry) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(join(STATE_DIR, "gate-log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch (error) {
    process.stderr.write(`tedy gate log failed: ${error.message}\n`);
  }
}

export function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
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
  return Array.isArray(content) && content.length > 0 && content.every((block) => block.type === "text");
}

export function currentTurn(entries) {
  let start = entries.length;
  while (start > 0 && !isUserPrompt(entries[start - 1])) start -= 1;
  return entries.slice(start);
}

export function toolUses(entries) {
  return entries.flatMap((entry) => (entry.type === "assistant" ? entry.message?.content ?? [] : []).filter((block) => block.type === "tool_use"));
}
