import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { redact, REQUEST_TIMEOUT_MS, requestJson, send } from "./api-request.mjs";
import { lintChatComment, mapLanguage } from "./draft-lint.mjs";
import { logPostedText } from "./edit-log.mjs";
import { canonicalJson } from "./figma-comments.mjs";
import { resolveMap } from "./project-map.mjs";
import { consumeApproval, requireExplicitTarget } from "./publish-approval-ticket.mjs";
import { notBefore, sinceTime } from "./since.mjs";
import { requireFresh, sayNotices, versionCheck } from "./source-pins.mjs";

const DRIVE = "https://www.googleapis.com/drive/v3";
const DOCS = "https://docs.googleapis.com/v1";
const COMMENT_FIELDS = "id,content,createdTime,modifiedTime,resolved,anchor,author(displayName,me),quotedFileContent(value),replies(id,content,createdTime,deleted,author(displayName,me))";
const OWN_CLIENT_STEPS = "anchored comments need your own Google OAuth client; until then write the question into the HTML hand-off file described in comment-channels.md. To enable anchoring: create a Desktop OAuth client with the Drive and Docs APIs enabled, then `rclone config update gdrive client_id=… client_secret=…` and `rclone config reconnect gdrive:` (plugin/skills/pm/references/comment-channels.md)";

export function tokenFromDump(dumpText, remote) {
  const config = JSON.parse(dumpText)[remote];
  if (!config) throw new Error(`no rclone remote "${remote}"`);
  const token = JSON.parse(config.token);
  return { access: token.access_token, refresh: token.refresh_token, expiry: Date.parse(token.expiry), clientId: config.client_id ?? "", clientSecret: config.client_secret ?? "" };
}

export function findQuoteRange(document, tabId, quote) {
  const allTabs = (tabs) => tabs.flatMap((candidate) => [candidate, ...allTabs(candidate.childTabs ?? [])]);
  const tab = allTabs(document.tabs ?? []).find((candidate) => candidate.tabProperties?.tabId === tabId);
  if (!tab) throw new Error(`tab ${tabId} not found in the document`);
  const paragraphs = (content) =>
    content.flatMap((block) =>
      block.paragraph
        ? [block.paragraph]
        : block.table
          ? block.table.tableRows.flatMap((row) => row.tableCells.flatMap((cell) => paragraphs(cell.content ?? [])))
          : paragraphs(block.tableOfContents?.content ?? []),
    );
  const runs = paragraphs(tab.documentTab.body.content ?? []).flatMap((paragraph) => (paragraph.elements ?? []).filter((element) => element.textRun));
  let text = "";
  const starts = [];
  for (const run of runs) {
    starts.push({ offset: text.length, index: run.startIndex });
    text += run.textRun.content;
  }
  const words = quote.trim().split(/\s+/).filter(Boolean).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const hits = words.length ? [...text.matchAll(new RegExp(words.join("[^\\S\\n]+"), "gi"))] : [];
  if (!hits.length) throw new Error(`quote not found in tab ${tabId}: "${quote.slice(0, 60)}"`);
  if (hits.length > 1) throw new Error(`quote appears ${hits.length} times in tab ${tabId}; quote a longer passage`);
  const indexAt = (offset) => {
    const run = starts.filter((start) => start.offset <= offset).at(-1);
    return run.index + (offset - run.offset);
  };
  const [hit] = hits;
  return { startIndex: indexAt(hit.index), endIndex: indexAt(hit.index + hit[0].length - 1) + 1, tabId };
}

export function rclone(args, { timeout = REQUEST_TIMEOUT_MS } = {}) {
  try {
    return execFileSync("rclone", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout });
  } catch (error) {
    if (error.code === "ETIMEDOUT") throw new Error(`rclone ${args.join(" ")} timed out after ${timeout / 1000} s; check the network and rclone listremotes`);
    throw error;
  }
}

export async function accessToken(remote, needOwnClient, { timeout } = {}) {
  const dump = () => tokenFromDump(rclone(["config", "dump"]), remote);
  let token = dump();
  if (needOwnClient && !token.clientId) throw new Error(OWN_CLIENT_STEPS);
  if (token.clientId) {
    const body = new URLSearchParams({ client_id: token.clientId, client_secret: token.clientSecret, refresh_token: token.refresh, grant_type: "refresh_token" });
    const { response, text } = await send("https://oauth2.googleapis.com/token", { method: "POST", body }, timeout);
    if (!response.ok) throw new Error(`token refresh returned HTTP ${response.status}; run rclone config reconnect ${remote}:`);
    return { bearer: JSON.parse(text).access_token, ownClient: true };
  }
  if (!(token.expiry > Date.now() + 60_000)) {
    rclone(["lsjson", `${remote}:`, "--max-depth", "1", "--dirs-only"]);
    token = dump();
  }
  return { bearer: token.access, ownClient: false };
}

