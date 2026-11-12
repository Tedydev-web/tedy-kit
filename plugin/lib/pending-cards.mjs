import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, readJob } from "./job-files.mjs";
import { KIT_PUBLISH_APPLY_VERBS, KIT_PUBLISH_WRITE_VERBS } from "./publish-approval-settings.mjs";
import { jobFlag } from "./record-lock.mjs";
import { tokenize } from "./shell-segments.mjs";

const PLAIN_WORD = String.raw`(?!(?:''|"")*=)(?:[\p{L}\p{N}\p{M}_@%+=:,./-]|'[^']*'|"[^"$\x60\\]*")+`;
const PLAIN_LINE = new RegExp(`^${PLAIN_WORD}(?: ${PLAIN_WORD})*$`, "u");

export const KINDS = Object.freeze(["publish", "question", "notify"]);
export const CARD_KEYS = Object.freeze(["kind", "title", "job", "draft", "draft-sha", "records", "preview", "created", "status", "started", "answer", "refused"]);
const KEY_LINE = new RegExp(`^(${CARD_KEYS.join("|")}): `);
const MERGE_BLOCK = /^gh pr merge \d+ --repo [\w.-]+\/[\w.-]+ --(?:merge|squash|rebase)$/;
const OPTION = /^- (.+?): (.+)$/;

const realOrNull = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const SCRIPTS = realpathSync(fileURLToPath(new URL("../scripts/", import.meta.url)));

export const oneLine = (value) => String(value).replace(/\s+/g, " ").trim();

export const headerLength = (lines) => {
  const end = lines.findIndex((line) => !KEY_LINE.test(line));
  return end === -1 ? lines.length : end;
};

