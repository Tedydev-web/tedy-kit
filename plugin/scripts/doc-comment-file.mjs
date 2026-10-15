import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { lintChatComment } from "./draft-lint.mjs";
import { logPostedText } from "./edit-log.mjs";
import { anchorComment, session } from "./gdoc-comments.mjs";
import { slugOf, stamp } from "./handoff.mjs";
import { fetchTab, quoteCount } from "./prd-section.mjs";
import { resolveMap } from "./project-map.mjs";

const GROUPS = {
  A: "Nhóm A — câu hỏi mới",
  B: "Nhóm B — PM đã trả lời trong comment nhưng PRD chưa ghi, hoặc PRD tự mâu thuẫn",
};

const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function checkItems(items, tabsText, tabOf) {
  const problems = [];
  items.forEach((item, index) => {
    const label = `#${index + 1} EPIC ${item.epic} · ${item.where}`;
    if (!GROUPS[item.group]) problems.push(`${label}: group must be A or B`);
    const tab = tabOf(item.epic);
    if (!tab) {
      problems.push(`${label}: the map has no PRD tab for EPIC ${item.epic}`);
      return;
    }
    const count = quoteCount(item.quote ?? "", tabsText[tab] ?? "");
    if (count !== 1) problems.push(`${label}: the passage to highlight appears ${count} times in the latest PRD tab ${tab}; it must appear exactly once`);
    for (const problem of lintChatComment(item.comment ?? "", "doc")) problems.push(`${label}: ${problem}`);
  });
  return problems;
}

export const commentLink = (doc, id) => `https://docs.google.com/document/d/${doc}/edit?disco=${id}`;

const done = (item, doc) =>
  item.posted
    ? `<label class=d><input type=checkbox checked disabled> Đã comment lúc ${escape(item.posted.at)} · <a href="${escape(commentLink(doc, item.posted.id))}">mở comment ${escape(item.posted.id)}</a></label>`
    : `<label class=d><input type=checkbox> Đã comment</label>`;

function card(item, number, doc) {
  return `<article><div class=h><span class=k>${number}</span><b>EPIC ${escape(item.epic)} · ${escape(item.where)}</b><span class=s>${escape(item.note ?? "")}</span></div>
<label>1. Ctrl+F dán đoạn này, bôi đen đúng đoạn tìm thấy <button onclick="cp(this)" data-t="${escape(item.quote)}">Copy</button></label><pre class=a>${escape(item.quote)}</pre>
<label>2. Comment ▸ dán nội dung <button onclick="cp(this)" data-t="${escape(item.comment.trim())}">Copy</button></label><pre class=c>${escape(item.comment.trim())}</pre>
${done(item, doc)}</article>`;
}

export function renderFile({ title, doc, items, checkedAt }) {
  const ordered = ["A", "B"].flatMap((group) => items.filter((item) => item.group === group));
  const range = (group) => {
    const numbers = ordered.flatMap((item, index) => (item.group === group ? [index + 1] : []));
    return numbers.length ? `${numbers[0]}–${numbers.at(-1)}` : "không có";
  };
  const sections = ["A", "B"]
    .filter((group) => ordered.some((item) => item.group === group))
    .map((group) => `<h2>${GROUPS[group]}</h2>${ordered.map((item, index) => (item.group === group ? card(item, index + 1, doc) : "")).join("")}`)
    .join("\n");
  return `<!doctype html><html lang=vi><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${escape(title)} — comment PRD chờ anh bôi đen</title><style>
body{margin:0;background:#f6f5f2;color:#17211b;font:14px/1.55 system-ui,sans-serif}main{max-width:1000px;margin:auto;padding:24px 28px 60px}h1{font-size:21px;margin:0 0 6px}h2{font-size:16px;margin:26px 0 6px}
.note{background:#fff8ec;border:1px solid #f1d9b0;border-radius:10px;padding:10px 14px;margin:12px 0}ol li{margin:3px 0}
article{background:#fff;border:1px solid #e3e1dc;border-radius:12px;padding:14px 18px;margin:12px 0}.h{display:flex;gap:10px;align-items:center;margin-bottom:8px}.k{background:#17211b;color:#fff;border-radius:999px;padding:0 9px;font-weight:700}.s{margin-left:auto;color:#7a4fbf;font-size:12.5px;font-weight:600}
label{display:block;font-size:12.5px;color:#6b6f6c;margin-top:8px}pre{white-space:pre-wrap;margin:4px 0 0;padding:8px 10px;border-radius:8px;font:13px/1.5 ui-monospace,monospace}.a{background:#fff4d6;border:1px solid #f0d58a}.c{background:#eef6f0;border:1px solid #bfdcc8}
button{border:1px solid #d6d3cc;background:#fff;border-radius:6px;padding:1px 8px;cursor:pointer;font-size:12px;margin-left:6px}.d{color:#2e7d4f}
</style></head><body><main>
<h1>${escape(title)} — comment cần anh tự bôi đen (${ordered.length} cái)</h1>
<div class=note>Kiểm lúc ${escape(checkedAt)} trên PRD tải về ngay lúc đó: mọi đoạn bôi đen có trong PRD đúng 1 lần. Nhóm A (${range("A")}): câu hỏi mới. Nhóm B (${range("B")}): PM đã trả lời trong comment nhưng PRD chưa ghi, hoặc PRD tự mâu thuẫn.</div>
<h2>Cách làm</h2><ol>
<li>Mở PRD: docs.google.com/document/d/${escape(doc)}.</li>
<li>Với từng thẻ: bấm Copy ở ô vàng → Ctrl+F trong Doc → dán → Enter để nhảy tới đoạn đó.</li>
<li>Bôi đen đúng đoạn vừa tìm (đủ câu là được, không cần hết đoạn văn).</li>
<li>Ctrl+Alt+M (hoặc nút Comment) → bấm Copy ở ô xanh → dán → Comment. Không tag ai.</li>
<li>Tick "Đã comment" để đánh dấu.</li>
</ol>
${sections}
</main><script>function cp(b){navigator.clipboard.writeText(b.dataset.t);b.textContent='Đã copy';}</script></body></html>
`;
}

