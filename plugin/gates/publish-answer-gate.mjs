import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { githubWriteDryRun, parseFlags } from "../lib/cli-flags.mjs";
import { parseDraft } from "../lib/draft-lint.mjs";
import { currentTurn, isUserPrompt } from "../lib/hook-io.mjs";
import { chatLanguage, labels } from "../lib/labels.mjs";
import { splitSegments, tokenize, walkParts } from "../lib/shell-segments.mjs";
import { publishes } from "./git-gate.mjs";
import { normalise, transcriptUntil } from "./publish-quote-gate.mjs";

const SCRIPT = /^(github-write|openproject|figma-comments|gdoc-comments|doc-comment-file)\.mjs$/;
const APPROVAL_KEYS = ["post.asIs", "approve.all"];
const ALONE = "tedy gate: publish approval is in answer mode, so a publish runs as a plain `node <script> …` command of its own, with at most a `cd` before it, and the approval covers exactly what runs. Run the publish alone, and anything else in a separate command.";
const NO_TRANSCRIPT = "tedy gate: publish approval is in answer mode and this session's transcript cannot be read, so the user's approval of this publish cannot be checked. It is refused; publish from the main session.";

export const approvalLabels = (lang = chatLanguage()) => APPROVAL_KEYS.map((key) => labels(lang)[key]);

function scriptCall(segment) {
  const tokens = tokenize(segment);
  const at = tokens.findIndex((token) => SCRIPT.test(basename(token)));
  if (at === -1) return null;
  const { positional, flags } = parseFlags(tokens.slice(at + 1));
  return { script: basename(tokens[at], ".mjs"), name: positional[0], target: positional[1], flags };
}

const dryRun = (segment) => {
  const call = scriptCall(segment);
  return call?.script === "github-write" && githubWriteDryRun(call.name, call.flags);
};

export function needs(segment, dir, read) {
  const command = { label: `the command \`${segment}\``, text: segment };
  if (dryRun(segment)) return null;
  const call = scriptCall(segment);
  if (!call) return { files: [], texts: [command] };
  const { script, name, target, flags } = call;
  const files = [];
  const load = (path) => {
    const file = resolve(dir, path);
    files.push(file);
    return { file, text: read(file) };
  };
  const texts = [];
  if (script === "github-write" && name === "post") {
    const { file, text } = load(target);
    texts.push(...parseDraft(text).comments.map((comment) => ({ label: `comment ${comment.index} of ${file}`, text: comment.body })));
  } else if (script === "doc-comment-file" && name === "post") {
    const { file, text } = load(target);
    texts.push(...JSON.parse(text).items.filter((item) => !item.posted).map((item, index) => ({ label: `comment ${index + 1} of ${file}`, text: item.comment.trim() })));
  } else if (script === "openproject" && name === "apply") {
    const { file, text } = load(target);
    texts.push(...JSON.parse(text).flatMap((draft, index) => ["subject", "description"].filter((key) => typeof draft[key] === "string").map((key) => ({ label: `the ${key} of draft ${index + 1} of ${file}`, text: draft[key] }))));
  }
  if (flags["body-file"] !== undefined) {
    const { file, text } = load(flags["body-file"]);
    texts.push({ label: `the body of ${file}`, text });
  } else if (typeof flags.body === "string") {
    texts.push({ label: "the --body text", text: flags.body });
  }
  return { files, texts: [...texts.filter(({ text }) => normalise(text)), command] };
}

const blocks = (entry) => (Array.isArray(entry.message?.content) ? entry.message.content : []);
const resultText = (block) => (typeof block.content === "string" ? block.content : (Array.isArray(block.content) ? block.content : []).map((part) => part?.text ?? "").join(""));
const HOOK_REFUSAL = /^PreToolUse:\S+ hook error:/;

export function lastPublishRun(entries) {
  const calls = new Map();
  let last = -Infinity;
  for (const entry of entries) {
    for (const block of blocks(entry)) {
      if (entry.type === "assistant" && block.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string" && splitSegments(block.input.command, false).some((segment) => publishes(segment) && !dryRun(segment))) calls.set(block.id, Date.parse(entry.timestamp ?? ""));
      if (entry.type === "user" && block.type === "tool_result" && calls.has(block.tool_use_id) && !HOOK_REFUSAL.test(resultText(block))) last = Math.max(last, calls.get(block.tool_use_id));
    }
  }
  return last;
}

export function approvals(entries, accepted) {
  const asked = new Map();
  const found = [];
  for (const entry of entries) {
    for (const block of blocks(entry)) {
      if (entry.type === "assistant" && block.type === "tool_use" && block.name === "AskUserQuestion") asked.set(block.id, { at: Date.parse(entry.timestamp ?? ""), input: block.input });
      if (entry.type !== "user" || block.type !== "tool_result" || !asked.has(block.tool_use_id)) continue;
      const { at, input } = asked.get(block.tool_use_id);
      const answers = entry.toolUseResult?.answers ?? {};
      const annotations = entry.toolUseResult?.annotations ?? {};
      for (const question of Array.isArray(input?.questions) ? input.questions : []) {
        const answer = answers[question.question];
        if (!accepted.includes(answer) || annotations[question.question]?.notes) continue;
        const option = (Array.isArray(question.options) ? question.options : []).find((item) => item.label === answer);
        if (typeof option?.preview === "string") found.push({ at, preview: normalise(option.preview) });
      }
    }
  }
  return found;
}

const reasonFor = (missing, [asIs, all]) =>
  `tedy gate: publish approval is in answer mode, so a publish runs only after the user picks "${asIs}" or "${all}" in an AskUserQuestion asked in this turn after the draft's last change and after the previous publish ran, on the option whose preview holds, verbatim and together: ${missing.join("; ")}. Another answer, a typed answer, an answer with a note, or no answer before the timeout is not an approval, and one approval covers only the next publish command. Ask that question now with every body and the exact command line in that option's preview, then run the publish again.`;

export function check(input, accepted = approvalLabels()) {
  const command = input.tool_input?.command ?? "";
  const parts = [...walkParts(command, input.cwd ?? process.cwd(), false)];
  const read = (file) => readFileSync(file, "utf8");
  const publishing = parts.filter((part) => publishes(part.text) && !dryRun(part.text));
  if (!publishing.length) return null;
  if (parts.some((part) => !part.changesDir && !publishes(part.text))) return { allow: false, reason: ALONE };
  if (!input.transcript_path) return { allow: false, reason: NO_TRANSCRIPT };
  const wanted = publishing.map((part) => needs(part.text, part.dir, read));
  const turn = currentTurn(transcriptUntil(input.transcript_path, (tail) => tail.some(isUserPrompt)));
  const after = lastPublishRun(turn);
  const approved = approvals(turn, accepted).filter((item) => item.at > after);
  const missing = wanted.flatMap(({ files, texts }) => {
    const since = Math.max(0, ...files.map((file) => statSync(file).mtimeMs));
    const previews = approved.filter((item) => item.at >= since).map((item) => item.preview);
    const lacks = (preview) => texts.filter(({ text }) => !preview.includes(normalise(text)));
    if (previews.some((preview) => !lacks(preview).length)) return [];
    return (previews.length ? lacks(previews.at(-1)) : texts).map(({ label }) => label);
  });
  return missing.length ? { allow: false, reason: reasonFor(missing, accepted) } : { allow: true };
}
