import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REQUIRED = {
  epic: [["outcome"], ["context"], ["acceptance criteria"], ["definition of done"]],
  "user story": [["user story"], ["acceptance criteria"]],
  task: [["goal"], ["checklist"], ["ac", "acceptance criteria"]],
  bug: [["ac", "acceptance criteria"]],
};
const CHECKBOX_REQUIRED = new Set(["acceptance criteria", "checklist", "ac"]);
const AUTHORED_TYPES = new Set(["epic", "user story", "task"]);
const WORD_CEILING = { task: 220, "user story": 180, epic: 300 };
const CHECKBOX = /^\s*[-*]\s*\[[ xX]\]/gm;
const CHECKBOX_LINE = /^\s*[-*]\s*\[[ xX]\]/;
const PATHY = /\b[\w.-]+\/[\w./-]+\.\w{1,4}\b|\b\w+\.(?:ts|tsx|js|py|json|yaml)(?::\d+)?\b/g;
const PLACEHOLDER = /\b(TODO|TBD|TBC|FIXME)\b|\?\?\?/i;
const VN_CHAR = /[Ạ-ỹÀ-ÃÈ-ÊÌÍÒ-ÕÙÚÝà-ãè-êìíò-õùúýĂăĐđĨĩŨũƠơƯư]/;
const COMPONENT_TAG = /^\[[^\]]{1,12}\]\s/;
const HEADING = /^#{2,4}\s*(.+?)\s*$/gm;
const CODE_SPAN = /`[^`]+`/g;
const LINK_TARGET = /\]\([^)\s]+\)/g;
const BARE_URL = /https?:\/\/\S+/g;
const BARE_NODE_ID = /(?<![\w:/=.-])\d{3,6}:\d{3,6}(?![\w:])/g;
const WORD = /[\p{L}\p{M}\p{N}_]+/gu;
const PARAM_SEGMENT_WORDS = 6;
const LINE_WORD_CEILING = 30;
const OVERSIZE_HOURS = 16;

const readable = (text) => text.replace(LINK_TARGET, "]").replace(BARE_URL, " ");
const prose = (text) => readable(text.replace(CODE_SPAN, " "));
export const countWords = (description) =>
  (readable(description.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n").replace(CHECKBOX, " ")).match(WORD) ?? []).length;

function vietnameseProse(text) {
  const words = prose(text).replace(/"[^"]*"|“[^”]*”|\[[^\]]*\]/g, " ").split(/\s+/);
  return words.filter((word) => VN_CHAR.test(word) && !/^\p{Lu}/u.test(word.replace(/^[^\p{L}]+/u, "")));
}

function proseWords(line) {
  let text = prose(line).replace(CHECKBOX_LINE, "");
  if ((text.match(/·/g) ?? []).length >= 2) {
    text = text.split("·").map((segment) => (segment.trim().split(/\s+/).length > PARAM_SEGMENT_WORDS ? segment : "x")).join(" ");
  }
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function sections(description) {
  const matches = [...description.matchAll(HEADING)];
  const found = new Map();
  matches.forEach((match, index) => {
    const name = match[1].replace(/[^\p{L}\p{N}_ /&+-]+/gu, "").trim().toLowerCase();
    const end = index + 1 < matches.length ? matches[index + 1].index : description.length;
    found.set(name, description.slice(match.index + match[0].length, end));
  });
  return found;
}

function findSection(found, alternatives) {
  for (const [name, body] of found) if (alternatives.some((alt) => name === alt || name.startsWith(alt))) return body;
  return null;
}

const checkboxes = (body) => (body.match(CHECKBOX) ?? []).length;

export function lintWorkPackage({ type, subject = "", description = "", estimate }) {
  const kind = String(type ?? "").trim().toLowerCase();
  if (!REQUIRED[kind]) return [];
  const findings = [];
  const block = (rule, message) => findings.push({ severity: "BLOCK", rule, message });
  const warn = (rule, message) => findings.push({ severity: "WARN", rule, message });
  const found = sections(description);
  if (!description.trim()) block("desc-missing", `no description; the ${kind} template is mandatory`);
  else {
    for (const alternatives of REQUIRED[kind]) {
      const body = findSection(found, alternatives);
      if (body === null) block("desc-section", `missing section "## ${alternatives[0]}"`);
      else if (CHECKBOX_REQUIRED.has(alternatives[0]) && !checkboxes(body)) block("desc-checkbox", `section "## ${alternatives[0]}" has no "- [ ]" checkbox`);
    }
    if (AUTHORED_TYPES.has(kind)) {
      const placeholder = description.match(PLACEHOLDER);
      if (placeholder) block("desc-placeholder", `placeholder "${placeholder[0]}" in the description`);
      const vietnamese = vietnameseProse(description);
      if (vietnamese.length) block("desc-language", `Vietnamese prose in the description (${vietnamese.slice(0, 3).join(" ")}); tracker content is English, names and quoted Figma titles excepted`);
      const words = countWords(description);
      if (words > WORD_CEILING[kind]) block("desc-over", `${words} words > ${WORD_CEILING[kind]}; condense to PM altitude`);
      if (description.includes("```")) block("desc-codedump", "code fence in the description");
      if ((readable(description).match(PATHY) ?? []).length >= 3) block("desc-codedump", "3 or more file paths in the description");
      const checklist = findSection(found, ["checklist"]);
      if (checklist && checkboxes(checklist) > 8) block("checklist-over", `checklist has ${checkboxes(checklist)} items > 8; split the task`);
      const ac = findSection(found, ["ac", "acceptance criteria"]);
      if (ac && checkboxes(ac) > 6) block("ac-over", `${checkboxes(ac)} acceptance criteria > 6`);
    }
  }
  if (AUTHORED_TYPES.has(kind) && VN_CHAR.test(subject)) block("subject-language", "the subject carries Vietnamese; tracker content is English");
  if ((kind === "task" || kind === "bug") && !COMPONENT_TAG.test(subject)) warn("subject-tag", "the subject has no leading [component] tag");
  const fat = description.split("\n").filter((line) => CHECKBOX_LINE.test(line) && proseWords(line) > LINE_WORD_CEILING);
  if (fat.length) warn("line-oversize", `${fat.length} checklist line(s) over ${LINE_WORD_CEILING} words: ${fat[0].trim().slice(0, 70)}…`);
  const bare = prose(description).match(BARE_NODE_ID) ?? [];
  if (bare.length) warn("design-ref-bare", `bare design node id(s) ${bare.slice(0, 3).join(", ")}; link the on-screen title to the frame`);
  if ((kind === "task" || kind === "bug") && estimate > OVERSIZE_HOURS) warn("estimate-oversize", `${estimate} h > ${OVERSIZE_HOURS} h; a task this big hides unknowns, split it`);
  return findings;
}

function main(files) {
  if (!files.length) {
    console.error("usage: task-lint.mjs <drafts.json>...   (each file: an array of { slug, type, subject, description, ... })");
    return 2;
  }
  let blocked = 0;
  for (const file of files) {
    for (const draft of JSON.parse(readFileSync(file, "utf8"))) {
      const findings = lintWorkPackage(draft);
      blocked += findings.filter((finding) => finding.severity === "BLOCK").length;
      const label = draft.slug ?? draft.subject;
      if (!findings.length) console.log(`clean ${label} (${countWords(draft.description ?? "")} words)`);
      for (const finding of findings) console.log(`${finding.severity} ${label}: ${finding.rule}: ${finding.message}`);
    }
  }
  return blocked ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
