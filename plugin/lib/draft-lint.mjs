import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { STATE_DIR } from "./hook-io.mjs";
import { UC_ID } from "./prd-section.mjs";
import { chatLanguage } from "./labels.mjs";
import { resolveMap } from "./project-map.mjs";
import { cites, describePin, mapRepos, pinRepos, takePin, writeSources } from "./source-pins.mjs";

export const MAX_BODY = 360;
export const MAX_CHAT = 600;
const HEADER = /^# PR #(\d+)(:| —) comment line by line \(head ([0-9a-f]{7,40})\)\s*$/m;
const SECTION = /^## (\d+)\. `([^`]+):(\d+)`\s*$/gm;
const PRD_HEADER = new RegExp(`^PRD EPIC \\d{2} · ${UC_ID.source} .+:$`);
const FOREIGN_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
const COMMENT_RULES = {
  vi: { ending: "ạ.", fillers: /anh ơi|cảm ơn|thank/i, fillerHint: 'drop openers and fillers such as "Anh ơi" or "cảm ơn"', userSees: 'vd "app hiện đang theo Figma"' },
  en: { ending: ".", fillers: /^\W*(hi|hey|hello)\b|\bthanks?\b|thank you/i, fillerHint: 'drop openers and fillers such as "Hi" or "thanks"', userSees: 'e.g. "the app follows Figma today"' },
};

export function commentRules(lang) {
  const rules = COMMENT_RULES[lang];
  if (!rules) throw new Error(`no comment rules for language "${lang}"; supported: ${Object.keys(COMMENT_RULES).join(", ")}`);
  return rules;
}

const DEV_WORDS = /(?<![\p{L}\d_])(BE|FE|backend|frontend|API|endpoint|schema|DB|database|Mongo|payload|relay|worker|cron|webhook|commit|merge|deploy|PR|on-chain|smart contract|contract(?! address)|v\d+)(?![\p{L}\d_])/giu;
const LOCATOR = /\b(?:step \d+|BR\d+[a-z]?|AF\d+|EF\d+|Description|Precondition|Postcondition)\b/g;
const MAX_LOCATORS = 3;

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