export async function session(flags, needOwnClient = false) {
  const doc = flags.doc ?? resolveMap(process.cwd())?.map.prd?.doc;
  if (!doc) throw new Error("no --doc and no prd.doc in the project map");
  const { bearer, ownClient } = await accessToken(flags.remote ?? "gdrive", needOwnClient);
  return { doc, bearer, ownClient, request: (url, options = {}) => requestJson(url, { ...options, headers: { Authorization: `Bearer ${bearer}` } }) };
}

const NOT_CONTENT = (key, parent) => ["revisionId", "namedRanges", "commentAnchors"].includes(key) || /^suggest(?:ed|ion)/.test(key) || (parent === "imageProperties" && key === "contentUri");

const contentOf = (node, parent) => (Array.isArray(node) ? node.map((item) => contentOf(item, parent)) : node && typeof node === "object" ? Object.fromEntries(Object.entries(node).flatMap(([key, value]) => (NOT_CONTENT(key, parent) ? [] : [[key, contentOf(value, key)]]))) : node);

const tabsContent = (tabs) => tabs.map((tab) => ({ tabId: tab.tabProperties?.tabId, content: contentOf(tab.documentTab ?? {}), childTabs: tabsContent(tab.childTabs ?? []) }));

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const LABEL = /^\[([a-z]{1,3})\]/;

export function exportWithoutComments(text, comments) {
  const listed = new Set(comments.flatMap((comment) => [comment, ...(comment.replies ?? [])]).map((item) => squash(item.content ?? "")).filter(Boolean));
  const lines = text.trimEnd().split(/\r?\n/);
  const start = lines.findLastIndex((line, index) => index > 0 && !lines[index - 1].trim() && LABEL.test(line));
  if (start < 0) return lines.join("\n");
  const entries = [];
  for (const line of lines.slice(start)) {
    if (LABEL.test(line)) entries.push([line]);
    else entries.at(-1).push(line);
  }
  const body = lines.slice(0, start);
  const marked = body.join("\n");
  const commented = entries.filter((entry) => marked.includes(entry[0].match(LABEL)[0]));
  const dropped = commented.filter((entry) => listed.has(squash(entry.join("\n").replace(LABEL, ""))));
  const labelOf = (entry) => entry[0].match(LABEL)[1];
  const gone = new Set(dropped.map(labelOf));
  const unmatched = new Set(commented.filter((entry) => !dropped.includes(entry)).map(labelOf));
  return [...body, ...entries.filter((entry) => !dropped.includes(entry)).flat()]
    .join("\n")
    .replace(/\[([a-z]{1,3})\]/g, (marker, label) => (gone.has(label) ? "" : unmatched.has(label) ? "[?]" : marker))
    .trimEnd();
}

const TEXT_READERS = {
  "docs-text": async (google) => {
    const document = await google.request(`${DOCS}/documents/${google.doc}?includeTabsContent=true&suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`);
    if (!Array.isArray(document?.tabs)) throw new Error("the Docs API returned no tabs");
    return sha256(canonicalJson(tabsContent(document.tabs)));
  },
  "drive-export": async (google) => {
    const text = await google.request(`${DRIVE}/files/${google.doc}/export?mimeType=text/plain`, { as: "text" });
    if (typeof text !== "string") throw new Error("the Drive export returned no text");
    return sha256(exportWithoutComments(text, await listComments(google)));
  },
};

export async function gdocPin(google) {
  const failures = [];
  if (google.ownClient) {
    try {
      return { kind: "gdoc", doc: google.doc, method: "docs-text", text: await TEXT_READERS["docs-text"](google) };
    } catch (error) {
      if (error.status !== 403 || error.quota) throw new Error(`refused: the text of Google Doc ${google.doc} could not be read through docs-text (${error.message}), so its pin cannot be taken`);
      failures.push(`docs-text: ${error.message}`);
    }
  }
  try {
    return { kind: "gdoc", doc: google.doc, method: "drive-export", text: await TEXT_READERS["drive-export"](google) };
  } catch (error) {
    failures.push(`drive-export: ${error.message}`);
  }
  throw new Error(`refused: the text of Google Doc ${google.doc} could not be read (${failures.join("; ")}), so its pin cannot be taken`);
}