export const pendingItems = (items) => items.filter((item) => !item.posted);

async function post(itemsFile, flags) {
  if (!itemsFile || !flags.html) {
    console.error("usage: doc-comment-file.mjs post <items.json> --html <pm-comments-….html> [--apply]");
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
  const problems = checkItems(todo, tabsText, tabOf);
  if (problems.length) {
    console.error(`doc-comment-file: nothing posted; fix these first:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    return 1;
  }
  for (const item of todo) console.log(`- EPIC ${item.epic} · ${item.where} · tab ${tabOf(item.epic)}\n  [${item.quote.slice(0, 80)}]\n  ${item.comment.trim().replace(/\s+/g, " ")}`);
  console.log(`WRITE → Google Doc ${map.prd.doc} : ${todo.length} anchored comments (${data.items.length - todo.length} already posted)`);
  if (!flags.apply) return 0;
  const google = await session({ doc: map.prd.doc }, true);
  const save = () => {
    writeFileSync(itemsFile, `${JSON.stringify(data, null, 2)}\n`);
    const checkedAt = new Date().toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    writeFileSync(flags.html, renderFile({ title: data.title, doc: map.prd.doc, items: data.items, checkedAt }));
  };
  for (const item of todo) {
    const body = item.comment.trim();
    const id = await anchorComment(google, tabOf(item.epic), item.quote, body);
    item.posted = { id, at: new Date().toISOString() };
    logPostedText("doc-comment", itemsFile, id, body);
    save();
    console.log(`posted ${id} · EPIC ${item.epic} · ${item.where}`);
  }
  console.log(`posted and read back ${todo.length}/${todo.length}; ${flags.html} updated`);
  return 0;
}

async function main([itemsFile, ...rest]) {
  if (itemsFile === "post") {
    const html = rest.includes("--html") ? rest[rest.indexOf("--html") + 1] : undefined;
    return post(rest[0]?.startsWith("--") ? undefined : rest[0], { html, apply: rest.includes("--apply") });
  }
  if (!itemsFile) {
    console.error('usage: doc-comment-file.mjs <items.json>   items.json = { "title": "...", "items": [{ "group": "A|B", "epic": "09", "where": "UC_SW_13 BR1", "quote": "...", "comment": "...", "note": "..." }] }');
    return 2;
  }
  const resolved = resolveMap(process.cwd());
  if (!resolved) throw new Error(`no project map covers ${process.cwd()}; run /tedy:setup`);
  const { map } = resolved;
  const { title, items } = JSON.parse(readFileSync(itemsFile, "utf8"));
  const tabOf = (epic) => map.prd?.tabs?.[epic]?.tab;
  const tabsText = {};
  for (const tab of new Set(items.map((item) => tabOf(item.epic)).filter(Boolean))) tabsText[tab] = await fetchTab(map.prd.doc, tab);
  const checkedAt = new Date().toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const problems = checkItems(items, tabsText, tabOf);
  if (problems.length) {
    console.error(`doc-comment-file: no file written; fix these first:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    return 1;
  }
  const dir = join(map.paths[0], "plans", "reports");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `pm-comments-${stamp()}-${slugOf(title)}.html`);
  writeFileSync(path, renderFile({ title, doc: map.prd.doc, items, checkedAt }));
  console.log(path);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`doc-comment-file: ${error.message}`);
      process.exit(1);
    },
  );
}
