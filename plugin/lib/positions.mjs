import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOMAINS } from "./prior-art-index.mjs";

export const RINGS = ["adopt", "trial", "assess", "hold"];
export const CERTAINTIES = ["high", "moderate", "low", "very-low"];
const RING_USES = { adopt: 3, trial: 1 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const sectionOf = (body, heading) => body.match(new RegExp(`^## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"))?.[1] ?? "";

export function parsePosition({ slug, text }) {
  const [, front = "", body = ""] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];
  const field = (key) => front.match(new RegExp(`^${key}: (.*)$`, "m"))?.[1]?.trim();
  const against = sectionOf(body, "Against").trim();
  return {
    slug,
    title: field("title"),
    question: field("question"),
    domains: (field("domains") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    ring: field("ring"),
    certainty: field("certainty"),
    reviewed: field("reviewed"),
    kitStatus: field("kit-status"),
    derived: new Set([...sectionOf(body, "Derived from").matchAll(/^- `([a-z0-9-]+)`/gm)].map((match) => match[1])),
    against: new Set([...against.matchAll(/`([a-z0-9-]+)`/g)].map((match) => match[1])),
    againstText: against,
    knownUses: (sectionOf(body, "Known uses").match(/^- /gm) ?? []).length,
  };
}

function frontErrors(page) {
  const errors = [];
  if (!page.title) errors.push("no title: line");
  if (!page.question) errors.push("no question: line");
  if (!page.domains.length) errors.push("no domains: line");
  errors.push(...page.domains.filter((domain) => !(domain in DOMAINS)).map((domain) => `domain ${domain} is not in the vocabulary`));
  if (!RINGS.includes(page.ring)) errors.push(`ring must be one of ${RINGS.join(", ")}`);
  if (!CERTAINTIES.includes((page.certainty ?? "").split(/[\s(]/)[0])) errors.push(`certainty must start with one of ${CERTAINTIES.join(", ")}`);
  if (!DATE.test(page.reviewed ?? "")) errors.push("reviewed must be YYYY-MM-DD");
  const status = page.kitStatus ?? "";
  if (!/^(conforms|deviates|not-applicable)\b/.test(status)) errors.push("kit-status must start with conforms, deviates or not-applicable");
  else if (status.startsWith("deviates") && !/ADR \d{4}/.test(status)) errors.push("kit-status deviates must name an ADR (deviates (ADR NNNN: reason))");
  return errors;
}

function dissentErrors(page) {
  const text = page.againstText;
  const noneFound = /^none found\b/i.test(text);
  if (!text || (noneFound && (text.match(/"[^"]+"/g) ?? []).length < 2)) return ["Against / dissent is empty; name the notes that disagree or write none found plus two quoted queries"];
  return [];
}

function noteErrors(page, notes) {
  const bySlug = new Map(notes.map((note) => [note.slug, note]));
  const errors = [];
  for (const slug of page.derived) if (!bySlug.has(slug)) errors.push(`cites note ${slug}, which does not exist`);
  const cited = [...page.derived, ...[...page.against].filter((slug) => bySlug.has(slug))];
  for (const slug of new Set(cited)) {
    const note = bySlug.get(slug);
    if (!note) continue;
    if (!note.positions.includes(page.slug)) errors.push(`cited note ${slug} does not name this position in its positions: line`);
    else if (DATE.test(page.reviewed ?? "") && note.read > page.reviewed) errors.push(`pending: note ${slug} was read ${note.read}, after the review on ${page.reviewed}`);
  }
  for (const note of notes) {
    if (note.positions.includes(page.slug) && !page.derived.has(note.slug) && !page.against.has(note.slug)) errors.push(`pending: note ${note.slug} names this position but is in neither Derived from nor Against`);
    const shared = note.domains.filter((domain) => page.domains.includes(domain));
    if (!note.positions.length && shared.length && DATE.test(page.reviewed ?? "") && note.read > page.reviewed) errors.push(`pending: note ${note.slug} (${shared.join(", ")}, read ${note.read}) has no positions: line; name this position or write positions: none`);
  }
  return errors;
}

export function positionErrors(pages, notes) {
  const errors = pages.flatMap((page) => {
    const uses = RING_USES[page.ring];
    const ringErrors = uses && page.knownUses < uses ? [`ring ${page.ring} needs at least ${uses} known ${uses === 1 ? "use" : "uses"}, found ${page.knownUses}`] : [];
    return [...frontErrors(page), ...noteErrors(page, notes), ...dissentErrors(page), ...ringErrors].map((error) => `${page.slug}: ${error}`);
  });
  const slugs = new Set(pages.map((page) => page.slug));
  for (const note of notes) for (const slug of note.positions) if (slug !== "none" && !slugs.has(slug)) errors.push(`notes/${note.slug}: names position ${slug}, which has no page`);
  return errors;
}

export function renderPositions(pages, errors) {
  if (!pages.length) return "";
  const lines = ["## Positions", "", "The best current method for each recurring design question. Read the page for your question before the domain entries below; a pending page has evidence it has not taken in yet.", ""];
  for (const page of [...pages].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const pending = errors.some((error) => error.startsWith(`${page.slug}: `)) ? "; pending" : "";
    lines.push(`- [${page.title}](positions/${page.slug}.md) (${page.ring}, ${(page.certainty ?? "").split(/[\s(]/)[0]}; kit ${page.kitStatus}${pending}): ${page.question}`);
  }
  return `${lines.join("\n")}\n`;
}

export function kitPositions(repo) {
  const dir = join(repo, "docs/prior-art/private/positions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith(".md")).sort().map((file) => parsePosition({ slug: file.slice(0, -3), text: readFileSync(join(dir, file), "utf8") }));
}