export async function recheckGdoc(google, pin) {
  if (typeof pin.text !== "string" || !Object.hasOwn(TEXT_READERS, pin.method ?? "")) return { refusal: `refused: the pin of Google Doc ${pin.doc} predates text pins; lint the draft again and ask the user again` };
  let now;
  try {
    now = await TEXT_READERS[pin.method](google);
  } catch (error) {
    throw new Error(`refused: the text of Google Doc ${pin.doc} could not be read through ${pin.method} (${error.message}), so its pin cannot be checked`);
  }
  if (now === pin.text) return {};
  return versionCheck(`Google Doc ${pin.doc} text`, pin.text.slice(0, 12), now.startsWith(pin.text.slice(0, 12)) ? now : now.slice(0, 12));
}

const DOC_MIME = "application/vnd.google-apps.document";

async function driveVersion(google) {
  const file = await google.request(`${DRIVE}/files/${google.doc}?fields=mimeType,md5Checksum,modifiedTime&supportsAllDrives=true`);
  if (file?.mimeType === DOC_MIME) return null;
  if (typeof file?.md5Checksum === "string") return `md5 ${file.md5Checksum}`;
  if (typeof file?.modifiedTime === "string") return `modified ${file.modifiedTime}`;
  throw new Error(`Drive file ${google.doc} has no md5Checksum and no modifiedTime`);
}

export async function drivePin(google) {
  const version = await driveVersion(google);
  return version === null ? gdocPin(google) : { kind: "drive", file: google.doc, version };
}

export async function recheckDrive(google, pin) {
  if (typeof pin.version !== "string") return { refusal: `refused: the pin of Drive file ${pin.file} has no version; lint the draft again and ask the user again` };
  return versionCheck(`Drive file ${pin.file}`, pin.version, (await driveVersion(google)) ?? "a Google Doc");
}

export const recheckDocTarget = (doc, file, relint, { texts } = {}) => requireFresh(file, relint, { texts, covers: (pin) => pin.kind === "gdoc" && pin.doc === doc, what: `text of Google Doc ${doc}` });

const relintDoc = (file, doc) => `draft-lint.mjs doc-comment ${file} --doc ${doc}`;

const readBody = (flags) => {
  const body = readFileSync(flags["body-file"], "utf8").trim();
  const problems = lintChatComment(body, "doc", mapLanguage("doc_figma"));
  if (problems.length) throw new Error(`comment not posted: ${problems.join("; ")}`);
  return body;
};

const squash = (text) => text.replace(/\s+/g, " ").trim();

export const alreadyPosted = (comments, command, target, body) =>
  command === "reply"
    ? comments.some((comment) => comment.id === target && comment.replies.some((reply) => squash(reply.content) === squash(body)))
    : comments.some((comment) => !comment.resolved && squash(comment.content) === squash(body));

export function editTarget(comments, commentId, replyId) {
  const comment = comments.find((candidate) => candidate.id === commentId);
  if (!comment) throw new Error(`no comment ${commentId} in the Doc`);
  const item = replyId ? comment.replies.find((reply) => reply.id === replyId) : comment;
  if (!item) throw new Error(`no reply ${replyId} in thread ${commentId}`);
  if (!item.author.me) throw new Error(`${replyId ? "reply" : "comment"} by ${item.author.displayName}, not by this account; only your own text can be edited`);
  return item;
}

export const revisionsSince = (revisions, since) => (since ? revisions.filter((revision) => notBefore(revision.modifiedTime, since)) : revisions);

export function deleteTarget(comments, commentId, replyId) {
  const item = editTarget(comments, commentId, replyId);
  const others = replyId ? [] : item.replies.filter((reply) => !reply.deleted && !reply.author.me);
  if (others.length) throw new Error(`thread ${commentId} has ${others.length} replies by others that would be deleted with it; delete your own replies instead`);
  return item;
}

export const stillThere = (comments, commentId, replyId) => {
  const comment = comments.find((candidate) => candidate.id === commentId);
  return Boolean(comment && (!replyId || comment.replies.some((reply) => reply.id === replyId && !reply.deleted)));
};

