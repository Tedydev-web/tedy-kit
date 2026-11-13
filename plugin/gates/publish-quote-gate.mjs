import { closeSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { githubWriteDryRun, parseFlags } from "../lib/cli-flags.mjs";
import { parseDraft } from "../lib/draft-lint.mjs";
import { classify, dataOnlyCommand, kitScriptCall, splitSegments, tokenize } from "./git-gate.mjs";
import { readTranscriptTail } from "../lib/hook-io.mjs";
import { itemCommand, readBatch } from "../lib/publish-batch.mjs";

const SCRIPT = /github-write\.mjs$/;
const PUBLISH_COMMANDS = new Set(["post", "reply", "edit"]);

const normalise = (text) =>
  text
    .split("\n")
    .map((line) => line.replace(/^\s*>\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

export function publishes(command, cwd, read) {
  const found = [];
  let dir = cwd;
  const data = dataOnlyCommand(command);
  for (const segment of splitSegments(command)) {
    const action = classify(segment, dir);
    if (action.kind === "cd") {
      dir = action.dir;
      continue;
    }
    const tokens = tokenize(segment);
    const at = tokens.findIndex((token) => SCRIPT.test(token));
    const words = kitScriptCall(segment)?.words ?? (!data && at !== -1 ? tokens.slice(at) : null);
    if (words?.[0] === "publish-batch.mjs" && words[1]) {
      for (const item of readBatch(resolve(dir, words[1]))) found.push(...publishes(itemCommand(item), dir, read));
      continue;
    }
    if (!words || !SCRIPT.test(words[0])) continue;
    const { positional, flags } = parseFlags(words.slice(1));
    const [name] = positional;
    if (!PUBLISH_COMMANDS.has(name) || githubWriteDryRun(name, flags)) continue;
    if (name === "post") {
      const file = resolve(dir, positional[1]);
      found.push({ file, bodies: parseDraft(read(file)).comments.map((comment) => ({ label: `comment ${comment.index}`, text: comment.body })) });
      continue;
    }
    const bodyFile = flags["body-file"];
    if (bodyFile) {
      const file = resolve(dir, bodyFile);
      found.push({ file, bodies: [{ label: `${name} body`, text: read(file) }] });
      continue;
    }
    const body = flags.body;
    if (body !== undefined) found.push({ file: null, bodies: [{ label: `${name} body`, text: body }] });
  }
  return found;
}

export function shownSince(entries, sinceMs) {
  return normalise(
    entries
      .filter((entry) => entry.type === "assistant" && Date.parse(entry.timestamp ?? "") >= sinceMs)
      .flatMap((entry) => entry.message?.content ?? [])
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n"),
  );
}

export function unshown(found, entries, mtime) {
  return found.flatMap(({ file, bodies }) => {
    const shown = shownSince(entries, file ? mtime(file) : 0);
    return bodies.filter((body) => normalise(body.text) && !shown.includes(normalise(body.text))).map((body) => `${body.label}${file ? ` of ${file}` : ""}`);
  });
}

export const reasonFor = (missing) =>
  `tedy gate (publishQuote): refused, nothing was written. The user has not seen the exact text being published under their name since its last change; missing from the chat: ${missing.join(", ")}. Only a text block of the reply counts as shown; thinking, AskUserQuestion and every tool's input do not. Quote the whole body verbatim in one fenced block of the reply, with the lint's pinned:, warning: and notice: lines and the command, then run the command; its permission prompt is the approval.`;

function transcriptSince(path, sinceMs) {
  let size = 0;
  try {
    const descriptor = openSync(path, "r");
    size = fstatSync(descriptor).size;
    closeSync(descriptor);
  } catch {
    return [];
  }
  for (let bytes = 2_000_000; ; bytes *= 4) {
    const entries = readTranscriptTail(path, bytes);
    const oldest = Date.parse(entries.find((entry) => entry.timestamp)?.timestamp ?? "");
    if (bytes >= size || bytes >= 256_000_000 || oldest < sinceMs) return entries;
  }
}

function mainTranscript({ transcript_path: path, agent_id: agent }) {
  if (!agent || typeof path !== "string") return path;
  if (!/^agent-.*\.jsonl$/.test(basename(path))) return path;
  const subagents = dirname(path);
  if (basename(subagents) !== "subagents") return null;
  const session = dirname(subagents);
  return join(dirname(session), `${basename(session)}.jsonl`);
}

export function check(input) {
  const command = input.tool_input?.command ?? "";
  if (!/github-write\.mjs|publish-batch\.mjs/.test(command)) return null;
  const read = (file) => readFileSync(file, "utf8");
  const found = publishes(command, input.cwd ?? process.cwd(), read);
  if (!found.length) return null;
  const transcript = mainTranscript(input);
  if (!transcript) return { ask: true, reason: "tedy gate: cannot read this session's transcript to confirm the user saw the exact draft; allow only if they did." };
  const mtime = (file) => statSync(file).mtimeMs;
  const since = Math.min(...found.map(({ file }) => (file ? mtime(file) : 0)));
  const missing = unshown(found, transcriptSince(transcript, since), mtime);
  return missing.length ? { ask: false, reason: reasonFor(missing) } : null;
}
