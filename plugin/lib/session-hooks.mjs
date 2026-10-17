import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listPending, reportsDir } from "./handoff.mjs";
import { waitingText } from "./pending.mjs";
import { currentTurn, gateSwitches, logGate, readHookInput, readTranscriptTail, toolUses } from "./hook-io.mjs";
import { loadConfig, profileDir } from "./profile.mjs";
import { resolveMap } from "./project-map.mjs";
import { listSessions, roleCard, sessionName } from "../gates/role-gate.mjs";

export const PROSE_QUESTION = /(\?\s*$)|(anh (muốn|chọn|có muốn|thấy sao|quyết)|em (làm|tiếp tục|tiến hành)[^.]{0,40}(không|ko)\b|được không|nhé\?)/i;

const HOOKS_FILE = fileURLToPath(new URL("../hooks/hooks.json", import.meta.url));

const NUDGE = "The last reply ended with a prose question. If it asks the user for a decision, call AskUserQuestion now with options drawn from what you found, the recommended option first. If it was not a decision, end the turn as it is.";

function visibleTail(text) {
  const withoutCode = text.replace(/```[\s\S]*?```/g, "");
  const withoutQuotes = withoutCode.split("\n").filter((line) => !/^\s*>/.test(line)).join("\n");
  return withoutQuotes.trim().slice(-300);
}

function lastAssistantText(turn) {
  for (let index = turn.length - 1; index >= 0; index -= 1) {
    const entry = turn[index];
    if (entry.type !== "assistant") continue;
    const texts = (entry.message?.content ?? []).filter((block) => block.type === "text");
    if (texts.length) return texts[texts.length - 1].text;
  }
  return "";
}

export function decideNudge(entries, stopHookActive, lastMessage) {
  if (stopHookActive) return { nudge: false, why: "stop-hook-active" };
  const turn = currentTurn(entries);
  const entrypoint = [...turn].reverse().find((entry) => entry.entrypoint)?.entrypoint;
  if (entrypoint && entrypoint !== "cli") return { nudge: false, why: `entrypoint-${entrypoint}` };
  if (toolUses(turn).some((use) => use.name === "AskUserQuestion")) return { nudge: false, why: "asked" };
  const tail = visibleTail(lastMessage ?? lastAssistantText(turn));
  if (!tail) return { nudge: false, why: "no-text" };
  return PROSE_QUESTION.test(tail) ? { nudge: true, why: "prose-question", tail: tail.slice(-120) } : { nudge: false, why: "no-question" };
}

export function activeRole(entries) {
  const roles = toolUses(entries)
    .filter((use) => use.name === "Skill" && typeof use.input?.skill === "string" && use.input.skill.startsWith("tedy:"))
    .map((use) => use.input.skill);
  return roles.length ? roles[roles.length - 1] : null;
}

function runDecisionNudge() {
  const input = readHookInput();
  try {
    const decision = decideNudge(readTranscriptTail(input.transcript_path), input.stop_hook_active === true, input.last_assistant_message);
    logGate({ hook: "decision-nudge", decision: decision.nudge ? "nudge" : "pass", why: decision.why, tail: decision.tail, session: input.session_id });
    if (decision.nudge) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: NUDGE } }));
  } catch (error) {
    logGate({ hook: "decision-nudge", decision: "pass-on-error", error: error.message });
  }
}

function sessionRoleCard(input) {
  try {
    const resolved = resolveMap(input.cwd ?? process.cwd());
    return resolved ? roleCard(resolved.map, sessionName(input.session_id, listSessions()), gateSwitches().roleGate) : "";
  } catch (error) {
    logGate({ hook: "role-card", decision: "skip-on-error", error: error.message });
    return "";
  }
}

function isHooksLoad(entry) {
  if (/^SessionStart:(startup|resume|fork)$/.test(entry.attachment?.hookName ?? "")) return true;
  return entry.type === "user" && typeof entry.message?.content === "string" && entry.message.content.trimStart().startsWith("<command-name>/reload-plugins</command-name>");
}

