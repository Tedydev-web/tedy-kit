import { closeSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseDraft } from "./draft-lint.mjs";
import { classify, splitSegments, tokenize } from "./git-gate.mjs";
import { readTranscriptTail } from "./hook-io.mjs";

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
  for (const segment of splitSegments(command)) {
    const action = classify(segment, dir);
    if (action.kind === "cd") {
      dir = action.dir;
      continue;
    }
    const tokens = tokenize(segment);
    const at = tokens.findIndex((token) => SCRIPT.test(token));
    if (at === -1) continue;
    const [name, ...rest] = tokens.slice(at + 1);
    if (!PUBLISH_COMMANDS.has(name) || rest.includes("--dry-run")) continue;
    const flag = (key) => {
      const index = rest.indexOf(key);
      return index === -1 ? undefined : rest[index + 1];
    };
    if (name === "post") {
      const file = resolve(dir, rest[0]);
      found.push({ file, bodies: parseDraft(read(file)).comments.map((comment) => ({ label: `comment ${comment.index}`, text: comment.body })) });
      continue;
    }
    const bodyFile = flag("--body-file");
    if (bodyFile) {
      const file = resolve(dir, bodyFile);
      found.push({ file, bodies: [{ label: `${name} body`, text: read(file) }] });
      continue;
    }
    const body = flag("--body");
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
  `tedy gate: the user has not seen the exact text being published under their name since its last change (${missing.join(", ")}). Quote the whole draft, verbatim, in a reply, then ask the approval question, then post.`;

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