export function lintComment(body, lang) {
  const rules = commentRules(lang);
  const problems = [];
  const text = body.normalize("NFC");
  const [first, ...rest] = text.split("\n");
  if (text.includes("```")) problems.push("no code block in a comment");
  if (text.length > MAX_BODY) problems.push(`body is ${text.length} characters; keep it at or under ${MAX_BODY}`);
  if (!first.trimEnd().endsWith(rules.ending)) problems.push(`the first line must end with "${rules.ending}"`);
  if (/[.!?]\s+\S/.test(withoutSpans(first.trim()).slice(0, -rules.ending.length))) problems.push("the first line must be one sentence");
  if (rules.fillers.test(text)) problems.push(rules.fillerHint);
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

export function lintChatComment(text, channel, lang) {
  const rules = commentRules(lang);
  const problems = [];
  const body = text.normalize("NFC").trim();
  if (!body) return ["the comment is empty"];
  if (body.includes("```")) problems.push("no code block in a comment");
  if (body.length > MAX_CHAT) problems.push(`comment is ${body.length} characters; keep it at or under ${MAX_CHAT}`);
  if (rules.fillers.test(body)) problems.push(rules.fillerHint);
  if (FOREIGN_SCRIPT.test(body.replace(/`[^`]*`/g, ""))) problems.push("non-Latin characters outside backticks");
  if (channel === "figma" && !/^@\S/.test(body)) problems.push("a Figma comment opens with the @handle of whoever owns the fix");
  if (channel === "doc" && /(^|\s)@\S/.test(body)) problems.push("a Doc comment tags nobody");
  const prose = body.replace(/"[^"]*"|“[^”]*”/g, "");
  const devWords = [...new Set([...prose.matchAll(DEV_WORDS)].map((match) => match[0]))];
  if (devWords.length) problems.push(`the PM and designer read business rules, not how it is built: say what the app user sees instead of ${devWords.map((word) => `"${word}"`).join(", ")} (${rules.userSees}), and keep the technical reason in the item's note`);
  const locators = prose.match(LOCATOR) ?? [];
  if (locators.length > MAX_LOCATORS) problems.push(`${locators.length} PRD places in one comment; one comment asks for one change, so split it (at most ${MAX_LOCATORS} places)`);
  if (/[→↔⇒]/.test(prose)) problems.push("write arrows out in words; a PM reads → and ↔ as code");
  return problems;
}

export function lintDraft(text, diffText, lang) {
  const parsed = parseDraft(text);
  const problems = [];
  if (parsed.separator !== ":") problems.push({ index: 0, location: "header", problem: 'use the header "# PR #<n>: comment line by line (head <sha8>)"' });
  if (!parsed.comments.length) problems.push({ index: 0, location: "header", problem: "the draft has no comments" });
  const lines = diffText === undefined ? null : diffLines(diffText);
  for (const comment of parsed.comments) {
    const location = `${comment.path}:${comment.line}`;
    for (const problem of lintComment(comment.body, lang)) problems.push({ index: comment.index, location, problem });
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

export const TOO_LARGE = /too_large|exceeded the maximum number of lines/i;

export function readDiff(pr, repo, run = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })) {
  try {
    return run(["pr", "diff", String(pr), ...(repo ? ["--repo", repo] : [])]);
  } catch (error) {
    if (!TOO_LARGE.test(`${error.stderr ?? ""}${error.message}`)) throw error;
    return run(["api", `repos/${repo ?? "{owner}/{repo}"}/pulls/${pr}/files`, "--paginate", "--jq", '.[] | "+++ b/" + .filename + "\\n" + (.patch // "")']);
  }
}

export const mapLanguage = (field) => resolveMap(process.cwd())?.map.language?.[field] ?? chatLanguage();

export function newestFindings(pr, dir = join(process.cwd(), "plans", "reports")) {
  const name = new RegExp(`^review-\\d{6}-\\d{4}-pr${pr}-findings\\.md$`);
  const found = existsSync(dir) ? readdirSync(dir).filter((entry) => name.test(entry)).sort().at(-1) : undefined;
  return found && join(dir, found);
}

function repoPins(text, evidence) {
  const { pins, problems } = pinRepos(cites([text, evidence ? readFileSync(evidence, "utf8") : ""].join("\n")), mapRepos(resolveMap(process.cwd())?.map));
  for (const problem of problems) console.log(`sources: ${problem}`);
  return problems.length ? null : pins;
}

async function chatPins(kind, flag) {
  const map = resolveMap(process.cwd())?.map;
  if (kind === "figma-comment") {
    const file = flag("--file") ?? map?.figma?.file;
    if (!file) return [];
    const { client, figmaPin } = await import("./figma-comments.mjs");
    return [await takePin(`Figma file ${file}`, async () => figmaPin(client({ file })))];
  }
  const doc = flag("--doc") ?? map?.prd?.doc;
  if (!doc) return [];
  const { gdocPin, session } = await import("./gdoc-comments.mjs");
  return [await takePin(`Google Doc ${doc}`, async () => gdocPin(await session({ doc })))];
}

function record(file, text, pins, none, freeze = true) {
  writeSources(file, pins, text);
  console.log(pins.length ? pins.map(describePin).join("\n") : `pinned: ${none}`);
  const frozen = freeze && snapshotOnce(file, text);
  if (frozen) console.log(`original frozen for the edit log: ${frozen}`);
}

async function main([kind, file, ...flags]) {
  const flag = (name) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined);
  if ((kind === "doc-comment" || kind === "figma-comment") && file) {
    const text = readFileSync(file, "utf8");
    const problems = lintChatComment(text, kind.replace("-comment", ""), mapLanguage("doc_figma"));
    for (const problem of problems) console.log(problem);
    if (problems.length) return 1;
    const pins = await chatPins(kind, flag);
    console.log(`clean: ${kind}`);
    record(file, text, pins, kind === "figma-comment" ? "no Figma file in the project map" : "no PRD doc in the project map");
    return 0;
  }
  if (kind === "pr-reply" && file) {
    const text = readFileSync(file, "utf8");
    const problems = lintComment(text.trim(), mapLanguage("pr_review"));
    for (const problem of problems) console.log(problem);
    if (problems.length) return 1;
    const pins = repoPins(text, flag("--findings"));
    if (!pins) return 1;
    console.log("clean: pr-reply");
    record(file, text, pins, "no path:line@branch cite in the body or the --findings file", false);
    return 0;
  }
  if (kind !== "pr-comment" || !file) {
    console.error("usage: draft-lint.mjs pr-comment <draft.md> [--diff <file>] [--repo <owner/repo>] [--findings <file>] | pr-reply <body.txt> [--findings <file>] | doc-comment <body.txt> [--doc <id>] | figma-comment <body.txt> [--file <key>]");
    return 2;
  }
  const text = readFileSync(file, "utf8");
  const { pr } = parseDraft(text);
  const diffText = flag("--diff") ? readFileSync(flag("--diff"), "utf8") : readDiff(pr, flag("--repo"));
  const result = lintDraft(text, diffText, mapLanguage("pr_review"));
  if (result.problems.length) {
    for (const item of result.problems) console.log(`${item.index}. ${item.location}: ${item.problem}`);
    return 1;
  }
  const pins = repoPins(text, flag("--findings") ?? newestFindings(pr));
  if (!pins) return 1;
  console.log(`clean: ${result.comments.length} comments, PR #${result.pr}, head ${result.sha}`);
  record(file, text, pins, `no path:line@branch cite in the draft or a findings file for PR #${pr}`);
  return 0;
}

export function run() {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`draft-lint: ${error.message}`);
      process.exit(1);
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
