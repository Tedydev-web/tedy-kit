import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { STATE_DIR } from "./hook-io.mjs";
import { resolveMap } from "./project-map.mjs";
import { mapRepos, pinPullHead, pinRepos, RECHECK, recheckRepos, tipKey } from "./source-pin-git.mjs";
import { linkedDocs } from "./source-pin-links.mjs";

const unique = (list) => [...new Set(list)];

export function versionCheck(source, before, now, { kept, changed } = {}) {
  if (before === now) return {};
  const moved = `${source} changed from ${before} to ${now} since it was pinned`;
  if (kept) return { notice: `notice: ${moved}; ${kept}, so it posts as drafted` };
  return { refusal: `refused: ${moved}${changed ? ` and ${changed}` : ""}; ${RECHECK}` };
}

export async function takePin(what, take) {
  try {
    return await take();
  } catch (error) {
    throw new Error(`cannot pin ${what}: ${error.message}; fix that, then run the lint or preview again. Nothing was written.`);
  }
}

const coveredBy = (read, file, nodes, whole) => read.some((pin) => pin.kind === "figma" && pin.file === file && typeof pin.lastModified === "string" && nodes.every((id) => Object.hasOwn(pin.nodes ?? {}, id)) && (!whole || pin.whole));

export async function linkPins(text, extra = {}, read = []) {
  const links = linkedDocs(text);
  if (links.problems.length) throw new Error(`cannot pin ${links.problems.join("; ")}. Nothing was written.`);
  const figma = new Map();
  for (const { file, nodes = [], whole = false } of [...(extra.figma ?? []), ...links.figma]) {
    const entry = figma.get(file) ?? { nodes: [], whole: false };
    entry.nodes = unique([...entry.nodes, ...nodes]);
    entry.whole ||= whole;
    figma.set(file, entry);
  }
  const pins = [];
  const fetched = [...figma].filter(([file, { nodes, whole }]) => !coveredBy(read, file, nodes, whole));
  for (const [file, { nodes, whole }] of figma) if (!fetched.some(([other]) => other === file)) pins.push({ kind: "figma", file, nodes: Object.fromEntries(nodes.map((id) => [id, null])), whole, held: true });
  if (fetched.length) {
    const { client, figmaPin } = await import("./figma-comments.mjs");
    for (const [file, { nodes, whole }] of fetched) pins.push(await takePin(`Figma file ${file}`, async () => figmaPin(client({ file }), nodes, whole)));
  }
  const docs = unique([...(extra.docs ?? []), ...links.docs]);
  const held = docs.filter((doc) => read.some((pin) => pin.kind === "gdoc" && pin.doc === doc && typeof pin.text === "string"));
  pins.push(...held.map((doc) => ({ kind: "gdoc", doc, held: true })));
  const fresh = docs.filter((doc) => !held.includes(doc));
  const drive = links.drive.filter((id) => !docs.includes(id));
  const heldDrive = drive.filter((id) => read.some((pin) => (pin.kind === "drive" && pin.file === id) || (pin.kind === "gdoc" && pin.doc === id && typeof pin.text === "string")));
  pins.push(...heldDrive.map((id) => (read.some((pin) => pin.kind === "drive" && pin.file === id) ? { kind: "drive", file: id, held: true } : { kind: "gdoc", doc: id, held: true })));
  const freshDrive = drive.filter((id) => !heldDrive.includes(id));
  if (fresh.length || freshDrive.length) {
    const { drivePin, gdocPin, session } = await import("./gdoc-comments.mjs");
    for (const doc of fresh) pins.push(await takePin(`Google Doc ${doc}`, async () => gdocPin(await session({ doc }))));
    for (const id of freshDrive) pins.push(await takePin(`Drive file ${id}`, async () => drivePin(await session({ doc: id }))));
  }
  return pins;
}

export async function pinSourcesOf(text, extra = {}, { pr, repo, branches = [], readKey } = {}) {
  const resolved = resolveMap(process.cwd());
  if (!resolved) return { pins: [], problems: [`no project map covers ${process.cwd()}, so its repos cannot be pinned; run this from a folder of a mapped project, or map it with /tedy:setup`] };
  const repos = mapRepos(resolved.map);
  const head = pr === undefined ? { pins: [], problems: [] } : pinPullHead(pr, repos, { repo });
  const git = await pinRepos(repos, text, { extra: branches, reviewed: head.pins[0]?.repo });
  const problems = [...git.problems, ...head.problems];
  if (problems.length) return { pins: [], problems };
  return { pins: [...git.pins, ...head.pins, ...(await linkPins(text, extra, readKey === undefined ? [] : (loadReadPins(readKey)?.sources ?? [])))], problems: [] };
}

