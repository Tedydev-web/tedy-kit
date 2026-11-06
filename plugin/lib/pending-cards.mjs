import { realpathSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "./handoff.mjs";
import { KIT_PUBLISH_APPLY_VERBS, KIT_PUBLISH_WRITE_VERBS } from "./publish-approval-settings.mjs";
import { jobFlag } from "./record-lock.mjs";
import { tokenize } from "./shell-segments.mjs";

const PLAIN_WORD = String.raw`(?:[\p{L}\p{N}\p{M}_@%+=:,./-]|'[^']*'|"[^"$\x60\\]*")+`;
const PLAIN_LINE = new RegExp(`^${PLAIN_WORD}(?: ${PLAIN_WORD})*$`, "u");

export const KINDS = Object.freeze(["publish", "question", "notify"]);
export const CARD_KEYS = Object.freeze(["kind", "title", "job", "draft", "draft-sha", "records", "preview", "created", "status", "answer", "refused"]);
const KEY_LINE = new RegExp(`^(${CARD_KEYS.join("|")}): `);
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

function blockRefusal(command, { preview, job }) {
  if (!command) return "has no command on its first line";
  if (!PLAIN_LINE.test(command)) return "is not plain words and quoted text: only letters, digits, _ @ % + = : , . / - outside quotes, '…' and \"…\" without $ ` \\ inside, one space between words (no operator, redirect, substitution, glob, brace, ~, # or <placeholder>)";
  const tokens = tokenize(command);
  if (tokens[0] !== "node") return "does not start with node";
  const name = basename(tokens[1] ?? "");
  const applied = KIT_PUBLISH_APPLY_VERBS[name] ?? [];
  const verbs = [...(KIT_PUBLISH_WRITE_VERBS[name] ?? []), ...applied];
  if (!verbs.length || !isAbsolute(tokens[1]) || realOrNull(tokens[1]) !== join(SCRIPTS, name)) return `does not run a kit publish script by its absolute path under ${SCRIPTS}`;
  if (!verbs.includes(tokens[2])) return `runs ${name} ${tokens[2] ?? "with no verb"}, which is not a write verb (${verbs.join(", ")})`;
  if (preview === "run" && tokens.some((token) => token === "--apply" || token.startsWith("--apply="))) return "holds --apply in a run block, which the cockpit runs before it asks";
  if (preview === "run" && !applied.includes(tokens[2])) return `runs ${name} ${tokens[2]}, which writes when run, so it cannot be a run block`;
  if (job !== "none") {
    let given;
    try {
      given = jobFlag(tokens.slice(3));
    } catch {
      given = undefined;
    }
    if (!given || basename(given) !== basename(job)) return `lacks --job ${basename(job)}`;
  }
  return null;
}

export function cardRefusal(card) {
  if (!KINDS.includes(card.kind)) return `unknown card kind ${card.kind}; use publish, question or notify`;
  if (!card.title) return "has no title";
  if (card.kind === "notify" && !card.body) return "has no text";
  if (card.kind === "question") {
    if (card.options.length < 2 || card.options.length > 4) return `a question card needs 2 to 4 option lines "- <label>: <consequence>", found ${card.options.length}`;
    if (!card.question) return "has no question text";
  }
  if (card.kind !== "publish") return null;
  if (card.preview !== "ready" && card.preview !== "run") return "a publish card needs preview: ready or preview: run";
  if (card.preview === "ready" && !card.draft) return "a preview: ready card needs draft:";
  if (card.preview === "ready" && !card["draft-sha"]) return "a preview: ready card needs draft-sha:; write it with pending.mjs card";
  if (!card.blocks.length) return "has no ### 1 block";
  for (const block of card.blocks) {
    const why = blockRefusal(block.command, card);
    if (why) return `block ${block.n} ${why}`;
  }
  return null;
}