export const readDocument = (google) => google.request(`${DOCS}/documents/${google.doc}?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE`);

export async function anchorComment(google, tab, quote, body, beforeWrite = () => {}) {
  const range = findQuoteRange(await readDocument(google), tab, quote);
  beforeWrite();
  return insertAnchored(google, range, body);
}

export async function insertAnchored(google, range, body) {
  console.log(`WRITE → Google Doc ${google.doc} tab ${range.tabId} : 1 comment anchored at ${range.startIndex}–${range.endIndex}`);
  await google.request(`${DOCS}/documents/${google.doc}:batchUpdate`, { method: "POST", body: { requests: [{ insertComment: { content: body, range } }] } });
  const posted = (await listComments(google)).filter((comment) => comment.author.me && !comment.resolved && comment.content.trim() === body).at(-1);
  if (!posted) throw new Error("the anchored comment could not be read back with the same text");
  return posted.id;
}

export async function listComments(google) {
  const comments = [];
  let page = "";
  do {
    const data = await google.request(`${DRIVE}/files/${google.doc}/comments?pageSize=100&includeDeleted=false&fields=nextPageToken,comments(${COMMENT_FIELDS})${page ? `&pageToken=${page}` : ""}`);
    comments.push(...data.comments);
    page = data.nextPageToken ?? "";
  } while (page);
  return comments;
}

