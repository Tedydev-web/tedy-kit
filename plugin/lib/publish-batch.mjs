import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BATCH_VERBS = Object.freeze({
  "openproject.mjs": Object.freeze(["comment", "comment-edit"]),
  "figma-comments.mjs": Object.freeze(["post", "reply"]),
  "gdoc-comments.mjs": Object.freeze(["reply", "anchor", "edit"]),
  "github-write.mjs": Object.freeze(["post", "reply", "resolve", "unresolve", "minimize"]),
});

const SCRIPTS = fileURLToPath(new URL("../scripts/", import.meta.url));
const ALLOWED = Object.entries(BATCH_VERBS).map(([script, verbs]) => `${script} ${verbs.join("|")}`).join(", ");
const quote = (word) => (/^[\w./:=@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);

function itemError(item) {
  if (!Array.isArray(item) || !item.length || !item.every((word) => typeof word === "string")) return "must be an array of strings";
  const [script, verb] = item;
  if (!BATCH_VERBS[script]?.includes(verb)) return `(${item.slice(0, 2).join(" ")}) is not a comment write a batch may run; allowed: ${ALLOWED}`;
  if (script === "openproject.mjs" && !item.includes("--apply")) return "has no --apply, so it would not write";
  if (item.includes("--dry-run")) return "is a dry run, so it would not write";
  return null;
}

export function readBatch(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not readable as JSON (${error.code ?? error.name})`);
  }
  const items = data?.items;
  if (!Array.isArray(items) || !items.length) throw new Error(`${file} needs a non-empty "items" array`);
  items.forEach((item, index) => {
    const error = itemError(item);
    if (error) throw new Error(`item ${index + 1} ${error}`);
  });
  return items;
}

export const itemCommand = (item) => `node ${quote(join(SCRIPTS, item[0]))} ${item.slice(1).map(quote).join(" ")}`;

function firstLine(item, dir) {
  const at = item.indexOf("--body-file");
  if (at === -1 || !item[at + 1]) return "";
  try {
    return readFileSync(resolve(dir, item[at + 1]), "utf8").split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 80) ?? "";
  } catch {
    return "";
  }
}

export function itemSummary(item, dir) {
  const [script, verb, target] = item;
  const where = target && !target.startsWith("-") ? ` ${target.includes("/") ? basename(target) : target}` : "";
  const line = firstLine(item, dir);
  return `${script.replace(/\.mjs$/, "")} ${verb}${where}${line ? `: «${line}»` : ""}`;
}

export function runBatch(items, { scriptsDir = SCRIPTS, out = process.stdout } = {}) {
  for (const [index, item] of items.entries()) {
    out.write(`[${index + 1}/${items.length}] ${item.slice(0, 3).join(" ")}\n`);
    try {
      execFileSync(process.execPath, [join(scriptsDir, item[0]), ...item.slice(1)], { stdio: "inherit" });
    } catch (error) {
      const left = items.length - index - 1;
      const rest = left === 0 ? "no item was left" : left === 1 ? `item ${index + 2} was not run` : `items ${index + 2}-${items.length} were not run`;
      out.write(`publish-batch: item ${index + 1} of ${items.length} failed (exit ${error.status ?? "?"}); ${index} item${index === 1 ? "" : "s"} ran before it; ${rest}\n`);
      return 1;
    }
  }
  out.write(`publish-batch: all ${items.length} items ran\n`);
  return 0;
}

export function run() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) {
    console.error('usage: publish-batch.mjs <batch.json>   batch.json = { "items": [["openproject.mjs", "comment", "<id>", "--body-file", "<file>", "--apply"], …] }');
    process.exit(2);
  }
  let items;
  try {
    items = readBatch(resolve(argv[0]));
  } catch (error) {
    console.error(`publish-batch: ${error.message}\nrefused by publish-batch: nothing was written`);
    process.exit(2);
  }
  process.exit(runBatch(items));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
