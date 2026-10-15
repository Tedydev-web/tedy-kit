import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { redact, requestJson } from "./api-request.mjs";
import { lintChatComment } from "./draft-lint.mjs";
import { logPostedText } from "./edit-log.mjs";
import { resolveMap } from "./project-map.mjs";

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
  const tab = (document.tabs ?? []).find((candidate) => candidate.tabProperties?.tabId === tabId);
  if (!tab) throw new Error(`tab ${tabId} not found in the document`);
  const runs = (tab.documentTab.body.content ?? []).flatMap((block) => (block.paragraph?.elements ?? []).filter((element) => element.textRun));
  let text = "";
  const starts = [];
  for (const run of runs) {
    starts.push({ offset: text.length, index: run.startIndex });
    text += run.textRun.content;
  }
  const hits = [];
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) hits.push(at);
  if (!hits.length) throw new Error(`quote not found in tab ${tabId}: "${quote.slice(0, 60)}"`);
  if (hits.length > 1) throw new Error(`quote appears ${hits.length} times in tab ${tabId}; quote a longer passage`);
  const indexAt = (offset) => {
    const run = starts.filter((start) => start.offset <= offset).at(-1);
    return run.index + (offset - run.offset);
  };
  return { startIndex: indexAt(hits[0]), endIndex: indexAt(hits[0] + quote.length - 1) + 1, tabId };
}

async function accessToken(remote, needOwnClient) {
  const dump = () => tokenFromDump(execFileSync("rclone", ["config", "dump"], { encoding: "utf8" }), remote);
  let token = dump();
  if (needOwnClient && !token.clientId) throw new Error(OWN_CLIENT_STEPS);
  if (token.clientId) {
    const body = new URLSearchParams({ client_id: token.clientId, client_secret: token.clientSecret, refresh_token: token.refresh, grant_type: "refresh_token" });
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
    if (!response.ok) throw new Error(`token refresh returned HTTP ${response.status}; run rclone config reconnect ${remote}:`);
    return (await response.json()).access_token;
  }
  if (!(token.expiry > Date.now() + 60_000)) {
    execFileSync("rclone", ["lsjson", `${remote}:`, "--max-depth", "1", "--dirs-only"], { stdio: "ignore" });
    token = dump();
  }
  return token.access;
}

export async function session(flags, needOwnClient = false) {
  const doc = flags.doc ?? resolveMap(process.cwd())?.map.prd?.doc;
  if (!doc) throw new Error("no --doc and no prd.doc in the project map");
  const bearer = await accessToken(flags.remote ?? "gdrive", needOwnClient);
  return { doc, bearer, request: (url, options = {}) => requestJson(url, { ...options, headers: { Authorization: `Bearer ${bearer}` } }) };
}

const readBody = (flags) => {
  const body = readFileSync(flags["body-file"], "utf8").trim();
  const problems = lintChatComment(body, "doc");
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

export const revisionsSince = (revisions, since) => (since ? revisions.filter((revision) => revision.modifiedTime >= since) : revisions);

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

export async function anchorComment(google, tab, quote, body) {
  const document = await google.request(`${DOCS}/documents/${google.doc}?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE`);
  const range = findQuoteRange(document, tab, quote);
  console.log(`WRITE → Google Doc ${google.doc} tab ${tab} : 1 comment anchored at ${range.startIndex}–${range.endIndex}`);
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
  if (command === "list") {
    const google = await session(flags);
    for (const comment of await listComments(google)) {
      const last = comment.replies.at(-1) ?? comment;
      if (flags.since && ![comment, ...comment.replies].some((item) => item.createdTime >= flags.since)) continue;
      console.log(`${comment.id} ${comment.createdTime.slice(0, 16)} ${comment.author.displayName}${comment.resolved ? " resolved" : ""} · ${comment.replies.length} replies, last by ${last.author.displayName}${last.author.me ? " (me)" : ""}${comment.anchor ? ` · anchor ${comment.anchor}` : ""}\n  ${comment.quotedFileContent?.value ? `[${comment.quotedFileContent.value.slice(0, 60)}] ` : ""}${comment.content.replace(/\s+/g, " ").slice(0, 240)}`);
      for (const reply of comment.replies) console.log(`  ↳ ${reply.id} ${reply.author.displayName}: ${reply.content.replace(/\s+/g, " ").slice(0, 200)}`);
    }
    return 0;
  }
  if ((command === "reply" && target) || command === "anchor") {
    const body = readBody(flags);
    const google = await session(flags, command === "anchor");
    if (alreadyPosted(await listComments(google), command, target, body)) throw new Error(`the Doc already has this ${command === "reply" ? `reply in thread ${target}` : "comment"}; nothing posted`);
    let id;
    if (command === "reply") {
      console.log(`WRITE → Google Doc ${google.doc} thread ${target} : 1 reply`);
      await google.request(`${DRIVE}/files/${google.doc}/comments/${target}/replies?fields=id`, { method: "POST", body: { content: body } });
      id = target;
    } else {
      id = await anchorComment(google, flags.tab, flags.quote, body);
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
    const path = `${DRIVE}/files/${google.doc}/comments/${target}${flags.reply ? `/replies/${flags.reply}` : ""}?fields=id,content`;
    console.log(`WRITE → Google Doc ${google.doc} thread ${target}${flags.reply ? ` reply ${flags.reply}` : ""} : edit 1 ${flags.reply ? "reply" : "comment"}`);
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
    const response = await fetch(`${DRIVE}/files/${google.doc}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${google.bearer}` } });
    if (!response.ok) throw new Error(`export returned HTTP ${response.status}: ${redact((await response.text()).slice(0, 200))}`);
    const text = await response.text();
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
    await google.request(`${DRIVE}/files/${google.doc}/comments/${target}${flags.reply ? `/replies/${flags.reply}` : ""}`, { method: "DELETE" });
    if (stillThere(await listComments(google), target, flags.reply)) throw new Error(`${flags.reply ? `reply ${flags.reply}` : `comment ${target}`} still reads back after the delete`);
    console.log("deleted and confirmed gone");
    return 0;
  }
  console.error("usage: gdoc-comments.mjs list [--since <ISO>] [--doc <id>] | reply <comment-id> --body-file <f> | anchor --tab <t.id> --quote <exact text> --body-file <f> | edit <comment-id> [--reply <reply-id>] --body-file <f> | delete <comment-id> [--reply <reply-id>] | changed [--since <ISO>] | export [--out <f>]");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`gdoc-comments: ${error.message}`);
      process.exit(1);
    },
  );
}
