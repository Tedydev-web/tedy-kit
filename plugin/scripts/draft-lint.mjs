import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { STATE_DIR } from "./hook-io.mjs";
import { UC_ID } from "./prd-section.mjs";

export const MAX_BODY = 360;
export const MAX_CHAT = 600;
const HEADER = /^# PR #(\d+)(:| —) comment line by line \(head ([0-9a-f]{7,40})\)\s*$/m;
const SECTION = /^## (\d+)\. `([^`]+):(\d+)`\s*$/gm;
const PRD_HEADER = new RegExp(`^PRD EPIC \\d{2} · ${UC_ID.source} .+:$`);
const FOREIGN_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

export function parseDraft(text) {
  const header = text.match(HEADER);
  if (!header) throw new Error('draft has no "# PR #<n>: comment line by line (head <sha>)" header');
  const sections = [...text.matchAll(SECTION)];
  const comments = sections.map((section, position) => {
    const start = section.index + section[0].length;
    const end = position + 1 < sections.length ? sections[position + 1].index : text.length;
    const body = text.slice(start, end).replace(/\n---\s*$/, "").trim();
    return { index: Number(section[1]), path: section[2], line: Number(section[3]), body };
  });
  return { pr: Number(header[1]), separator: header[2], sha: header[3], comments };
}

export function diffLines(diffText) {
  const files = new Map();
  let current = null;
  let next = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "");
      current = path === "/dev/null" ? null : new Set();
      if (current) files.set(path, current);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (!current || line.startsWith("diff --git") || line.startsWith("--- ") || line.startsWith("\\")) continue;
    if (line.startsWith("+") || line.startsWith(" ")) {
      current.add(next);
      next += 1;
    }
  }
  return files;
}

function withoutSpans(text) {
  return text.replace(/`[^`]*`/g, "``").replace(/"[^"]*"/g, '""').replace(/“[^”]*”/g, '""');
}

export function lintComment(body) {
  const problems = [];
  const text = body.normalize("NFC");
  const [first, ...rest] = text.split("\n");
  if (text.includes("```")) problems.push("no code block in a comment");
  if (text.length > MAX_BODY) problems.push(`body is ${text.length} characters; keep it at or under ${MAX_BODY}`);
  if (!first.trimEnd().endsWith("ạ.")) problems.push('the first line must end with "ạ."');
  if (/[.!?]\s+\S/.test(withoutSpans(first.trim()).replace(/ạ\.$/, ""))) problems.push("the first line must be one sentence");
  if (/anh ơi|cảm ơn|thank/i.test(text)) problems.push('drop openers and fillers such as "Anh ơi" or "cảm ơn"');
  if (FOREIGN_SCRIPT.test(text.replace(/`[^`]*`/g, ""))) problems.push("non-Latin characters outside backticks");
  rest.forEach((line, offset) => {
    const previous = offset === 0 ? first : rest[offset - 1];
    if (!line.trim()) return;
    if (line.startsWith("PRD ")) {
      if (!PRD_HEADER.test(line)) problems.push(`PRD header must read "PRD EPIC <nn> · <UC> <locator>:", got "${line}"`);
      if (!rest[offset + 1]?.startsWith("> ")) problems.push(`"${line}" must be followed by a "> " quote line`);
      return;
    }
    if (line.startsWith("> ")) {
      if (!previous.startsWith("PRD ") && !previous.startsWith("> ")) problems.push('a "> " quote must sit right under its PRD header');
      return;
    }
    problems.push(`only a PRD block may follow the first sentence, got "${line}"`);
  });
  return problems;
}

export function lintChatComment(text, channel) {
  const problems = [];
  const body = text.normalize("NFC").trim();
  if (!body) return ["the comment is empty"];
  if (body.includes("```")) problems.push("no code block in a comment");
  if (body.length > MAX_CHAT) problems.push(`comment is ${body.length} characters; keep it at or under ${MAX_CHAT}`);
  if (/anh ơi|cảm ơn|thank/i.test(body)) problems.push('drop openers and fillers such as "Anh ơi" or "cảm ơn"');
  if (FOREIGN_SCRIPT.test(body.replace(/`[^`]*`/g, ""))) problems.push("non-Latin characters outside backticks");
  if (channel === "figma" && !/^@\S/.test(body)) problems.push("a Figma comment opens with the @handle of whoever owns the fix");
  if (channel === "doc" && /(^|\s)@\S/.test(body)) problems.push("a Doc comment tags nobody");
  return problems;
}

export function lintDraft(text, diffText) {
  const parsed = parseDraft(text);
  const problems = [];
  if (parsed.separator !== ":") problems.push({ index: 0, location: "header", problem: 'use the header "# PR #<n>: comment line by line (head <sha8>)"' });
  if (!parsed.comments.length) problems.push({ index: 0, location: "header", problem: "the draft has no comments" });
  const lines = diffText === undefined ? null : diffLines(diffText);
  for (const comment of parsed.comments) {
    const location = `${comment.path}:${comment.line}`;
    for (const problem of lintComment(comment.body)) problems.push({ index: comment.index, location, problem });
    if (!lines) continue;
    if (!lines.has(comment.path)) {
      const candidates = [...lines.keys()].filter((path) => path.endsWith(`/${comment.path}`));
      const hint = candidates.length === 1 ? `; use the full path ${candidates[0]}` : "";
      problems.push({ index: comment.index, location, problem: `${comment.path} is not in the PR diff${hint}` });
    } else if (!lines.get(comment.path).has(comment.line)) {
      problems.push({ index: comment.index, location, problem: `${location} is not in the PR diff; pick an added or context line of a hunk` });
    }
  }
  return { ...parsed, problems };
}

export function snapshotPath(file, dir = join(STATE_DIR, "drafts")) {
  return join(dir, resolve(file).replace(/\//g, "_"));
}

export function snapshotOnce(file, text, dir) {
  const path = snapshotPath(file, dir);
  if (existsSync(path)) return null;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

export function readDiff(pr, repo) {
  const args = ["pr", "diff", String(pr), ...(repo ? ["--repo", repo] : [])];
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function main([kind, file, ...flags]) {
  if ((kind === "doc-comment" || kind === "figma-comment") && file) {
    const problems = lintChatComment(readFileSync(file, "utf8"), kind.replace("-comment", ""));
    for (const problem of problems) console.log(problem);
    if (!problems.length) console.log(`clean: ${kind}`);
    return problems.length ? 1 : 0;
  }
  if (kind !== "pr-comment" || !file) {
    console.error("usage: draft-lint.mjs pr-comment <draft.md> [--diff <file>] [--repo <owner/repo>] | doc-comment <body.txt> | figma-comment <body.txt>");
    return 2;
  }
  const flag = (name) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined);
  const text = readFileSync(file, "utf8");
  const { pr } = parseDraft(text);
  const diffText = flag("--diff") ? readFileSync(flag("--diff"), "utf8") : readDiff(pr, flag("--repo"));
  const result = lintDraft(text, diffText);
  if (!result.problems.length) {
    console.log(`clean: ${result.comments.length} comments, PR #${result.pr}, head ${result.sha}`);
    const frozen = snapshotOnce(file, text);
    if (frozen) console.log(`original frozen for the edit log: ${frozen}`);
    return 0;
  }
  for (const item of result.problems) console.log(`${item.index}. ${item.location}: ${item.problem}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`draft-lint: ${error.message}`);
    process.exit(1);
  }
}