async function recheckLinked(pin) {
  if (pin.kind === "figma") {
    const { client, recheckFigma } = await import("./figma-comments.mjs");
    return recheckFigma(client({ file: pin.file }), pin);
  }
  if (pin.kind === "gdoc") {
    const { recheckGdoc, session } = await import("./gdoc-comments.mjs");
    return recheckGdoc(await session({ doc: pin.doc }), pin);
  }
  if (pin.kind === "drive") {
    const { recheckDrive, session } = await import("./gdoc-comments.mjs");
    return recheckDrive(await session({ doc: pin.file }), pin);
  }
  return { refusal: `refused: the sources record holds a pin of unknown kind ${JSON.stringify(pin.kind)}; ${RECHECK}` };
}

export async function recheckPins(sources, { texts = [], tips } = {}) {
  const git = sources.filter((pin) => pin.kind === "git");
  const { refusals, notices } = git.length ? await recheckRepos(git, mapRepos(resolveMap(process.cwd())?.map), texts, undefined, { tips }) : { refusals: [], notices: [] };
  for (const pin of sources.filter((candidate) => candidate.kind !== "git")) {
    let verdict;
    try {
      verdict = await recheckLinked(pin);
    } catch (error) {
      verdict = { refusal: error.message.startsWith("refused:") ? error.message : `refused: ${pin.kind === "figma" ? `Figma ${pin.file}` : pin.kind === "drive" ? `Drive file ${pin.file}` : `Google Doc ${pin.doc}`} could not be rechecked (${error.message}); fix that, then publish again` };
    }
    if (verdict.refusal) refusals.push(verdict.refusal);
    if (verdict.notice) notices.push(verdict.notice);
  }
  return { refusals, notices };
}

const stageOf = (pin) => (pin.stage === "read" ? ` (read ${pin.at})` : " (at lint)");

export const describePin = (pin) => {
  if (pin.kind === "git") return `pinned: ${pin.repo} ${pin.ref}@${pin.sha}${stageOf(pin)}`;
  if (pin.kind === "gdoc") return `pinned: Google Doc ${pin.doc} text ${pin.text.slice(0, 12)} via ${pin.method}${stageOf(pin)}`;
  if (pin.kind === "drive") return `pinned: Drive file ${pin.file} ${pin.version}${stageOf(pin)}`;
  const nodes = Object.entries(pin.nodes);
  return `pinned: Figma ${pin.file} lastModified ${pin.lastModified}${nodes.length ? ` · node ${nodes.map(([id, hash]) => `${id} ${hash.slice(0, 12)}`).join(", ")}` : ""}${pin.whole ? " · whole file" : ""}${stageOf(pin)}`;
};

const digest = (text) => createHash("sha256").update(text).digest("hex");

const statePath = (file, suffix) => join(STATE_DIR, "drafts", `${resolve(file).replace(/\//g, "_")}${suffix}`);

export const sourcesPath = (file) => statePath(file, ".sources.json");

export function writeSources(file, sources, text, { warnings = [], pinnedAt } = {}) {
  const path = sourcesPath(file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ file: resolve(file), at: new Date().toISOString(), ...(text === undefined ? {} : { sha256: digest(text) }), ...(pinnedAt === undefined ? {} : { pinnedAt: resolve(pinnedAt) }), warnings, sources }, null, 1)}\n`);
  return path;
}

const relintWith = (relint, pinnedAt) => `${relint} ${typeof pinnedAt === "string" ? `--pinned-at ${pinnedAt}` : "[--pinned-at <file pin-sources ran for>]"}`;

export function pinnedSources(file, relint) {
  const path = sourcesPath(file);
  const again = (pinnedAt) => `run ${relintWith(relint, pinnedAt)}, then ask the user again`;
  if (!existsSync(path)) return { refusal: `refused: ${file} has no pinned sources; ${again()}` };
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(record?.sources)) throw new Error("no sources list");
  } catch (error) {
    return { refusal: `refused: the sources record for ${file} cannot be read (${error.message}); ${again()}` };
  }
  if (record.file !== resolve(file)) return { refusal: `refused: the sources record for ${file} was written for ${record.file}; ${again()}` };
  if (typeof record.sha256 !== "string") return { refusal: `refused: ${file} has a sources record with no digest of its text; ${again(record.pinnedAt)}` };
  if (record.sha256 !== digest(readFileSync(file, "utf8"))) return { refusal: `refused: ${file} changed after its sources were pinned; ${again(record.pinnedAt)}` };
  if (!Array.isArray(record.warnings) || record.warnings.some((line) => typeof line !== "string")) return { refusal: `refused: the sources record for ${file} has no list of the lint's warnings; ${again(record.pinnedAt)}` };
  return { sources: record.sources, warnings: record.warnings, pinnedAt: record.pinnedAt };
}

export async function recheckPinned(file, relint, { texts, covers, what } = {}) {
  const { sources, warnings, pinnedAt, refusal } = pinnedSources(file, relint);
  if (refusal) return { refusals: [refusal], notices: [], warnings: [] };
  if (covers && !sources.some(covers)) return { refusals: [`refused: ${file} has no pinned ${what}; run ${relintWith(relint, pinnedAt)}, then ask the user again`], notices: [], warnings };
  return { ...(await recheckPins(sources, { texts })), warnings };
}

export const readPinsPath = (file) => statePath(file, ".read-pins.json");

