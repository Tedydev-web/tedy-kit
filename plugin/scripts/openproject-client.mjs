import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { requestJson } from "./api-request.mjs";

const RESERVED = /^_/;
const CHECK_LINE = /^\s*[-*]\s*\[[ xX]\]\s*(.+?)\s*$/;
const lineKey = (text) => (text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").toLowerCase().match(/[\p{L}\p{M}\p{N}_]+/gu) ?? []).join(" ");
const fold = (text) => text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase();

export function isoDuration(hours) {
  const minutes = Math.round(hours * 60);
  return `PT${Math.floor(minutes / 60)}H${minutes % 60 ? `${minutes % 60}M` : ""}`;
}

export function matchName(people, wanted) {
  const hits = people.filter((person) => fold(person.name).includes(fold(wanted)));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`no assignee in the project matches "${wanted}"`);
  throw new Error(`"${wanted}" matches ${hits.length} people: ${hits.map((person) => person.name).join(", ")}`);
}

export function buildPayload(draft, refs, lockVersion) {
  const type = refs.types[String(draft.type).toLowerCase()];
  if (!type) throw new Error(`type "${draft.type}" does not exist in this project`);
  const links = { type: { href: type } };
  if (draft.assignee) links.assignee = { href: matchName(refs.assignees, draft.assignee).href };
  if (draft.parent) links.parent = { href: `/api/v3/work_packages/${draft.parent}` };
  const payload = { subject: draft.subject, description: { format: "markdown", raw: draft.description } };
  if (draft.estimate !== undefined) payload.estimatedTime = isoDuration(draft.estimate);
  if (draft.startDate) payload.startDate = draft.startDate;
  if (draft.dueDate) payload.dueDate = draft.dueDate;
  if (draft.startDate || draft.dueDate) payload.scheduleManually = true;
  if (lockVersion !== undefined) payload.lockVersion = lockVersion;
  payload._links = links;
  return payload;
}

export function mergeDescription(old, incoming, date) {
  if (!old?.trim()) return incoming;
  const have = new Set(old.split("\n").flatMap((line) => line.match(CHECK_LINE)?.[1] ?? []).map(lineKey));
  const added = [];
  for (const line of (incoming ?? "").split("\n")) {
    const item = line.match(CHECK_LINE)?.[1];
    if (!item || have.has(lineKey(item))) continue;
    have.add(lineKey(item));
    added.push(`- [ ] ${item}`);
  }
  return added.length ? `${old.trimEnd()}\n\n## Added ${date}\n${added.join("\n")}` : old;
}

export function mergePayload(current, draft, date) {
  const payload = { lockVersion: current.lockVersion };
  const old = current.description?.raw ?? "";
  const merged = mergeDescription(old, draft.description ?? "", date);
  if (merged !== old) payload.description = { format: "markdown", raw: merged };
  if (draft.estimate !== undefined && !current.estimatedTime) payload.estimatedTime = isoDuration(draft.estimate);
  return payload;
}

export function planWrites(drafts, mapping) {
  const seen = new Set();
  return drafts.map(({ slug, id, merge }) => {
    if (!slug || RESERVED.test(slug)) throw new Error(`slug "${slug}" is missing or reserved (keys starting with _ belong to the sidecar)`);
    if (seen.has(slug)) throw new Error(`duplicate slug "${slug}" in the drafts`);
    seen.add(slug);
    if (id && merge) throw new Error(`draft "${slug}" takes either id or merge, not both`);
    const target = id ?? merge;
    if (target && mapping[slug] && mapping[slug] !== target) throw new Error(`slug "${slug}" maps to #${mapping[slug]} in the sidecar, not #${target}`);
    if (merge) return { slug, action: "merge", id: merge, adopt: true };
    if (mapping[slug]) return { slug, action: "update", id: mapping[slug] };
    return id ? { slug, action: "update", id, adopt: true } : { slug, action: "create", id: null };
  });
}

export function addSlugs(text, added) {
  const mapping = JSON.parse(text);
  for (const [slug, id] of Object.entries(added)) {
    if (mapping[slug] !== undefined && mapping[slug] !== id) throw new Error(`slug "${slug}" already maps to ${mapping[slug]}`);
    mapping[slug] = id;
  }
  return JSON.stringify(mapping, null, 2);
}

export function loadConfig() {
  const config = JSON.parse(readFileSync(join(homedir(), ".config", "op", "config.json"), "utf8"));
  const auth = `Basic ${Buffer.from(`apikey:${config.token}`).toString("base64")}`;
  const host = config.url.split("://").pop().split("/")[0].split("@").pop().replace(/:/g, "_");
  return {
    url: config.url.replace(/\/$/, ""),
    host,
    request: (path, options = {}) => requestJson(`${config.url.replace(/\/$/, "")}${path}`, { ...options, headers: { Authorization: auth, ...options.headers } }),
  };
}

export function sidecarPath(host, project) {
  return join(process.env.OP_SYNC_DIR ?? join(homedir(), ".config", "op", "sync"), `${host}__${project}.map.json`);
}

export function recordLastApply(text, at, created) {
  const mapping = JSON.parse(text);
  delete mapping._last_apply;
  mapping._last_apply = { at, created };
  return JSON.stringify(mapping, null, 2);
}

export function forgetSlugs(text, deleted, failed) {
  const mapping = JSON.parse(text);
  const gone = new Set(deleted);
  for (const [key, value] of Object.entries(mapping)) if (!key.startsWith("_") && gone.has(value)) delete mapping[key];
  if (failed.length) mapping._last_apply = { ...mapping._last_apply, created: failed };
  else delete mapping._last_apply;
  return JSON.stringify(mapping, null, 2);
}

const byName = (items, wanted, kind) => {
  const hit = items.find((item) => item.name.toLowerCase() === String(wanted).toLowerCase());
  if (!hit) throw new Error(`${kind} "${wanted}" does not exist; choose one of: ${items.map((item) => item.name).join(", ")}`);
  return hit._links.self.href;
};

export function setPayload(lockVersion, { status, assignee, priority, estimate }, refs) {
  const links = {};
  if (status) links.status = { href: byName(refs.statuses, status, "status") };
  if (assignee) links.assignee = { href: matchName(refs.assignees, assignee).href };
  if (priority) links.priority = { href: byName(refs.priorities, priority, "priority") };
  if (!Object.keys(links).length && estimate === undefined) throw new Error("nothing to set; pass --status, --assignee, --priority or --estimate");
  const payload = { lockVersion };
  if (estimate !== undefined) payload.estimatedTime = isoDuration(estimate);
  if (Object.keys(links).length) payload._links = links;
  return payload;
}

export function readSidecar(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : JSON.stringify({ _relations: [], _merged: {} }, null, 2);
}

export function writeSidecar(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export async function loadRefs(client, project) {
  const types = await client.request(`/api/v3/projects/${project}/types`);
  const assignees = await client.request(`/api/v3/projects/${project}/available_assignees?pageSize=200`);
  return {
    types: Object.fromEntries(types._embedded.elements.map((type) => [type.name.toLowerCase(), type._links.self.href])),
    assignees: assignees._embedded.elements.map((user) => ({ name: user.name, href: user._links.self.href })),
  };
}
