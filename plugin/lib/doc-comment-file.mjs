import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { lintChatComment } from "./draft-lint.mjs";
import { logPostedText } from "./edit-log.mjs";
import { findQuoteRange, insertAnchored, readDocument, recheckDocTarget, session } from "./gdoc-comments.mjs";
import { chatLanguage, fill, labels } from "./labels.mjs";
import { slugOf, stamp } from "./handoff.mjs";
import { fetchTab, quoteCount } from "./prd-section.mjs";
import { resolveMap } from "./project-map.mjs";
import { consumeApproval, requireExplicitTarget } from "./publish-approval-ticket.mjs";
import { approvalLines, renderDocComment } from "./publish-approval-render.mjs";
import { describePin, pinSourcesOf, recordPins, sayNotices } from "./source-pins.mjs";

const GROUPS = ["A", "B"];

const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function checkItems(items, tabsText, tabOf, lang) {
  const problems = [];
  items.forEach((item, index) => {
    const label = `#${index + 1} EPIC ${item.epic} · ${item.where}`;
    if (!GROUPS.includes(item.group)) problems.push(`${label}: group must be A or B`);
    const tab = tabOf(item.epic);
    if (!tab) {
      problems.push(`${label}: the map has no PRD tab for EPIC ${item.epic}`);
      return;
    }
    const count = quoteCount(item.quote ?? "", tabsText[tab] ?? "");
    if (count !== 1) problems.push(`${label}: the passage to highlight appears ${count} times in the latest PRD tab ${tab}; it must appear exactly once`);
    for (const problem of lintChatComment(item.comment ?? "", "doc", lang)) problems.push(`${label}: ${problem}`);
  });
  return problems;
}

export const commentLink = (doc, id) => `https://docs.google.com/document/d/${doc}/edit?disco=${id}`;

const done = (item, doc, text) =>
  item.posted
    ? `<label class=d><input type=checkbox checked disabled> ${escape(fill(text["doc.postedAt"], { at: item.posted.at }))} · <a href="${escape(commentLink(doc, item.posted.id))}">${escape(fill(text["doc.openComment"], { id: item.posted.id }))}</a></label>`
    : `<label class=d><input type=checkbox> ${escape(text["doc.done"])}</label>`;

function card(item, number, doc, text) {
  return `<article><div class=h><span class=k>${number}</span><b>EPIC ${escape(item.epic)} · ${escape(item.where)}</b><span class=s>${escape(item.note ?? "")}</span></div>
<label>${escape(text["doc.cardFind"])} <button onclick="cp(this)" data-t="${escape(item.quote)}">${escape(text["doc.copy"])}</button></label><pre class=a>${escape(item.quote)}</pre>
<label>${escape(text["doc.cardComment"])} <button onclick="cp(this)" data-t="${escape(item.comment.trim())}">${escape(text["doc.copy"])}</button></label><pre class=c>${escape(item.comment.trim())}</pre>
${done(item, doc, text)}</article>`;
}

export function renderFile({ title, doc, items, checkedAt, lang }) {
  const text = labels(lang);
  const ordered = ["A", "B"].flatMap((group) => items.filter((item) => item.group === group));
  const range = (group) => {
    const numbers = ordered.flatMap((item, index) => (item.group === group ? [index + 1] : []));
    return numbers.length ? `${numbers[0]}–${numbers.at(-1)}` : text["doc.none"];
  };
  const sections = ["A", "B"]
    .filter((group) => ordered.some((item) => item.group === group))
    .map((group) => `<h2>${escape(text[`doc.group${group}`])}</h2>${ordered.map((item, index) => (item.group === group ? card(item, index + 1, doc, text) : "")).join("")}`)
    .join("\n");
  return `<!doctype html><html lang=${escape(lang)}><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${escape(fill(text["doc.pageTitle"], { title }))}</title><style>
body{margin:0;background:#f6f5f2;color:#17211b;font:14px/1.55 system-ui,sans-serif}main{max-width:1000px;margin:auto;padding:24px 28px 60px}h1{font-size:21px;margin:0 0 6px}h2{font-size:16px;margin:26px 0 6px}
.note{background:#fff8ec;border:1px solid #f1d9b0;border-radius:10px;padding:10px 14px;margin:12px 0}ol li{margin:3px 0}
article{background:#fff;border:1px solid #e3e1dc;border-radius:12px;padding:14px 18px;margin:12px 0}.h{display:flex;gap:10px;align-items:center;margin-bottom:8px}.k{background:#17211b;color:#fff;border-radius:999px;padding:0 9px;font-weight:700}.s{margin-left:auto;color:#7a4fbf;font-size:12.5px;font-weight:600}
label{display:block;font-size:12.5px;color:#6b6f6c;margin-top:8px}pre{white-space:pre-wrap;margin:4px 0 0;padding:8px 10px;border-radius:8px;font:13px/1.5 ui-monospace,monospace}.a{background:#fff4d6;border:1px solid #f0d58a}.c{background:#eef6f0;border:1px solid #bfdcc8}
button{border:1px solid #d6d3cc;background:#fff;border-radius:6px;padding:1px 8px;cursor:pointer;font-size:12px;margin-left:6px}.d{color:#2e7d4f}
</style></head><body><main>
<h1>${escape(fill(text["doc.heading"], { title, count: ordered.length }))}</h1>
<div class=note>${escape(fill(text["doc.note"], { checkedAt, rangeA: range("A"), rangeB: range("B") }))}</div>
<h2>${escape(text["doc.howTo"])}</h2><ol>
${["doc.step1", "doc.step2", "doc.step3", "doc.step4", "doc.step5"].map((key) => `<li>${escape(fill(text[key], { doc }))}</li>`).join("\n")}
</ol>
${sections}
</main><script>function cp(b){navigator.clipboard.writeText(b.dataset.t);b.textContent=${JSON.stringify(text["doc.copied"])};}</script></body></html>
`;
}