export function writeReadPins(file, sources) {
  const at = new Date().toISOString();
  const stamped = sources.map((pin) => ({ ...pin, stage: "read", at }));
  const path = readPinsPath(file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ file: resolve(file), at, sources: stamped }, null, 1)}\n`);
  return stamped;
}

function loadReadPins(key) {
  const path = readPinsPath(key);
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (record?.file !== resolve(key) || !Array.isArray(record.sources) || Number.isNaN(Date.parse(record.at))) throw new Error(`not a read pin record for ${key}`);
    return { sources: record.sources, at: record.at };
  } catch (error) {
    return { problem: `the read pins for ${key} cannot be read (${error.message}); run draft-lint.mjs pin-sources ${key} again, re-read the sources and lint again` };
  }
}

const pinLabel = (pin, nodes = Object.keys(pin.nodes ?? {})) => (pin.kind === "git" ? `${pin.repo} ${pin.ref}` : pin.kind === "gdoc" ? `Google Doc ${pin.doc}` : pin.kind === "drive" ? `Drive file ${pin.file}` : nodes.length ? `Figma ${pin.file} node ${nodes.join(", ")}` : `Figma ${pin.file} file`);

function matchReadPins(read, pins) {
  const kept = read.filter((pin) => pin.kind === "git");
  const extra = [];
  const unchecked = [];
  for (const pin of pins) {
    if (pin.kind === "git") {
      if (!kept.some((candidate) => candidate.repo === pin.repo && candidate.ref === pin.ref)) extra.push({ pin, label: pinLabel(pin) });
      continue;
    }
    const match = read.find((candidate) => candidate.kind === pin.kind && (pin.kind === "gdoc" ? candidate.doc === pin.doc : candidate.file === pin.file));
    if (!match) {
      extra.push({ pin, label: pinLabel(pin) });
      continue;
    }
    if (pin.kind !== "figma") {
      kept.push(match);
      continue;
    }
    const ids = Object.keys(pin.nodes ?? {});
    const shared = ids.filter((id) => Object.hasOwn(match.nodes ?? {}, id));
    const whole = Boolean(pin.whole && match.whole);
    if (shared.length || whole) {
      const narrowed = { ...match, whole, nodes: Object.fromEntries(shared.map((id) => [id, match.nodes[id]])) };
      kept.push(narrowed);
      if (pin.held) unchecked.push(narrowed);
    }
    const missing = ids.filter((id) => !shared.includes(id));
    if (missing.length || (pin.whole && !match.whole)) extra.push({ pin, label: pinLabel(pin, missing) });
  }
  return { kept, extra, unchecked };
}

export async function settleReadPins(key, pins, { texts, file } = {}) {
  const read = loadReadPins(key);
  if (read === null) return { pins, problems: [], read: false, lines: pins.length ? [`warning: no read pins for ${key}, so these were pinned now, at lint, and a change made while you read them is not seen: ${pins.map((pin) => pinLabel(pin)).join("; ")}; next time run draft-lint.mjs pin-sources ${key} before reading`] : [] };
  if (read.problem) return { pins: [], problems: [read.problem], lines: [] };
  if (file && existsSync(file) && Date.parse(read.at) > statSync(file).mtimeMs) return { pins: [], problems: [`the read pins for ${key} were taken at ${read.at}, after ${file} was last written: pin-sources ran again but the draft was not re-read and rewritten; re-read the sources, update ${file}, then lint it again`], lines: [] };
  const { kept, extra, unchecked } = matchReadPins(read.sources, pins);
  const tips = new Map(pins.filter((pin) => pin.kind === "git").map((pin) => [tipKey(pin), pin.sha]));
  const { refusals, notices } = await recheckPins(kept.filter((pin) => !unchecked.includes(pin)), { texts, tips });
  return {
    pins: [...kept, ...extra.map(({ pin }) => pin)],
    problems: refusals.length ? [...refusals, `a source changed while it was being read; run draft-lint.mjs pin-sources ${key} again, re-read what changed, fix the draft and lint it again`] : [],
    read: true,
    lines: [...notices, ...extra.map(({ label }) => `warning: ${label} was not pinned by draft-lint.mjs pin-sources ${key}, so it was pinned now, at lint`)],
  };
}

export async function recordPins(file, text, pins, { pinnedAt = file, texts, warnings = [] } = {}) {
  const settled = await settleReadPins(pinnedAt, pins, { texts, file });
  const lines = [...warnings, ...settled.lines];
  for (const line of lines) console.log(line);
  for (const problem of settled.problems) console.log(`sources: ${problem}`);
  if (settled.problems.length) return null;
  writeSources(file, settled.pins, text, { warnings: lines.filter((line) => line.startsWith("warning: ")), ...(settled.read ? { pinnedAt } : {}) });
  return settled.pins;
}

export async function requireFresh(file, relint, options) {
  const { refusals, notices, warnings } = await recheckPinned(file, relint, options);
  if (refusals.length) throw new Error(refusals.join("\n"));
  return { notices, warnings };
}

export const sayNotices = (notices) => {
  for (const notice of notices) console.log(notice);
};
