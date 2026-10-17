import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { chatLanguage, labels } from "./labels.mjs";
import { resolveMap } from "./project-map.mjs";

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
const LEAF_TYPES = new Set(["task", "bug", "user story"]);
const FRONTEND_TAG = /^\[(?:FE|Admin-FE)\]/i;
const WIRE_SUBJECT = /^\[[^\]]+\]\s+Wire\b/i;
const BLOCKING_LINE = /^\s*[-*]\s*Blocking:/i;
const TRIED = /\bTried:/i;
const QUOTED = /"[^"]*"|“[^”]*”|\{[^}]*\}/g;

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
const kindOf = (draft) => String(draft.type ?? "").trim().toLowerCase();
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const blockingQuestions = (description) => (findSection(sections(description), ["open questions"]) ?? "").split("\n").filter((line) => BLOCKING_LINE.test(line));

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
    for (const line of blockingQuestions(description).filter((line) => !TRIED.test(line))) {
      block("oq-untried", `blocking open question has no "Tried:" trail; record where you looked before it reaches the team: ${line.trim().slice(0, 80)}`);
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

export function readiness(drafts, { updating = new Set() } = {}) {
  const parents = new Set(drafts.map((draft) => draft.parent).filter((parent) => typeof parent === "string"));
  const lintable = drafts.filter((draft) => REQUIRED[kindOf(draft)]);
  const descOk = lintable.filter((draft) => !lintWorkPackage(draft).some((finding) => finding.severity === "BLOCK")).length;
  const leaves = drafts.filter((draft) => LEAF_TYPES.has(kindOf(draft)) && !parents.has(draft.slug) && draft.id === undefined && !updating.has(draft.slug));
  const estimated = leaves.filter((draft) => typeof draft.estimate === "number").length;
  const percent = (part, whole) => (whole ? Math.round((100 * part) / whole) : 0);
  const pctDesc = percent(descOk, lintable.length);
  const pctEst = leaves.length ? percent(estimated, leaves.length) : 100;
  const verdict = !lintable.length || pctDesc < 50 || pctEst < 40 ? "missing" : pctDesc >= 90 && pctEst >= 80 ? "ready" : "thin";
  const questions = drafts.reduce((sum, draft) => sum + blockingQuestions(draft.description ?? "").length, 0);
  return { total: drafts.length, lintable: lintable.length, descOk, leaves: leaves.length, estimated, blockingQuestions: questions, pctDesc, pctEst, verdict };
}

export const readinessLine = (stats, lang) => `readiness ${labels(lang)[`readiness.${stats.verdict}`]}: description ${stats.descOk}/${stats.lintable}, estimate ${stats.estimated}/${stats.leaves}, blocking open questions ${stats.blockingQuestions}`;

export function lintDrafts(drafts, { glossary = {} } = {}) {
  const findings = [];
  const warn = (slug, rule, message) => findings.push({ slug, severity: "WARN", rule, message });
  for (const story of drafts.filter((draft) => kindOf(draft) === "user story" && draft.slug)) {
    const screens = drafts.filter((draft) => draft.parent === story.slug && FRONTEND_TAG.test(draft.subject ?? ""));
    const wires = screens.filter((draft) => WIRE_SUBJECT.test(draft.subject));
    if (screens.length && !wires.length) warn(story.slug, "story-layers-unjoined", "the story has a UI task but no wire task; every screen gets both");
    else if (wires.length && wires.length === screens.length) warn(story.slug, "story-layers-unjoined", "the story has a wire task but no UI task; every screen gets both");
  }
  for (const [preferred, banned] of Object.entries(glossary)) {
    if (!banned?.length) continue;
    const pattern = new RegExp(`\\b(?:${banned.map(escapeRegExp).join("|")})\\b`, "i");
    for (const draft of drafts) {
      const hit = prose(`${draft.subject ?? ""}\n${draft.description ?? ""}`).replace(QUOTED, " ").match(pattern);
      if (hit) warn(draft.slug ?? draft.subject, "glossary-drift", `says "${hit[0]}" where the map's glossary fixes "${preferred}"`);
    }
  }
  return findings;
}

function main(files) {
  if (!files.length) {
    console.error("usage: task-lint.mjs <drafts.json>...   (each file: an array of { slug, type, subject, description, ... })");
    return 2;
  }
  let blocked = 0;
  const glossary = resolveMap(process.cwd())?.map.glossary ?? {};
  for (const file of files) {
    const drafts = JSON.parse(readFileSync(file, "utf8"));
    for (const draft of drafts) {
      const findings = lintWorkPackage(draft);
      blocked += findings.filter((finding) => finding.severity === "BLOCK").length;
      const label = draft.slug ?? draft.subject;
      if (!findings.length) console.log(`clean ${label} (${countWords(draft.description ?? "")} words)`);
      for (const finding of findings) console.log(`${finding.severity} ${label}: ${finding.rule}: ${finding.message}`);
    }
    for (const finding of lintDrafts(drafts, { glossary })) console.log(`WARN ${finding.slug}: ${finding.rule}: ${finding.message}`);
    console.log(readinessLine(readiness(drafts), chatLanguage()));
  }
  return blocked ? 1 : 0;
}

export function run() {
  process.exit(main(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