function parseEntry(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function hooksLoadedSince(path, changedMs, chunkSize = 1 << 20) {
  const descriptor = openSync(path, "r");
  try {
    let position = fstatSync(descriptor).size;
    let carry = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const buffer = Buffer.alloc(length);
      readSync(descriptor, buffer, 0, length, position);
      let data = Buffer.concat([buffer, carry]);
      if (position > 0) {
        const cut = data.indexOf(10);
        if (cut === -1) {
          carry = data;
          continue;
        }
        carry = data.subarray(0, cut);
        data = data.subarray(cut + 1);
      }
      const lines = data.toString("utf8").split("\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const entry = lines[index] && parseEntry(lines[index]);
        const at = Date.parse(entry?.timestamp ?? "");
        if (Number.isNaN(at)) continue;
        if (at < changedMs) return false;
        if (isHooksLoad(entry)) return true;
      }
    }
    return false;
  } finally {
    closeSync(descriptor);
  }
}

export function reloadHint(path, changedMs) {
  if (!path || !existsSync(path) || hooksLoadedSince(path, changedMs)) return "";
  return `This session last loaded the tedy hooks before hooks.json changed at ${new Date(changedMs).toISOString()}, so newer gates, such as the role gate, do not run here yet. Tell the user in this reply to run /reload-plugins in this session.`;
}

function runRoleReminder() {
  const input = readHookInput();
  try {
    const role = activeRole(readTranscriptTail(input.transcript_path, 4_000_000));
    const lines = [sessionRoleCard(input), role ? `Active role before compaction: /${role}. Its iron laws sit at the top of that skill; invoke /${role} again before the next request of the same kind.` : "", reloadHint(input.transcript_path, statSync(HOOKS_FILE).mtimeMs)].filter(Boolean);
    if (lines.length) process.stdout.write(lines.join("\n"));
  } catch (error) {
    logGate({ hook: "role-reminder", decision: "skip-on-error", error: error.message });
  }
}

export function configWarning(dir = profileDir()) {
  if (!existsSync(dir)) return "";
  if (!existsSync(join(dir, "config.json"))) {
    const state = existsSync(join(dir, "rules.md")) ? "on" : "off";
    return `tedy: the profile at ${dir} has no config.json, so every personal gate is ${state}. Run node <plugin>/scripts/profile.mjs doctor, and tell the user in this reply.`;
  }
  try {
    loadConfig(dir);
    return "";
  } catch (error) {
    return `tedy: ${error.message}. Until node <plugin>/scripts/profile.mjs doctor reports the config ok, every personal gate stays on. Tell the user in this reply.`;
  }
}

export function pendingNotice(pending, procedure) {
  if (!pending.length) return "";
  const lines = pending.map((item) => `- to ${item.to}: ${item.title} (from ${item.from}) ${item.path}`);
  return `Pending hand-offs in this project:\n${lines.join("\n")}\nIf one is addressed to this session (ListAgents prints this session's name), take it as described in ${procedure}; the others belong to their own sessions.`;
}

export function waitingNotice(map) {
  const text = waitingText(map, { offline: true, handoffs: false });
  return text && `Waiting on the user in this project (\`pending.mjs list\` adds draft PRs; \`pending.mjs done <file>\` archives a finished draft):\n${text}`;
}

function runPendingHandoffs() {
  const input = readHookInput();
  try {
    const resolved = resolveMap(input.cwd ?? process.cwd());
    const notice = [configWarning(), resolved && sessionRoleCard(input), resolved && pendingNotice(listPending(reportsDir(resolved.map)), fileURLToPath(new URL("../shared/handoff.md", import.meta.url))), resolved && waitingNotice(resolved.map)].filter(Boolean).join("\n\n");
    if (notice) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: notice } }));
  } catch (error) {
    logGate({ hook: "pending-handoffs", decision: "skip-on-error", error: error.message });
  }
}

export function run() {
  if (process.argv[2] === "decision-nudge") runDecisionNudge();
  if (process.argv[2] === "role-reminder") runRoleReminder();
  if (process.argv[2] === "pending-handoffs") runPendingHandoffs();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
