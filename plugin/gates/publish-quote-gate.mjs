import { closeSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { githubWriteDryRun, parseFlags } from "../lib/cli-flags.mjs";
import { parseDraft } from "../lib/draft-lint.mjs";
import { classify, dataOnlyCommand, kitScriptCall, splitSegments, tokenize } from "./git-gate.mjs";
import { readTranscriptTail } from "../lib/hook-io.mjs";

const SCRIPT = /github-write\.mjs$/;
const PUBLISH_COMMANDS = new Set(["post", "reply", "edit"]);

const normalise = (text) =>
  text
    .split("\n")
    .map((line) => line.replace(/^\s*>\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

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
      .flatMap((block) => (block.type === "text" ? [block.text] : block.type === "tool_use" && block.name === "AskUserQuestion" ? strings(block.input) : []))
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
  `tedy gate: the user has not seen the exact text being published under their name since its last change (${missing.join(", ")}). Only two places count as shown: a text block in the reply, and an AskUserQuestion question or preview. Thinking does not count, and neither does Write or Bash input or any other tool's input. Put the whole body, verbatim, in the AskUserQuestion preview of the approval question, then post.`;

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

export function check(input) {
  const command = input.tool_input?.command ?? "";
  if (!/github-write\.mjs/.test(command)) return null;
  const read = (file) => readFileSync(file, "utf8");
  const found = publishes(command, input.cwd ?? process.cwd(), read);
  if (!found.length) return null;
  if (!input.transcript_path) return { ask: true, reason: "tedy gate: cannot read this session's transcript to confirm the user saw the exact draft; allow only if they did." };
  const mtime = (file) => statSync(file).mtimeMs;
  const since = Math.min(...found.map(({ file }) => (file ? mtime(file) : 0)));
  const missing = unshown(found, transcriptSince(input.transcript_path, since), mtime);
  return missing.length ? { ask: false, reason: reasonFor(missing) } : null;
}
