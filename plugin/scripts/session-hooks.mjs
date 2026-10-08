import { fileURLToPath, pathToFileURL } from "node:url";
import { listPending, reportsDir } from "./handoff.mjs";
import { currentTurn, logGate, readHookInput, readTranscriptTail, toolUses } from "./hook-io.mjs";
import { resolveMap } from "./project-map.mjs";

export const PROSE_QUESTION = /(\?\s*$)|(anh (muốn|chọn|có muốn|thấy sao|quyết)|em (làm|tiếp tục|tiến hành)[^.]{0,40}(không|ko)\b|được không|nhé\?)/i;

const NUDGE = "The last reply ended with a prose question. If it asks the user for a decision, call AskUserQuestion now with options drawn from what you found, the recommended option first (working-style rules 13–15). If it was not a decision, end the turn as it is.";

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

function runRoleReminder() {
  const input = readHookInput();
  try {
    const role = activeRole(readTranscriptTail(input.transcript_path, 4_000_000));
    if (role) process.stdout.write(`Active role before compaction: /${role}. Its iron laws sit at the top of that skill; invoke /${role} again before the next request of the same kind.`);
  } catch (error) {
    logGate({ hook: "role-reminder", decision: "skip-on-error", error: error.message });
  }
}

export function pendingNotice(pending, procedure) {
  if (!pending.length) return "";
  const lines = pending.map((item) => `- to ${item.to}: ${item.title} (from ${item.from}) ${item.path}`);
  return `Pending hand-offs in this project:\n${lines.join("\n")}\nIf one is addressed to this session (ListAgents prints this session's name), take it as described in ${procedure}; the others belong to their own sessions.`;
}

function runPendingHandoffs() {
  const input = readHookInput();
  try {
    const resolved = resolveMap(input.cwd ?? process.cwd());
    if (!resolved) return;
    const notice = pendingNotice(listPending(reportsDir(resolved.map)), fileURLToPath(new URL("../shared/handoff.md", import.meta.url)));
    if (notice) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: notice } }));
  } catch (error) {
    logGate({ hook: "pending-handoffs", decision: "skip-on-error", error: error.message });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "decision-nudge") runDecisionNudge();
  if (process.argv[2] === "role-reminder") runRoleReminder();
  if (process.argv[2] === "pending-handoffs") runPendingHandoffs();
}