async function main([command, target, ...rest]) {
  const args = target?.startsWith("--") ? [target, ...rest] : rest;
  const flags = Object.fromEntries(args.flatMap((arg, index) => (arg.startsWith("--") ? [[arg.slice(2), args[index + 1]]] : [])));
  if (flags.since !== undefined) sinceTime(flags.since);
  if (["reply", "anchor", "edit", "delete"].includes(command)) requireExplicitTarget("doc", flags.doc);
  if (command === "list") {
    const google = await session(flags);
    for (const comment of await listComments(google)) {
      const last = comment.replies.at(-1) ?? comment;
      if (flags.since && ![comment, ...comment.replies].some((item) => notBefore(item.createdTime, flags.since))) continue;
      console.log(`${comment.id} ${comment.createdTime.slice(0, 16)} ${comment.author.displayName}${comment.resolved ? " resolved" : ""} · ${comment.replies.length} replies, last by ${last.author.displayName}${last.author.me ? " (me)" : ""}${comment.anchor ? ` · anchor ${comment.anchor}` : ""}\n  ${comment.quotedFileContent?.value ? `[${comment.quotedFileContent.value.slice(0, 60)}] ` : ""}${comment.content.replace(/\s+/g, " ").slice(0, 240)}`);
      for (const reply of comment.replies) console.log(`  ↳ ${reply.id} ${reply.author.displayName}: ${reply.content.replace(/\s+/g, " ").slice(0, 200)}`);
    }
    return 0;
  }
  if ((command === "reply" && target) || command === "anchor") {
    const body = readBody(flags);
    const google = await session(flags, command === "anchor");
    if (alreadyPosted(await listComments(google), command, target, body)) throw new Error(`the Doc already has this ${command === "reply" ? `reply in thread ${target}` : "comment"}; nothing posted`);
    const { notices, warnings } = await recheckDocTarget(google.doc, flags["body-file"], relintDoc(flags["body-file"], google.doc), { texts: [body] });
    const approve = () => {
      consumeApproval(process.argv, [body, ...warnings]);
      sayNotices(notices);
    };
    let id;
    if (command === "reply") {
      console.log(`WRITE → Google Doc ${google.doc} thread ${target} : 1 reply`);
      approve();
      await google.request(`${DRIVE}/files/${google.doc}/comments/${target}/replies?fields=id`, { method: "POST", body: { content: body } });
      id = target;
    } else {
      id = await anchorComment(google, flags.tab, flags.quote, body, approve);
    }
    const comments = await listComments(google);
    const found = comments.some((comment) => (command === "reply" ? comment.id === id && comment.replies.some((reply) => reply.content.trim() === body) : comment.content.trim() === body));
    if (!found) throw new Error("the comment could not be read back with the same text");
    console.log("posted and read back unchanged");
    logPostedText(command === "reply" ? "doc-reply" : "doc-comment", flags["body-file"], id ?? "anchored", body);
    return 0;
  }
  if (command === "edit" && target) {
    const body = readBody(flags);
    const google = await session(flags);
    const item = editTarget(await listComments(google), target, flags.reply);
    if (squash(item.content) === squash(body)) throw new Error("the posted text already matches the body file; nothing edited");
    const { notices, warnings } = await recheckDocTarget(google.doc, flags["body-file"], relintDoc(flags["body-file"], google.doc), { texts: [body] });
    const path = `${DRIVE}/files/${google.doc}/comments/${target}${flags.reply ? `/replies/${flags.reply}` : ""}?fields=id,content`;
    console.log(`WRITE → Google Doc ${google.doc} thread ${target}${flags.reply ? ` reply ${flags.reply}` : ""} : edit 1 ${flags.reply ? "reply" : "comment"}`);
    consumeApproval(process.argv, [body, ...warnings]);
    sayNotices(notices);
    await google.request(path, { method: "PATCH", body: { content: body } });
    const after = editTarget(await listComments(google), target, flags.reply);
    if (after.content.trim() !== body) throw new Error("the edited text could not be read back unchanged");
    console.log("edited and read back unchanged");
    logPostedText(flags.reply ? "doc-reply" : "doc-comment", flags["body-file"], flags.reply ?? target, body);
    return 0;
  }
  if (command === "changed") {
    const google = await session(flags);
    const file = await google.request(`${DRIVE}/files/${google.doc}?fields=modifiedTime,version,lastModifyingUser(displayName),capabilities(canReadRevisions)`);
    console.log(`${google.doc} modified ${file.modifiedTime} by ${file.lastModifyingUser?.displayName ?? "-"} · version ${file.version}`);
    if (!file.capabilities?.canReadRevisions) {
      console.log("revisions hidden: this account cannot read the Doc's revision history (needs editor access); only the last modification above is known");
      return 0;
    }
    const revisions = [];
    let page = "";
    do {
      const data = await google.request(`${DRIVE}/files/${google.doc}/revisions?pageSize=1000&fields=nextPageToken,revisions(id,modifiedTime,lastModifyingUser(displayName))${page ? `&pageToken=${page}` : ""}`);
      revisions.push(...(data.revisions ?? []));
      page = data.nextPageToken ?? "";
    } while (page);
    const recent = revisionsSince(revisions, flags.since);
    console.log(`${recent.length} of ${revisions.length} revisions${flags.since ? ` since ${flags.since}` : ""}`);
    for (const revision of recent) console.log(`  ${revision.id} ${revision.modifiedTime} ${revision.lastModifyingUser?.displayName ?? "-"}`);
    return 0;
  }
  if (command === "export") {
    const google = await session(flags);
    const { response, text } = await send(`${DRIVE}/files/${google.doc}/export?mimeType=text/plain`, { method: "GET", headers: { Authorization: `Bearer ${google.bearer}` } });
    if (!response.ok) throw new Error(`export returned HTTP ${response.status}: ${redact(text.slice(0, 200))}`);
    if (!flags.out) {
      process.stdout.write(text);
      return 0;
    }
    writeFileSync(flags.out, text);
    console.log(`${flags.out}: ${text.length} characters of ${google.doc}`);
    return 0;
  }
  if (command === "delete" && target) {
    const google = await session(flags);
    deleteTarget(await listComments(google), target, flags.reply);
    console.log(`WRITE → Google Doc ${google.doc} thread ${target}${flags.reply ? ` reply ${flags.reply}` : ""} : delete 1 own ${flags.reply ? "reply" : "comment"}`);
    consumeApproval(process.argv, []);
    await google.request(`${DRIVE}/files/${google.doc}/comments/${target}${flags.reply ? `/replies/${flags.reply}` : ""}`, { method: "DELETE" });
    if (stillThere(await listComments(google), target, flags.reply)) throw new Error(`${flags.reply ? `reply ${flags.reply}` : `comment ${target}`} still reads back after the delete`);
    console.log("deleted and confirmed gone");
    return 0;
  }
  console.error("usage: gdoc-comments.mjs list [--since <ISO>] [--doc <id>] | reply <comment-id> --body-file <f> --doc <id> | anchor --tab <t.id> --quote <exact text> --body-file <f> --doc <id> | edit <comment-id> [--reply <reply-id>] --body-file <f> --doc <id> | delete <comment-id> [--reply <reply-id>] --doc <id> | changed [--since <ISO>] | export [--out <f>]");
  return 2;
}

export function run() {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`gdoc-comments: ${error.message}`);
      process.exit(1);
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