export function readCard(text) {
  const fields = parse(text, CARD_KEYS);
  if (!fields.kind) return null;
  const lines = text.split("\n");
  const body = lines.slice(headerLength(lines)).join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
  const blocks = [];
  for (const line of body.split("\n")) {
    const heading = line.match(/^### (\d+)\s*$/);
    if (heading) blocks.push({ n: heading[1], lines: [] });
    else blocks.at(-1)?.lines.push(line);
  }
  const options = body.split("\n").filter((line) => OPTION.test(line)).map((line) => line.match(OPTION).slice(1, 3));
  return {
    ...fields,
    job: fields.job ?? "none",
    body,
    question: body.split("\n").filter((line) => !OPTION.test(line)).join("\n").trim(),
    options: options.map(([label, consequence]) => ({ label, consequence })),
    blocks: blocks.map(({ n, lines: kept }) => {
      const text = kept.join("\n").replace(/\s+$/, "");
      return { n, command: text.split("\n")[0].trim(), text };
    }),
  };
}

function blockRefusal(command, { preview, job }, draft) {
  if (!command) return "has no command on its first line";
  if (!PLAIN_LINE.test(command)) return "is not plain words and quoted text: only letters, digits, _ @ % + = : , . / - outside quotes, '…' and \"…\" without $ ` \\ inside, one space between words, no word starting with an unquoted = (no operator, redirect, substitution, glob, brace, ~, #, zsh =command or <placeholder>)";
  const tokens = tokenize(command);
  if (tokens[0] === "gh") {
    if (!MERGE_BLOCK.test(command)) return "is not exactly gh pr merge <n> --repo <owner/repo> --merge|--squash|--rebase, the one gh command a card may hold";
    return preview === "ready" ? null : "merges a PR, so it belongs on a preview: ready card";
  }
  if (tokens[0] !== "node") return "does not start with node";
  const name = basename(tokens[1] ?? "");
  const applied = KIT_PUBLISH_APPLY_VERBS[name] ?? [];
  const verbs = [...(KIT_PUBLISH_WRITE_VERBS[name] ?? []), ...applied];
  if (!verbs.length || !isAbsolute(tokens[1]) || realOrNull(tokens[1]) !== join(SCRIPTS, name)) return `does not run a kit publish script by its absolute path under ${SCRIPTS}`;
  if (!verbs.includes(tokens[2])) return `runs ${name} ${tokens[2] ?? "with no verb"}, which is not a write verb (${verbs.join(", ")})`;
  if (preview === "run" && tokens.some((token) => token === "--apply" || token.startsWith("--apply="))) return "holds --apply in a run block, which the cockpit runs before it asks";
  if (preview === "run" && !applied.includes(tokens[2])) return `runs ${name} ${tokens[2]}, which writes when run, so it cannot be a run block`;
  const flags = tokens.slice(3).filter((token) => token.startsWith("--")).map((token) => token.split("=")[0]);
  const repeated = flags.find((flag, index) => flags.indexOf(flag) !== index);
  if (repeated) return `repeats ${repeated}, and the script reads only one of them`;
  const glued = GLUED_FLAGS.has(name) ? undefined : tokens.slice(3).find((token) => /^--[^=]+=/.test(token) && !token.startsWith("--job="));
  if (glued) {
    const flag = glued.slice(0, glued.indexOf("="));
    return `glues ${flag}=, which ${name} does not read; write ${flag} and its value as two words`;
  }
  if (job !== "none") {
    let given;
    try {
      given = jobFlag(tokens.slice(3));
    } catch {
      given = undefined;
    }
    if (!given || basename(given) !== basename(job)) return `lacks --job ${basename(job)}`;
  }
  return draft ? draftRefusal(tokens, name, draft) : null;
}

const AFTER_VERB = "the file named right after the verb";

const FILE_OPERANDS = Object.freeze({
  "github-write.mjs": { post: AFTER_VERB, edit: "--body-file", reply: "--body-file", "pr-body": "--body-file" },
  "openproject.mjs": { apply: AFTER_VERB, comment: "--body-file", "comment-edit": "--body-file" },
  "figma-comments.mjs": { post: "--body-file", reply: "--body-file" },
  "gdoc-comments.mjs": { reply: "--body-file", anchor: "--body-file", edit: "--body-file" },
  "doc-comment-file.mjs": { post: AFTER_VERB },
});

function readsFile(command) {
  const [, script, verb] = tokenize(command);
  const name = basename(script ?? "");
  return FILE_OPERANDS[name]?.[verb] ? `${name} ${verb}` : null;
}

const OTHER_FILE_FLAGS =Object.freeze({ "doc-comment-file.mjs": ["--html"] });

const GLUED_FLAGS = new Set(["github-write.mjs"]);

function draftRefusal(tokens, name, draft) {
  const verb = tokens[2];
  const operand = FILE_OPERANDS[name]?.[verb];
  const words = tokens.map((token, index) => {
    const glued = token.startsWith("--") && token.includes("=");
    const owner = glued ? token.split("=")[0] : tokens[index - 1]?.startsWith("--") && !tokens[index - 1].includes("=") ? tokens[index - 1] : null;
    return { index, owner, value: glued ? token.slice(token.indexOf("=") + 1) : token };
  }).slice(3);
  const read = operand === AFTER_VERB ? words.find((word) => word.index === 3 && !tokens[3].startsWith("-")) : words.find((word) => word.owner === operand);
  if (!operand) return `does not read its draft ${draft.path}: ${name} ${verb} reads no file, so write the card without --draft`;
  if (!read || !isAbsolute(read.value) || realOrNull(read.value) !== draft.real) return `does not read its draft ${draft.path}: ${name} ${verb} reads ${operand === AFTER_VERB ? operand : `the file named by ${operand}`}, which must be the draft by its absolute path`;
  const skipped = ["--job", ...(OTHER_FILE_FLAGS[name] ?? [])];
  const second = words.find((word) => word !== read && !skipped.includes(word.owner) && isAbsolute(word.value) && realOrNull(word.value));
  return second ? `names a second file ${second.value}, which draft-sha: does not pin` : null;
}

function jobFileRefusal(path, root) {
  if (!existsSync(path)) return `its job file ${path} does not exist`;
  const jobs = realOrNull(join(root, "plans", "jobs"));
  if (!jobs || realOrNull(dirname(path)) !== jobs) return `its job file ${path} is not in ${join(root, "plans", "jobs")}`;
  try {
    readJob(path);
  } catch {
    return `its job file ${path} is not a job file`;
  }
  return null;
}

export function cardRefusal(card, root = process.cwd()) {
  if (!KINDS.includes(card.kind)) return `unknown card kind ${card.kind}; use publish, question or notify`;
  if (!card.title) return "has no title";
  if (card.job && card.job !== "none") {
    const why = jobFileRefusal(resolve(root, card.job), root);
    if (why) return why;
  }
  if (card.kind === "notify" && !card.body) return "has no text";
  if (card.kind === "question") {
    if (card.options.length < 2 || card.options.length > 4) return `a question card needs 2 to 4 option lines "- <label>: <consequence>", found ${card.options.length}`;
    if (!card.question) return "has no question text";
  }
  if (card.kind !== "publish") return null;
  if (card.preview !== "ready" && card.preview !== "run") return "a publish card needs preview: ready or preview: run";
  if (!card.blocks.length) return "has no ### 1 block";
  if (card.preview === "ready" && !card.draft) {
    const reader = card.blocks.find((block) => readsFile(block.command));
    if (reader) return `a preview: ready card needs draft: because block ${reader.n} runs ${readsFile(reader.command)}, which reads a file`;
  }
  if (card.preview === "ready" && card.draft && !card["draft-sha"]) return "a preview: ready card needs draft-sha:; write it with pending.mjs card";
  const draftPath = card.preview === "ready" && card.draft ? resolve(root, card.draft) : null;
  const draft = draftPath && { path: draftPath, real: realOrNull(draftPath) };
  if (draft && !draft.real) return `its draft ${draftPath} does not exist`;
  for (const block of card.blocks) {
    const why = blockRefusal(block.command, card, draft);
    if (why) return `block ${block.n} ${why}`;
  }
  return null;
}
