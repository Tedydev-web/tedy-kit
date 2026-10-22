import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { STATE_DIR, gateSwitches, logGate, readHookInput } from "./hook-io.mjs";
import { chatLanguage, labels } from "./labels.mjs";
import { tokenize } from "./shell-segments.mjs";

export const APPROVAL_TTL_MS = 30 * 60 * 1000;
const APPROVAL_KEYS = ["post.asIs", "approve.all"];

export const approvalsDir = (state = STATE_DIR) => join(state, "approvals");

export const approvalLabels = (lang = chatLanguage()) => APPROVAL_KEYS.map((key) => labels(lang)[key]);

function approvedPreviews(input, accepted) {
  const questions = Array.isArray(input?.tool_input?.questions) ? input.tool_input.questions : [];
  const answers = input?.tool_response?.answers;
  const annotations = input?.tool_response?.annotations ?? {};
  if (!answers || typeof answers !== "object") return [];
  return questions.flatMap((question) => {
    const text = question?.question;
    if (typeof text !== "string" || questions.filter((other) => other?.question === text).length !== 1) return [];
    const answer = answers[text];
    if (!accepted.includes(answer) || annotations[text]?.notes) return [];
    const chosen = (Array.isArray(question.options) ? question.options : []).filter((option) => option?.label === answer);
    return chosen.length === 1 && typeof chosen[0].preview === "string" && chosen[0].preview.trim() ? [chosen[0].preview] : [];
  });
}

export function recordApprovals(input, { dir = approvalsDir(), accepted = approvalLabels(), now = Date.now() } = {}) {
  const previews = approvedPreviews(input, accepted);
  if (!previews.length) return [];
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return previews.map((preview) => {
    const id = randomUUID();
    const file = join(dir, `${id}.json`);
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ created: now, session_id: input.session_id ?? null, tool_use_id: input.tool_use_id ?? null, preview })}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    return id;
  });
}

const contentLines = (text) =>
  String(text)
    .split("\n")
    .map((line) => line.replace(/^(\s*>)+/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);

function sameCommand(line, command) {
  const tokens = tokenize(line.trim().replace(/^\$\s+/, "").replace(/^`+|`+$/g, ""));
  if (tokens.length && basename(tokens[0]) === "node") tokens.shift();
  return tokens.length === command.length && basename(tokens[0] ?? "") === command[0] && tokens.slice(1).every((token, index) => token === command[index + 1]);
}

function holdsBlock(lines, block) {
  for (let start = 0; start + block.length <= lines.length; start += 1) if (block.every((line, offset) => lines[start + offset] === line)) return true;
  return false;
}

function removeIfThere(file) {
  try {
    unlinkSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function sweep(dir, now) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    let mtime;
    try {
      mtime = statSync(file).mtimeMs;
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (now - mtime > APPROVAL_TTL_MS) removeIfThere(file);
  }
}

export const refusal = (command) =>
  `publish approval is in answer mode and no unused approval matches this write. Nothing was written. Ask the user again with one AskUserQuestion whose approving option's preview holds the command line \`${command.join(" ")}\` (optionally after \`node\` and with the script's full path) on a line of its own, and every text it writes, verbatim, on whole lines. One approval covers one command, for ${APPROVAL_TTL_MS / 60_000} minutes.`;

export function consumeApproval(argv, texts = [], { dir = approvalsDir(), now = Date.now(), mode = gateSwitches().publishApproval } = {}) {
  if (mode !== "answer") return null;
  const command = [basename(argv[1] ?? ""), ...argv.slice(2)];
  const blocks = texts.map(contentLines).filter((block) => block.length);
  let names = [];
  try {
    sweep(dir, now);
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const candidates = names.flatMap((name) => {
    const file = join(dir, name);
    let ticket;
    try {
      ticket = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") logGate({ hook: "publish-approval-ticket", decision: "ticket-unreadable", file, error: error.message });
      return [];
    }
    if (typeof ticket?.preview !== "string" || !(now - ticket.created <= APPROVAL_TTL_MS && ticket.created <= now + 60_000)) {
      removeIfThere(file);
      return [];
    }
    const raw = ticket.preview.split("\n");
    const lines = contentLines(ticket.preview);
    return raw.some((line) => sameCommand(line, command)) && blocks.every((block) => holdsBlock(lines, block)) ? [{ file, ticket }] : [];
  });
  candidates.sort((a, b) => a.ticket.created - b.ticket.created);
  for (const { file, ticket } of candidates) {
    try {
      renameSync(file, `${file.slice(0, -".json".length)}.used`);
      return ticket;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error(refusal(command));
}

export function run() {
  const input = readHookInput();
  try {
    if (gateSwitches().publishApproval !== "answer") return;
    const ids = recordApprovals(input);
    if (ids.length) logGate({ hook: "publish-approval-ticket", decision: "ticket", tickets: ids.length, tool_use_id: input.tool_use_id });
    else logGate({ hook: "publish-approval-ticket", decision: "no-ticket", tool_use_id: input.tool_use_id, response_keys: Object.keys(input.tool_response ?? {}) });
  } catch (error) {
    logGate({ hook: "publish-approval-ticket", decision: "ticket-failed", error: error.message });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
