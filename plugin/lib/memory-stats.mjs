import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CLAUDE_SETTINGS } from "../gates/git-gate.mjs";
import { resolveMap } from "./project-map.mjs";
import { readState } from "./project-state.mjs";

export const PROJECTS_ROOT = join(homedir(), ".claude", "projects");
const TYPE_LINE = /^\s*type:\s*([a-z]+)\s*$/m;

export const projectSlug = (path) => path.replace(/[^A-Za-z0-9]/g, "-");

export function sinceMark(since) {
  if (!since) return () => true;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(since);
  if (day) {
    const start = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
    return (mtimeMs) => mtimeMs >= start;
  }
  const at = Date.parse(since);
  if (Number.isNaN(at)) throw new Error(`since is not a date: ${since}`);
  return (mtimeMs) => mtimeMs > at;
}

export function layoutOverride(env = process.env, settings = CLAUDE_SETTINGS) {
  if (env.CLAUDE_CODE_PROJECT_DIR_NAME) return "CLAUDE_CODE_PROJECT_DIR_NAME";
  try {
    return JSON.parse(readFileSync(settings, "utf8")).autoMemoryDirectory ? "autoMemoryDirectory" : null;
  } catch {
    return null;
  }
}

function projectSlugs(map) {
  const root = map.paths[0];
  const paths = [root, ...(map.repos ?? []).map((repo) => (isAbsolute(repo.path) ? repo.path : resolve(root, repo.path)))];
  return [...new Set(paths.map((path) => projectSlug(resolve(path))))];
}

const list = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const HEAD_BYTES = 4096;

function head(path) {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    return buffer.subarray(0, readSync(descriptor, buffer, 0, HEAD_BYTES, 0)).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

const frontmatter = (text) => (text.startsWith("---") ? text.slice(3, text.indexOf("\n---", 3) + 1) : "");

export function memoryStats(map, since, root = PROJECTS_ROOT) {
  const isNewer = sinceMark(since);
  const slugs = projectSlugs(map);
  const stats = { dirs: [], memories: 0, newer: 0, feedback: 0, feedbackNewer: 0, typed: 0, skipped: 0, sessions: 0 };
  for (const slug of slugs) {
    const dir = join(root, slug, "memory");
    if (!existsSync(dir)) continue;
    stats.dirs.push(dir);
    for (const entry of list(dir)) {
      if (!entry.name.endsWith(".md") || entry.name === "MEMORY.md") continue;
      if (!entry.isFile()) {
        stats.skipped += 1;
        continue;
      }
      const path = join(dir, entry.name);
      let text;
      let mtimeMs;
      try {
        text = head(path);
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        stats.skipped += 1;
        continue;
      }
      const type = TYPE_LINE.exec(frontmatter(text))?.[1];
      const newer = isNewer(mtimeMs);
      stats.memories += 1;
      stats.newer += newer ? 1 : 0;
      stats.typed += type ? 1 : 0;
      stats.feedback += type === "feedback" ? 1 : 0;
      stats.feedbackNewer += type === "feedback" && newer ? 1 : 0;
    }
  }
  const folders = list(root).filter((entry) => entry.isDirectory() && slugs.some((slug) => entry.name === slug || entry.name.startsWith(`${slug}--claude-worktrees-`) || entry.name.startsWith(`${slug}--worktrees-`)));
  for (const folder of folders) {
    for (const entry of list(join(root, folder.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        if (isNewer(statSync(join(root, folder.name, entry.name)).mtimeMs)) stats.sessions += 1;
      } catch {
        stats.skipped += 1;
      }
    }
  }
  return stats;
}

function main(argv) {
  const flag = argv.indexOf("--since");
  if (argv.length && (flag !== 0 || argv.length !== 2)) {
    process.stderr.write("usage: memory-stats.mjs [--since <YYYY-MM-DD | ISO timestamp>]\n");
    return 2;
  }
  const resolved = resolveMap(process.cwd());
  if (!resolved) {
    process.stderr.write(`no project map covers ${process.cwd()}; run /tedy:setup\n`);
    return 1;
  }
  const override = layoutOverride();
  if (override) {
    process.stderr.write(`auto memory is moved by ${override}; memory-stats reads only the default layout\n`);
    return 1;
  }
  const since = flag === 0 ? argv[1] : readState(resolved.map.name).learned_until ?? "";
  try {
    process.stdout.write(`${JSON.stringify({ map: resolved.map.name, since, ...memoryStats(resolved.map, since) }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

export function run() {
  process.exit(main(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
