import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchTab } from "./prd-section.mjs";
import { profileDir } from "./profile.mjs";
import { discover } from "./project-discover.mjs";

export const PROJECTS_DIR = join(profileDir(), "projects");

export function parseMap(text) {
  const block = text.match(/```json\n([\s\S]*?)\n```/);
  if (!block) throw new Error("no ```json block in the map file");
  try {
    return JSON.parse(block[1]);
  } catch (error) {
    throw new Error(`map JSON does not parse: ${error.message}`);
  }
}

export function loadMaps(dir = PROJECTS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && !name.startsWith("_"))
    .map((name) => ({ file: join(dir, name), map: parseMap(readFileSync(join(dir, name), "utf8")) }));
}

export function resolveMap(cwd, dir = PROJECTS_DIR) {
  let best = null;
  for (const entry of loadMaps(dir)) {
    for (const prefix of entry.map.paths ?? []) {
      const matches = cwd === prefix || cwd.startsWith(`${prefix.replace(/\/$/, "")}/`);
      if (matches && (!best || prefix.length > best.length)) best = { ...entry, length: prefix.length };
    }
  }
  return best && { file: best.file, map: best.map };
}

export function missingFields(map) {
  const required = [];
  if (!map.name) required.push("name");
  if (!map.paths?.length) required.push("paths");
  if (!map.repos?.length) required.push("repos");
  (map.repos ?? []).forEach((repo, index) => {
    if (!repo.role) required.push(`repos[${index}].role`);
  });
  if (!map.language?.pr_review) required.push("language.pr_review");
  const optional = [["prd", map.prd?.doc || map.prd?.files?.length], ["figma.file", map.figma?.file], ["tracker.type", map.tracker?.type]]
    .filter(([, value]) => !value)
    .map(([field]) => field);
  return { required, optional };
}

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

export function checkRepos(map) {
  const base = map.paths?.[0] ?? process.cwd();
  return (map.repos ?? []).map((repo) => {
    const dir = isAbsolute(repo.path) ? repo.path : resolve(base, repo.path);
    const check = `repo ${repo.path} (${repo.role ?? "no role"})`;
    if (!existsSync(dir)) return { check, status: "fail", detail: `${dir} does not exist` };
    try {
      git(dir, "rev-parse", "--git-dir");
    } catch {
      return { check, status: "fail", detail: `${dir} is not a git repository` };
    }
    let branch = repo.branch;
    if (!branch) {
      try {
        branch = git(dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, "");
      } catch {
        return { check, status: "warn", detail: "no integration branch in the map and origin/HEAD is unset" };
      }
    }
    try {
      git(dir, "rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`);
      return { check, status: "ok", detail: `origin/${branch}${repo.readonly ? ", readonly" : ""}` };
    } catch {
      return { check, status: "fail", detail: `origin/${branch} not found; run git -C ${dir} fetch origin` };
    }
  });
}

async function doctor(cwd) {
  const resolved = resolveMap(cwd);
  if (!resolved) {
    console.log(`NOT_READY\nfail map: no project map in ${PROJECTS_DIR} covers ${cwd}; run /tedy:setup`);
    return 1;
  }
  const { file, map } = resolved;
  const results = [{ check: "map", status: "ok", detail: file }];
  const gaps = missingFields(map);
  results.push({ check: "required fields", status: gaps.required.length ? "fail" : "ok", detail: gaps.required.join(", ") || "complete" });
  if (gaps.optional.length) results.push({ check: "optional fields", status: "warn", detail: `unset: ${gaps.optional.join(", ")}` });
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
    results.push({ check: "gh auth", status: "ok", detail: "logged in" });
  } catch {
    results.push({ check: "gh auth", status: "fail", detail: "gh auth status failed; ask the user to run gh auth login" });
  }
  const firstTab = Object.values(map.prd?.tabs ?? {})[0]?.tab;
  if (map.prd?.doc && firstTab) {
    try {
      await fetchTab(map.prd.doc, firstTab);
      results.push({ check: "PRD export", status: "ok", detail: `${map.prd.doc} ${firstTab}` });
    } catch (error) {
      results.push({ check: "PRD export", status: "fail", detail: error.message });
    }
  }
  results.push(...checkRepos(map));
  if (map.tracker?.instance) {
    try {
      const response = await fetch(map.tracker.instance, { method: "HEAD", redirect: "manual" });
      results.push({ check: "tracker", status: response.status < 500 ? "ok" : "fail", detail: `${map.tracker.instance} HTTP ${response.status}` });
    } catch (error) {
      results.push({ check: "tracker", status: "fail", detail: `${map.tracker.instance} unreachable: ${error.message}` });
    }
  }
  const ready = results.every((result) => result.status !== "fail");
  console.log(ready ? "READY" : "NOT_READY");
  for (const result of results) console.log(`${result.status} ${result.check}: ${result.detail}`);
  return ready ? 0 : 1;
}

async function main([command, cwd = process.cwd()]) {
  if (command === "doctor") return doctor(cwd);
  if (command === "discover") {
    console.log(JSON.stringify(discover(cwd), null, 1));
    return 0;
  }
  if (command === "resolve" || command === "missing") {
    const resolved = resolveMap(cwd);
    if (!resolved) {
      console.log(`no project map in ${PROJECTS_DIR} covers ${cwd}; run /tedy:setup`);
      return 1;
    }
    if (command === "resolve") {
      console.log(resolved.file);
      return 0;
    }
    const gaps = missingFields(resolved.map);
    console.log(`required: ${gaps.required.join(", ") || "none"}\noptional: ${gaps.optional.join(", ") || "none"}`);
    return gaps.required.length ? 1 : 0;
  }
  console.error("usage: project-map.mjs doctor|resolve|missing|discover [cwd]");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`project-map: ${error.message}`);
      process.exit(1);
    },
  );
}
