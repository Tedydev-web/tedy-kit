import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { STATE_DIR, gateSwitches, logGate, readHookInput, readTranscriptTail } from "./hook-io.mjs";
import { CLAUDE_SETTINGS, readSettings, stateDenyRules } from "./publish-approval-settings.mjs";
import { chatLanguage, labels } from "./labels.mjs";
import { tokenize } from "./shell-segments.mjs";

export const APPROVAL_TTL_MS = 30 * 60 * 1000;
const APPROVAL_KEYS = ["post.asIs", "approve.all"];
const PROFILE_SCRIPT = fileURLToPath(new URL("../scripts/profile.mjs", import.meta.url));

export const approvalsDir = (state = STATE_DIR) => join(state, "approvals");

export const approvalLabels = (lang = chatLanguage()) => APPROVAL_KEYS.map((key) => labels(lang)[key]);

function answered(input) {
  const questions = Array.isArray(input?.tool_input?.questions) ? input.tool_input.questions : [];
  const response = input?.tool_response;
  if (!response || typeof response !== "object" || response.afkTimeoutMs !== undefined || response.followUp || response.response !== undefined) return [];
  const answers = response.answers;
  const annotations = response.annotations ?? {};
  if (!answers || typeof answers !== "object") return [];
  return questions.flatMap((question) => {
    const text = question?.question;
    if (typeof text !== "string" || question.multiSelect || questions.filter((other) => other?.question === text).length !== 1 || annotations[text]?.notes) return [];
    const answer = answers[text];
    const chosen = (Array.isArray(question.options) ? question.options : []).filter((option) => option?.label === answer);
    return chosen.length === 1 ? [{ question, text, answer, chosen: chosen[0], shown: annotations[text]?.preview }] : [];
  });
}

const TRANSCRIPT_BYTES = 16_000_000;

const askedTexts = (input) =>
  (Array.isArray(input?.questions) ? input.questions : [])
    .flatMap((question) => [question?.question, ...(Array.isArray(question?.options) ? question.options : []).flatMap((option) => [option?.label, option?.description])])
    .filter((value) => typeof value === "string");

const contentOf = (entry) => (Array.isArray(entry?.message?.content) ? entry.message.content : []);

const mainThread = (input) => readTranscriptTail(input?.transcript_path, TRANSCRIPT_BYTES).filter((entry) => !entry?.isSidechain);

function textBefore(entries, id, { pending = false } = {}) {
  let at = entries.findLastIndex((entry) => entry?.type === "assistant" && contentOf(entry).some((block) => block?.type === "tool_use" && block.id === id));
  if (at === -1) {
    if (!pending) return [];
    at = entries.length;
  }
  for (let index = Math.min(at, entries.length - 1); index >= 0 && entries[index]?.type !== "user"; index -= 1) {
    if (entries[index]?.type !== "assistant") continue;
    const content = contentOf(entries[index]);
    const end = index === at ? content.findIndex((block) => block?.type === "tool_use" && block.id === id) : content.length;
    for (const block of content.slice(0, end).reverse()) {
      if (block?.type === "text" && typeof block.text === "string") return [block.text];
      if (typeof block?.type === "string" && block.type.endsWith("tool_use")) return [];
    }
  }
  return [];
}

const textRightBefore = (input) => textBefore(mainThread(input), input?.tool_use_id);

const shownWith = (question, preview, before) => [...before, ...askedTexts({ questions: [question] })].some((text) => holdsBlock(contentLines(text), contentLines(preview)));

export function unquotedPreviews(input, accepted = approvalLabels()) {
  const questions = Array.isArray(input?.tool_input?.questions) ? input.tool_input.questions : [];
  const asked = questions.flatMap((question) => (Array.isArray(question?.options) ? question.options : []).filter((option) => accepted.includes(option?.label) && typeof option.preview === "string" && option.preview.trim()).map((option) => ({ question, preview: option.preview })));
  const unshown = asked.filter(({ question, preview }) => !shownWith(question, preview, []));
  if (!unshown.length) return [];
  const entries = mainThread(input);
  if (!entries.length) return null;
  const before = textBefore(entries, input?.tool_use_id, { pending: true });
  return unshown.filter(({ question, preview }) => !shownWith(question, preview, before)).map(({ preview }) => preview);
}