export const pendingItems = (items) => items.filter((item) => !item.posted);

async function post(itemsFile, flags) {
  if (!itemsFile || !flags.html) {
    console.error("usage: doc-comment-file.mjs post <items.json> --html <pm-comments-….html> [--apply [--doc <prd doc id>]]");
    return 2;
  }
  const resolved = resolveMap(process.cwd());
  if (!resolved) throw new Error(`no project map covers ${process.cwd()}; run /tedy:setup`);
  const { map } = resolved;
  const data = JSON.parse(readFileSync(itemsFile, "utf8"));
  const tabOf = (epic) => map.prd?.tabs?.[epic]?.tab;
  const todo = pendingItems(data.items);
  const tabsText = {};
  for (const tab of new Set(todo.map((item) => tabOf(item.epic)).filter(Boolean))) tabsText[tab] = await fetchTab(map.prd.doc, tab);
  const problems = checkItems(todo, tabsText, tabOf, map.language?.doc_figma ?? chatLanguage());
  if (problems.length) {
    console.error(`doc-comment-file: nothing posted; fix these first:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    return 1;
  }
  console.log(approvalLines(todo.map((item) => renderDocComment(item, tabOf(item.epic)))));
  console.log(`WRITE → Google Doc ${map.prd.doc} : ${todo.length} anchored comments (${data.items.length - todo.length} already posted)`);
  if (!flags.apply) return 0;
  requireExplicitTarget("doc", flags.doc, { expected: map.prd.doc });
  const google = await session({ doc: map.prd.doc }, true);
  const notices = await recheckDocTarget(map.prd.doc, itemsFile, `doc-comment-file.mjs ${itemsFile}`, { texts: todo.map((item) => item.comment) });
  const document = await readDocument(google);
  const ranges = todo.map((item) => findQuoteRange(document, tabOf(item.epic), item.quote));
  consumeApproval(process.argv, todo.map((item) => renderDocComment(item, tabOf(item.epic))));
  sayNotices(notices);
  const save = () => {
    writeFileSync(itemsFile, `${JSON.stringify(data, null, 2)}\n`);
    const lang = chatLanguage();
    const checkedAt = new Date().toLocaleString(labels(lang)["doc.locale"], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    writeFileSync(flags.html, renderFile({ title: data.title, doc: map.prd.doc, items: data.items, checkedAt, lang }));
  };
  for (const [index, item] of todo.entries()) {
    const body = item.comment.trim();
    const id = await insertAnchored(google, ranges[index], body);
    item.posted = { id, at: new Date().toISOString() };
    logPostedText("doc-comment", itemsFile, id, body);
    save();
    console.log(`posted ${id} · EPIC ${item.epic} · ${item.where}`);
  }
  console.log(`posted and read back ${todo.length}/${todo.length}; ${flags.html} updated`);
  return 0;
}

const flagValue = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

async function main([itemsFile, ...rest]) {
  if (itemsFile === "post") return post(rest[0]?.startsWith("--") ? undefined : rest[0], { html: flagValue(rest, "--html"), doc: flagValue(rest, "--doc"), apply: rest.includes("--apply") });
  if (!itemsFile) {
    console.error('usage: doc-comment-file.mjs <items.json>   items.json = { "title": "...", "items": [{ "group": "A|B", "epic": "09", "where": "UC_SW_13 BR1", "quote": "...", "comment": "...", "note": "..." }] }');
    return 2;
  }
  const resolved = resolveMap(process.cwd());
  if (!resolved) throw new Error(`no project map covers ${process.cwd()}; run /tedy:setup`);
  const { map } = resolved;
  const text = readFileSync(itemsFile, "utf8");
  const { title, items } = JSON.parse(text);
  const tabOf = (epic) => map.prd?.tabs?.[epic]?.tab;
  const tabsText = {};
  for (const tab of new Set(items.map((item) => tabOf(item.epic)).filter(Boolean))) tabsText[tab] = await fetchTab(map.prd.doc, tab);
  const lang = chatLanguage();
  const checkedAt = new Date().toLocaleString(labels(lang)["doc.locale"], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const problems = checkItems(items, tabsText, tabOf, map.language?.doc_figma ?? chatLanguage());
  if (problems.length) {
    console.error(`doc-comment-file: no file written; fix these first:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    return 1;
  }
  const comments = items.map((item) => item.comment ?? "");
  const taken = await pinSourcesOf(comments.join("\n"), { docs: [map.prd.doc] });
  for (const problem of taken.problems) console.log(`sources: ${problem}`);
  if (taken.problems.length) return 1;
  const pins = await recordPins(itemsFile, text, taken.pins, { pinnedAt: flagValue(rest, "--pinned-at"), texts: comments });
  if (!pins) return 1;
  for (const each of pins) console.log(describePin(each));
  const dir = join(map.paths[0], "plans", "drafts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `pm-comments-${stamp()}-${slugOf(title)}.html`);
  writeFileSync(path, renderFile({ title, doc: map.prd.doc, items, checkedAt, lang }));
  console.log(path);
  return 0;
}

export function run() {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`doc-comment-file: ${error.message}`);
      process.exit(1);
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
