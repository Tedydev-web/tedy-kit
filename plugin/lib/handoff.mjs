import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chatLanguage, fill, labels } from "./labels.mjs";
import { resolveMap } from "./project-map.mjs";

const HEADER = /^(to|from|status|created|title|updated): (.*)$/;
const SECTIONS = ["## User decisions", "## First safe step", "## Sources"];

const outsideFences = (body) => {
  let fenced = false;
  return body.split("\n").filter((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
};

export const missingSections = (body) => SECTIONS.filter((heading) => !outsideFences(body).some((line) => line.trim() === heading));

export const slugOf = (text) => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${String(date.getFullYear()).slice(2)}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function render({ to, from, title, body, created }) {
  return `to: ${to}\nfrom: ${from}\nstatus: pending\ncreated: ${created}\ntitle: ${title}\n\n${body.trim()}\n`;
}

export function parse(text) {
  const fields = {};
  for (const line of text.split("\n")) {
    const match = line.match(HEADER);
    if (!match) break;
    fields[match[1]] = match[2].trim();
  }
  return fields;
}

export function setStatus(text, status, when) {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.startsWith("status: "));
  if (index === -1) throw new Error("not a hand-off file: no status line");
  lines[index] = `status: ${status}`;
  const updated = lines.findIndex((line) => line.startsWith("updated: "));
  if (updated === -1) lines.splice(index + 1, 0, `updated: ${when}`);
  else lines[updated] = `updated: ${when}`;
  return lines.join("\n");
}

export function route(map, role, repo) {
  const sessions = (map.sessions ?? []).filter((session) => session.role === role);
  if (!sessions.length) throw new Error(`the project map lists no ${role} session; add one with /tedy:setup update`);
  if (sessions.length === 1) return sessions[0];
  const match = repo && sessions.filter((session) => (session.repos ?? []).includes(repo));
  if (match?.length === 1) return match[0];
  throw new Error(`${sessions.length} ${role} sessions (${sessions.map((session) => session.name).join(", ")}); name the repository with --repo`);
}

export function listPending(dir, to) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^handoff-.*\.md$/.test(name) && statSync(join(dir, name)).isFile())
    .map((name) => ({ path: join(dir, name), ...parse(readFileSync(join(dir, name), "utf8")) }))
    .filter((item) => item.status === "pending" && (!to || item.to === to));
}

export const reportsDir = (map) => join(map.paths[0], "plans", "reports");

function project(cwd) {
  const resolved = resolveMap(cwd);
  if (!resolved) throw new Error(`no project map covers ${cwd}; run /tedy:setup`);
  return resolved.map;
}

function main([command, target, ...rest]) {
  const args = target?.startsWith("--") ? [target, ...rest] : rest;
  const flags = Object.fromEntries(args.flatMap((arg, index) => (arg.startsWith("--") ? [[arg.slice(2), args[index + 1]]] : [])));
  const map = project(process.cwd());
  if (command === "route" && target) {
    const session = route(map, target, flags.repo);
    console.log(session.name);
    return 0;
  }
  if (command === "write") {
    for (const key of ["to", "from", "title", "body-file"]) if (!flags[key]) throw new Error(`--${key} is required`);
    if (!(map.sessions ?? []).some((session) => session.name === flags.to)) throw new Error(`"${flags.to}" is not a session in the project map`);
    const body = readFileSync(flags["body-file"], "utf8");
    const missing = missingSections(body);
    if (missing.length) throw new Error(`the body lacks ${missing.join(", ")}; see shared/handoff.md`);
    const dir = reportsDir(map);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `handoff-${stamp()}-to-${slugOf(flags.to)}-${slugOf(flags.title)}.md`);
    writeFileSync(path, render({ to: flags.to, from: flags.from, title: flags.title, body, created: new Date().toISOString() }));
    console.log(path);
    console.log(`message: ${fill(labels(chatLanguage())["handoff.message"], { from: flags.from, title: flags.title, path })}`);
    return 0;
  }
  if (command === "pending") {
    for (const item of listPending(reportsDir(map), flags.to)) console.log(`${item.to} · ${item.title} · from ${item.from} · ${item.path}`);
    return 0;
  }
  if ((command === "accept" || command === "done") && target) {
    const status = command === "accept" ? "accepted" : "done";
    writeFileSync(target, setStatus(readFileSync(target, "utf8"), status, new Date().toISOString()));
    console.log(`${status}: ${target}`);
    return 0;
  }
  console.error('usage: handoff.mjs route <pm|dev|review|devops> [--repo <path>] | write --to "<session>" --from "<session>" --title "<title>" --body-file <f> | pending [--to "<session>"] | accept <file> | done <file>');
  return 2;
}

export function run() {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`handoff: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
