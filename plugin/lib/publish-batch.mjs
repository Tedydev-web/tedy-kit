import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDraft } from "./draft-lint.mjs";
import { chatLanguage, fill, labels } from "./labels.mjs";
import { KIT_PUBLISH_APPLY_VERBS, KIT_PUBLISH_WRITE_VERBS } from "./publish-approval-settings.mjs";

const SCRIPTS = fileURLToPath(new URL("../scripts/", import.meta.url));
const BOOLEAN_FLAGS = new Set(["apply", "delete", "dry-run", "summary"]);
const EXCERPT = 70;

const quote = (word) => (/^[\w./:=@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);
const clean = (text) => text.replace(/["`$\\]/g, "").replace(/\s+/g, " ").trim();
const excerpt = (text) => {
  const line = clean(String(text ?? "").split("\n").map((part) => part.trim()).find(Boolean) ?? "");
  return line.length > EXCERPT ? `${line.slice(0, EXCERPT - 1)}…` : line;
};
const quoted = (text) => (text ? ` «${text}»` : "");

function writeKind(script, verb) {
  if (KIT_PUBLISH_WRITE_VERBS[script]?.includes(verb)) return "write";
  if (KIT_PUBLISH_APPLY_VERBS[script]?.includes(verb)) return "apply";
  return null;
}

export function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (!word.startsWith("--")) positional.push(word);
    else if (word.includes("=")) flags[word.slice(2, word.indexOf("="))] = word.slice(word.indexOf("=") + 1);
    else if (BOOLEAN_FLAGS.has(word.slice(2)) || args[index + 1] === undefined || args[index + 1].startsWith("--")) flags[word.slice(2)] = true;
    else flags[word.slice(2)] = args[(index += 1)];
  }
  return { positional, flags };
}

function itemError(item) {
  if (!Array.isArray(item) || !item.length || !item.every((word) => typeof word === "string")) return "must be an array of strings";
  const [script, verb] = item;
  const kind = writeKind(script, verb);
  if (!kind) return `(${item.slice(0, 2).join(" ")}) is not a write of a kit writer, the only commands a batch may run`;
  if (kind === "apply" && !item.includes("--apply")) return "has no --apply, so it would not write";
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

function readText(dir, path) {
  try {
    return path ? readFileSync(resolve(dir, path), "utf8") : "";
  } catch {
    return "";
  }
}

function readJson(dir, path) {
  try {
    return JSON.parse(readText(dir, path));
  } catch {
    return null;
  }
}

function openprojectSummary(verb, positional, flags, body) {
  const [first, second] = positional;
  if (verb === "comment") return `OP #${first} comment${body}`;
  if (verb === "comment-edit") return `OP comment-edit ${first}${body}`;
  if (verb === "set") {
    const fields = Object.entries(flags).filter(([key]) => !["apply", "lock"].includes(key)).map(([key, value]) => `${key}=${value}`);
    return `OP #${first} set ${fields.join(", ")}`;
  }
  if (verb === "relation") return `OP #${first} ${flags.type ?? "relation"} #${second}`;
  if (verb === "relation-delete") return `OP relation-delete ${first}`;
  if (verb === "rollback") return `OP rollback${flags.delete ? " --delete" : ""}`;
  return null;
}

export function itemSummary(item, dir) {
  const [script, verb, ...rest] = item;
  const { positional, flags } = parseArgs(rest);
  const body = quoted(excerpt(readText(dir, flags["body-file"])));
  if (script === "openproject.mjs") {
    if (verb === "apply") {
      const drafts = readJson(dir, positional[0]);
      const list = Array.isArray(drafts) ? drafts : [];
      const shown = list.slice(0, 3).map((draft) => `${draft?.id ? `#${draft.id} ` : ""}«${excerpt(draft?.subject)}»`).join(", ");
      return `OP apply ${list.length} task ${shown}${list.length > 3 ? ", …" : ""}`.trim();
    }
    return openprojectSummary(verb, positional, flags, body) ?? `OP ${verb}`;
  }
  if (script === "figma-comments.mjs") {
    if (verb === "post") return `Figma ${flags.file ?? "?"} ${positional[0] ?? "?"} comment${body}`;
    return `Figma ${verb} ${positional[0] ?? "?"}${body}`;
  }
  if (script === "gdoc-comments.mjs") return `Doc ${verb}${positional[0] ? ` ${positional[0]}` : ""}${body}`;
  if (script === "doc-comment-file.mjs") {
    const items = readJson(dir, positional[0])?.items;
    const list = Array.isArray(items) ? items : [];
    return `Doc ${list.length} question${quoted(excerpt(list[0]?.comment))}`;
  }
  if (script === "github-write.mjs") {
    if (verb === "post") {
      let draft = null;
      try {
        draft = parseDraft(readText(dir, positional[0]));
      } catch {
        draft = null;
      }
      return draft ? `PR #${draft.pr} review ${draft.comments.length} comment${quoted(excerpt(draft.comments[0]?.body))}` : `PR review ${positional[0] ?? "?"}`;
    }
    if (["resolve", "unresolve", "minimize"].includes(verb)) return `PR ${verb} ${positional.length} thread`;
    if (verb === "pr-body") return `PR #${positional[0]} body${body}`;
    if (verb === "reply") return `PR #${positional[0]} reply${body}`;
    return `PR ${verb} ${positional[0] ?? ""}${body}`.trim();
  }
  return `${script} ${verb}`;
}

const language = () => {
  try {
    return chatLanguage();
  } catch {
    return "en";
  }
};

export const batchSummary = (items, dir, lang = language()) =>
  fill(labels(lang)["batch.summary"], { count: items.length, items: items.map((item, index) => `${index + 1}) ${clean(itemSummary(item, dir))}`).join("; ") });

export function shownSummary(words) {
  const at = words.indexOf("--shows");
  if (at !== -1) return words[at + 1] ?? "";
  const glued = words.find((word) => word.startsWith("--shows="));
  return glued === undefined ? null : glued.slice("--shows=".length);
}

export const SHOWS_REFUSAL = "--shows is not this batch's summary; run publish-batch.mjs <batch.json> --summary and pass the line it prints, unchanged, as --shows";

export function runBatch(items, { shows, summary, scriptsDir = SCRIPTS, out = process.stdout } = {}) {
  if (shows !== summary) {
    out.write(`publish-batch: ${SHOWS_REFUSAL}\nrefused by publish-batch: nothing was written\n`);
    return 2;
  }
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
  const { positional, flags } = parseArgs(argv);
  if (positional.length !== 1 || (!flags.summary && typeof flags.shows !== "string" && shownSummary(argv) === null)) {
    console.error('usage: publish-batch.mjs <batch.json> --summary | publish-batch.mjs <batch.json> --shows "<the line --summary printed>"\n  batch.json = { "items": [["openproject.mjs", "comment", "<id>", "--body-file", "<file>", "--apply"], …] }');
    process.exit(2);
  }
  const file = resolve(positional[0]);
  let items;
  try {
    items = readBatch(file);
  } catch (error) {
    console.error(`publish-batch: ${error.message}\nrefused by publish-batch: nothing was written`);
    process.exit(2);
  }
  const summary = batchSummary(items, process.cwd());
  if (flags.summary) {
    process.stdout.write(`${summary}\n\nnode ${quote(join(SCRIPTS, "publish-batch.mjs"))} ${quote(positional[0])} --shows "${summary}"\n`);
    process.exit(0);
  }
  process.exit(runBatch(items, { shows: shownSummary(argv), summary }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