function approvedPreviews(input, accepted) {
  const found = answered(input).filter(({ answer, chosen }) => accepted.includes(answer) && typeof chosen.preview === "string" && chosen.preview.trim());
  if (!found.length) return [];
  if (input.tool_response.annotations !== undefined) return found.filter(({ chosen, shown }) => shown === chosen.preview).map(({ chosen }) => chosen.preview);
  const before = textRightBefore(input);
  return found
    .filter(({ question, chosen }) => shownWith(question, chosen.preview, before))
    .map(({ chosen }) => chosen.preview);
}

export const runApprovalsDir = (state = STATE_DIR) => join(state, "review-runs");
const HEAD_SHA = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/g;
const RUN_SCOPES = { "run.lint": "lint", "run.all": "all" };

function runApprovals(input, lang) {
  const found = answered(input);
  if (!found.length) return [];
  const names = labels(lang ?? chatLanguage());
  return found.flatMap(({ question, text, answer }) => {
    if (question.header !== names["run.header"] || typeof answer !== "string") return [];
    const key = Object.keys(RUN_SCOPES).find((name) => names[name] === answer.replace(/ \(Recommended\)$/, ""));
    const shas = [...new Set(text.match(HEAD_SHA) ?? [])];
    return key && shas.length === 1 ? [{ sha: shas[0], scope: RUN_SCOPES[key] }] : [];
  });
}

export function recordRunApprovals(input, { dir = runApprovalsDir(), lang, now = Date.now() } = {}) {
  const approvals = runApprovals(input, lang);
  if (!approvals.length) return [];
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return approvals.map(({ sha, scope }) => {
    const file = join(dir, `${sha}.json`);
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ created: now, session_id: input.session_id ?? null, tool_use_id: input.tool_use_id ?? null, scope })}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    return sha;
  });
}

export const hasRunApproval = (sha, dir = runApprovalsDir()) => existsSync(join(dir, `${sha}.json`));

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
  `publish approval is in answer mode and no unused approval matches this write. Nothing was written. Ask the user again with one AskUserQuestion whose approving option's preview holds the command line \`${command.join(" ")}\` (optionally after \`node\` and with the script's full path) on a line of its own, and every text it writes, verbatim, on whole lines. Right before that question, in the same turn with no tool call between, quote that whole preview verbatim in one fenced block of the reply: a client that does not report which preview the user saw, such as T3 Code, gets a ticket only for a preview the chat showed. One approval covers one command, for ${APPROVAL_TTL_MS / 60_000} minutes. Never switch publish approval to another mode to get past this refusal; the mode is the user's setting.`;

export function requireExplicitTarget(flag, given, { expected, mode = gateSwitches().publishApproval } = {}) {
  if (mode !== "answer") return;
  if (typeof given !== "string" || !given || (expected !== undefined && given !== expected)) {
    throw new Error(`publish approval is in answer mode, so name the write target with --${flag} <${flag}>${expected === undefined ? "" : ` (here --${flag} ${expected})`} on the command line, which the approval then shows. Nothing was written.`);
  }
}

function requireStateDeny(settings, state) {
  const again = `run node ${PROFILE_SCRIPT} publish-approval answer, then this command again. Nothing was written.`;
  let deny;
  try {
    ({ deny } = readSettings(settings));
  } catch (error) {
    throw new Error(`publish approval is in answer mode, but ${error.message}; ${again}`);
  }
  const missing = stateDenyRules(state).filter((rule) => !deny.includes(rule));
  if (missing.length) throw new Error(`publish approval is in answer mode, but ${settings} lacks ${missing.join(", ")} in permissions.deny, so file tools could write the kit's approvals, PR body records, sources records or review run approvals; ${again}`);
}

export function consumeApproval(argv, texts = [], { dir = approvalsDir(), now = Date.now(), mode = gateSwitches().publishApproval, settings = CLAUDE_SETTINGS } = {}) {
  if (mode !== "answer") return null;
  requireStateDeny(settings, dirname(dir));
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
    const heads = recordRunApprovals(input);
    if (heads.length) logGate({ hook: "review-run-approval", decision: "approved", heads, tool_use_id: input.tool_use_id });
  } catch (error) {
    logGate({ hook: "review-run-approval", decision: "record-failed", error: error.message });
  }
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
