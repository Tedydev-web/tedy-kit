import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { STATE_DIR, logGate, readHookInput } from "./hook-io.mjs";
import { chatLanguage, labels } from "./labels.mjs";

export const runApprovalsDir = (state = STATE_DIR) => join(state, "review-runs");
const HEAD_SHA = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/g;
const RUN_SCOPES = { "run.lint": "lint", "run.all": "all" };

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
    return chosen.length === 1 ? [{ question, text, answer }] : [];
  });
}

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

export function run() {
  const input = readHookInput();
  try {
    const heads = recordRunApprovals(input);
    if (heads.length) logGate({ hook: "review-run-approval", decision: "approved", heads, tool_use_id: input.tool_use_id });
  } catch (error) {
    logGate({ hook: "review-run-approval", decision: "record-failed", error: error.message });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
