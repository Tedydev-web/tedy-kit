import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const GRANDFATHERED = new Set([
  "0001-re-architecture-consolidation.md",
  "0002-publishing-and-push-approval.md",
  "0003-session-roles-and-pending-list.md",
  "0004-pull-requests-follow-work-packages.md",
  "0005-comments-for-non-developers.md",
  "0006-rules-size-budget.md",
  "0007-considered-and-rejected.md",
  "0008-derived-waiting-list.md",
]);
export const SOCIAL = new Set(["x", "reddit", "youtube", "facebook"]);
const CHANNELS = new Set(["github", "web", "local", ...SOCIAL]);
const ADR_NAME = /^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE = /^- (.+?) \((.+), studied (\S+), via (\S+)\)$/;
const PROPRIETARY = "proprietary (installed)";
export const PINNED_BLOB = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/([0-9a-f]{40})\/([^?#\s]+)(?:\?plain=1)?#L(\d+)(?:-L(\d+))?$/;
export const ISSUE_OR_PR = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)$/;
const COMMAND = /^(`[^`]+` \([^)]*\d+\.\d+[^)]*\))(?: "(.+)")?$/;
const LOCAL_PATH = /^(?:~\/|[\w.-]+\/)\S*:\d+(?:-\d+)?$/;
const FEAT_OR_FIX = /^(feat|fix)(?:\([^)]+\))?!?:/;

function outsideFences(text) {
  let fence = "";
  return text.split("\n").map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker && (!fence || marker[1].startsWith(fence))) {
      fence = fence ? "" : marker[1];
      return "";
    }
    return fence ? "" : line;
  });
}

function priorArtSection(text) {
  const lines = outsideFences(text);
  const start = lines.findIndex((line) => line.trim() === "## Prior art");
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

export function parseQueries(text) {
  const queries = text.split(/;\s*/).map((part) => part.trim().match(/^(\S+): "(.+)"$/));
  if (queries.some((query) => !query || !CHANNELS.has(query[1]))) return null;
  return queries.map((query) => ({ channel: query[1], query: query[2] }));
}

function queryLineErrors(label, rest, needSocial) {
  const [date, ...others] = rest.split(" ");
  if (!DATE.test(date)) return [`${label}: needs a YYYY-MM-DD date before the queries`];
  const queries = parseQueries(others.join(" "));
  if (!queries) return [`${label}: queries must read <channel>: "<query>"; <channel>: "<query>"`];
  const channels = new Set(queries.map((query) => query.channel));
  const social = [...channels].filter((channel) => SOCIAL.has(channel));
  if (needSocial === "all") return social.length >= 2 ? [] : [`${label}: needs two social channels (x, reddit, youtube, facebook)`];
  if (channels.size < 2) return [`${label}: needs at least two channels`];
  return social.length ? [] : [`${label}: needs at least two channels, one of them social`];
}

function evidenceErrors(name, text, proprietary) {
  const command = text.match(COMMAND);
  const [, ref, quoted] = command ? command : text.match(/^(\S+)(?: (.*))?$/);
  const excerpt = command ? quoted : quoted?.match(/^"(.+)"$/)?.[1];
  if (!command && quoted !== undefined && excerpt === undefined) return [`${name}: unknown evidence "${text}"`];
  if (ref.startsWith("https://github.com/") && !PINNED_BLOB.test(ref) && !ISSUE_OR_PR.test(ref)) return [`${name}: unpinned GitHub link ${ref}`];
  const known = command || ref.startsWith("https://") || LOCAL_PATH.test(ref);
  if (!known) return [`${name}: unknown evidence "${text}"`];
  if (/youtube\.com|youtu\.be/.test(ref) && !/[?&]t=/.test(ref)) return [`${name}: YouTube link needs t=`];
  if (proprietary) return excerpt === undefined ? [] : [`${name}: a proprietary source must not quote its text`];
  return excerpt === undefined ? [`${name}: ${ref} needs a quoted excerpt`] : [];
}

function sourceErrors(source, cardExists) {
  const [, name, license, date, channel] = source.header;
  const errors = [];
  if (!DATE.test(date)) errors.push(`${name}: studied date must be YYYY-MM-DD`);
  if (!CHANNELS.has(channel)) errors.push(`${name}: unknown channel "${channel}"`);
  const items = source.items;
  const card = items.find((item) => item.startsWith("card: "));
  if (channel === "github" && !card) errors.push(`${name}: a GitHub source needs "card: <slug>" as its first sub-bullet`);
  if (card) {
    const slug = card.slice(6).trim();
    if (!SLUG.test(slug) || !cardExists(slug)) errors.push(`${name}: card "${slug}" not found in docs/prior-art`);
  }
  if (!items.some((item) => item.startsWith("Lesson: "))) errors.push(`${name}: no Lesson line`);
  if (!items.some((item) => /^(Taken|Not taken): /.test(item))) errors.push(`${name}: no Taken or Not taken line`);
  const evidence = items.filter((item) => !/^(card|Lesson|Taken|Not taken): /.test(item));
  if (!evidence.length) errors.push(`${name}: no evidence`);
  for (const item of evidence) errors.push(...evidenceErrors(name, item, license === PROPRIETARY));
  return errors;
}

export function checkAdrText(text, { cardExists }) {
  const section = priorArtSection(text);
  if (!section) return ['no "## Prior art" section'];
  const none = section.find((line) => line.startsWith("no prior art: "));
  if (none) return queryLineErrors("no prior art", none.slice(14), "one");
  const sources = [];
  const errors = [];
  for (const line of section) {
    if (line.startsWith("- ")) {
      const header = line.match(SOURCE);
      if (!header) errors.push(`source line must read "- <name> (<license>, studied <date>, via <channel>)": ${line}`);
      sources.push({ header: header || [line, line, "", "", ""], items: [] });
    } else if (/^ {2}- /.test(line) && sources.length) sources.at(-1).items.push(line.slice(4).trim());
  }
  if (!sources.length) return ['no sources and no "no prior art:" line'];
  for (const source of sources) errors.push(...sourceErrors(source, cardExists));
  const noSocial = section.find((line) => line.startsWith("no social prior art: "));
  if (noSocial) errors.push(...queryLineErrors("no social prior art", noSocial.slice(21), "all"));
  else if (!sources.some((source) => SOCIAL.has(source.header[4]))) errors.push('no social source and no "no social prior art:" line');
  return errors;
}

export function checkAdrFolder(adrDir, cardsDir) {
  const names = existsSync(adrDir) ? readdirSync(adrDir).sort() : [];
  if (!names.length) return [{ file: "docs/adr", error: "no ADR files" }];
  const cardExists = (slug) => existsSync(join(cardsDir, `${slug}.md`));
  return names.flatMap((file) => {
    if (!ADR_NAME.test(file)) return [{ file, error: "name is not NNNN-kebab-case.md" }];
    if (GRANDFATHERED.has(file)) return [];
    return checkAdrText(readFileSync(join(adrDir, file), "utf8"), { cardExists }).map((error) => ({ file, error }));
  });
}

function trailerErrors(type, value, repo) {
  if (value.startsWith("n/a ")) {
    if (type !== "fix") return ["Prior-art n/a is for fix commits only"];
    return /^n\/a \(.*\S.*\)$/.test(value) ? [] : [`invalid Prior-art "${value}"`];
  }
  if (value.startsWith("none ")) {
    const queries = value.match(/^none \((.+)\)$/) && parseQueries(value.slice(6, -1));
    if (!queries) return [`invalid Prior-art "${value}"`];
    return new Set(queries.map((query) => query.channel)).size >= 2 ? [] : ["Prior-art none needs at least two channels"];
  }
  if (/^https:\/\/\S+$/.test(value)) return [];
  if (SLUG.test(value) && existsSync(join(repo, "docs", "prior-art", `${value}.md`))) return [];
  return SLUG.test(value) ? [`card "${value}" not found in docs/prior-art`] : [`invalid Prior-art "${value}"`];
}

function adrExists(repo, number) {
  const dir = join(repo, "docs", "adr");
  return existsSync(dir) && readdirSync(dir).some((file) => file.startsWith(`${number}-`));
}

export function checkCommits(repo) {
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let tag;
  try {
    tag = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*").trim();
  } catch {
    return [{ commit: "HEAD", error: "no tag reachable from HEAD; the trailer check needs the latest release tag" }];
  }
  const format = "%h%x1f%s%x1f%(trailers:key=ADR,valueonly,separator=%x1d)%x1f%(trailers:key=Prior-art,valueonly,separator=%x1d)%x1e";
  const records = git("log", `--format=${format}`, `${tag}..HEAD`).split("\x1e").map((record) => record.trim()).filter(Boolean);
  return records.flatMap((record) => {
    const [commit, subject, adrs, sources] = record.split("\x1f");
    const type = subject.match(FEAT_OR_FIX)?.[1];
    if (!type) return [];
    const split = (text) => text.split("\x1d").map((value) => value.trim()).filter(Boolean);
    const adrValues = split(adrs);
    const sourceValues = split(sources);
    if (!adrValues.length && !sourceValues.length) return [{ commit, error: `${subject}: no ADR: or Prior-art: trailer` }];
    const errors = [
      ...adrValues.flatMap((value) => (/^\d{4}$/.test(value) && adrExists(repo, value) ? [] : [`ADR ${value} not found in docs/adr`])),
      ...sourceValues.flatMap((value) => trailerErrors(type, value, repo)),
    ];
    return errors.map((error) => ({ commit, error: `${subject}: ${error}` }));
  });
}
