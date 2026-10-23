import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { requestJson } from "./api-request.mjs";
import { lintChatComment, mapLanguage } from "./draft-lint.mjs";
import { logPostedText } from "./edit-log.mjs";
import { resolveMap } from "./project-map.mjs";
import { consumeApproval, requireExplicitTarget } from "./publish-approval-ticket.mjs";
import { notBefore, sinceTime } from "./since.mjs";
import { RECHECK } from "./source-pin-git.mjs";
import { nodeId } from "./source-pin-links.mjs";
import { pinnedSources, requireFresh, sayNotices, versionCheck } from "./source-pins.mjs";

const API = "https://api.figma.com/v1";

export const pinOffset = (box) => ({ x: Math.round(box.width * 0.5), y: Math.round(box.height * 0.75) });

export function rootOf(comments, id) {
  const comment = comments.find((candidate) => String(candidate.id) === String(id));
  if (!comment) throw new Error(`comment ${id} not found in this file`);
  if (comment.parent_id) throw new Error(`comment ${id} is a reply to ${comment.parent_id}; reply to the root instead`);
  return comment;
}

const squash = (text) => text.replace(/\s+/g, " ").trim();

export const duplicateOnNode = (comments, node, body) =>
  comments.find((comment) => !comment.parent_id && !comment.resolved_at && comment.client_meta?.node_id === node && squash(comment.message) === squash(body));

export const duplicateReply = (comments, rootId, body) => comments.find((comment) => comment.parent_id === rootId && squash(comment.message) === squash(body));

export function threadsSince(comments, since) {
  const roots = comments.filter((comment) => !comment.parent_id);
  return roots
    .map((root) => ({ root, replies: comments.filter((comment) => comment.parent_id === root.id).sort((a, b) => a.created_at.localeCompare(b.created_at)) }))
    .filter(({ root, replies }) => !since || [root, ...replies].some((comment) => notBefore(comment.created_at, since)));
}

async function figmaRequest(token, path, options) {
  try {
    return await requestJson(`${API}${path}`, { ...options, retry429: false, headers: { "X-Figma-Token": token } });
  } catch (error) {
    if (error.status !== 429) throw error;
    throw new Error(`Figma answered HTTP 429 to ${path.split("?")[0]}${error.retryAfter ? ` (Retry-After ${error.retryAfter} s)` : ""}; it is rate limited, so nothing more was sent: wait, then run the same command again`);
  }
}

const clients = new Map();

export function client(flags) {
  const file = flags.file ?? resolveMap(process.cwd())?.map.figma?.file;
  if (!file) throw new Error("no --file and no figma.file in the project map");
  if (!clients.has(file)) {
    const token = readFileSync(join(homedir(), ".config", "figma", "token"), "utf8").trim();
    clients.set(file, { file, request: (path, options = {}) => figmaRequest(token, path, options) });
  }
  return clients.get(file);
}

export const canonicalJson = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonicalJson).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);

const fileRead = (figma) => {
  figma.read ??= { lastModified: null, nodes: new Map() };
  return figma.read;
};

async function readNodes(figma, ids) {
  const read = fileRead(figma);
  const missing = [...new Set(ids)].filter((id) => !read.nodes.has(id));
  if (missing.length) {
    const data = await figma.request(`/files/${figma.file}/nodes?ids=${encodeURIComponent(missing.join(","))}`);
    if (typeof data?.lastModified === "string") read.lastModified ??= data.lastModified;
    for (const id of missing) read.nodes.set(id, data?.nodes?.[id] ?? null);
  }
  return read;
}

async function lastModified(figma) {
  const read = fileRead(figma);
  if (!read.lastModified) {
    const modified = (await figma.request(`/files/${figma.file}?depth=1`))?.lastModified;
    if (typeof modified !== "string") throw new Error(`Figma ${figma.file} returned no lastModified`);
    read.lastModified = modified;
  }
  return read.lastModified;
}

async function nodeHashes(figma, ids) {
  if (!ids.length) return {};
  const read = await readNodes(figma, ids);
  return Object.fromEntries(ids.map((id) => [id, read.nodes.get(id) ? createHash("sha256").update(canonicalJson(read.nodes.get(id))).digest("hex") : null]));
}

function pinnedNodes(file, key) {
  const { sources } = pinnedSources(file, "");
  return (sources ?? []).flatMap((pin) => (pin.kind === "figma" && pin.file === key ? Object.keys(pin.nodes ?? {}) : []));
}

export async function figmaPin(figma, nodes = [], whole = !nodes.length) {
  const hashes = await nodeHashes(figma, nodes);
  const missing = nodes.filter((id) => hashes[id] === null);
  if (missing.length) throw new Error(`node ${missing.join(", ")} not found in Figma ${figma.file}`);
  return { kind: "figma", file: figma.file, lastModified: await lastModified(figma), whole, nodes: hashes };
}

export async function recheckFigma(figma, pin) {
  if (typeof pin.lastModified !== "string" || !pin.nodes || typeof pin.nodes !== "object") return { refusal: `refused: the pin of Figma ${pin.file} predates node pins; lint the draft again and ask the user again` };
  const ids = Object.keys(pin.nodes);
  const now = await nodeHashes(figma, ids);
  const changed = ids.filter((id) => now[id] !== pin.nodes[id]);
  if (changed.length) return { refusal: `refused: Figma ${pin.file} node ${changed.join(", ")} changed since it was pinned; ${RECHECK}` };
  return versionCheck(`Figma ${pin.file} lastModified`, pin.lastModified, await lastModified(figma), pin.whole || !ids.length ? { changed: "the draft links the whole file, not a node" } : { kept: `node ${ids.join(", ")} is unchanged` });
}

const covering = (file, node) => (pin) => pin.kind === "figma" && pin.file === file && (pin.whole || (node !== null && Object.hasOwn(pin.nodes ?? {}, node)));

function recheckTarget(figma, flags, node, body) {
  const file = flags["body-file"];
  return requireFresh(file, `draft-lint.mjs figma-comment ${file} --file ${figma.file}${node ? ` --node ${node}` : ""}`, { texts: [body], covers: covering(figma.file, node), what: node ? `Figma ${figma.file} node ${node}` : `Figma ${figma.file} file` });
}

const readBody = (flags) => {
  const body = readFileSync(flags["body-file"], "utf8").trim();
  const problems = lintChatComment(body, "figma", mapLanguage("doc_figma"));
  if (problems.length) throw new Error(`comment not posted: ${problems.join("; ")}`);
  return body;
};

async function verify(figma, id, body) {
  const { comments } = await figma.request(`/files/${figma.file}/comments`);
  const posted = comments.find((comment) => comment.id === id);
  if (posted?.message !== body) throw new Error(`comment ${id} reads differently after posting`);
  console.log(`posted ${id} and read it back unchanged`);
}

async function main([command, target, ...rest]) {
  const args = target?.startsWith("--") ? [target, ...rest] : rest;
  const flags = Object.fromEntries(args.flatMap((arg, index) => (arg.startsWith("--") ? [[arg.slice(2), args[index + 1]]] : [])));
  if (flags.since !== undefined) sinceTime(flags.since);
  if (["post", "reply", "delete"].includes(command)) requireExplicitTarget("file", flags.file);
  const figma = client(flags);
  if (command === "list") {
    const { comments } = await figma.request(`/files/${figma.file}/comments`);
    for (const { root, replies } of threadsSince(comments, flags.since)) {
      const last = replies.at(-1) ?? root;
      console.log(`${root.id} ${root.created_at.slice(0, 16)} ${root.user.handle} node ${root.client_meta?.node_id ?? "-"}${root.resolved_at ? " resolved" : ""} · ${replies.length} replies, last by ${last.user.handle} at ${last.created_at.slice(0, 16)}\n  ${root.message.replace(/\s+/g, " ").slice(0, 240)}`);
      for (const reply of replies) console.log(`  ↳ ${reply.id} ${reply.user.handle}: ${reply.message.replace(/\s+/g, " ").slice(0, 200)}`);
    }
    return 0;
  }
  if (command === "post" && target) {
    const body = readBody(flags);
    const node = nodeId(target);
    if (!node) throw new Error(`${target} is not a Figma node id such as 12-34 or 12:34`);
    const read = await readNodes(figma, [node, ...pinnedNodes(flags["body-file"], figma.file)]);
    const box = read.nodes.get(node)?.document?.absoluteBoundingBox;
    if (!box) throw new Error(`node ${node} not found in ${figma.file}`);
    const twin = duplicateOnNode((await figma.request(`/files/${figma.file}/comments`)).comments, node, body);
    if (twin) throw new Error(`comment ${twin.id} on node ${node} already says this; nothing posted`);
    const notices = await recheckTarget(figma, flags, node, body);
    console.log(`WRITE → Figma ${figma.file} node ${node} : 1 comment`);
    consumeApproval(process.argv, [body]);
    sayNotices(notices);
    const created = await figma.request(`/files/${figma.file}/comments`, { method: "POST", body: { message: body, client_meta: { node_id: node, node_offset: pinOffset(box) } } });
    await verify(figma, created.id, body);
    logPostedText("figma-comment", flags["body-file"], created.id, body);
    return 0;
  }
  if (command === "reply" && target) {
    const body = readBody(flags);
    const { comments } = await figma.request(`/files/${figma.file}/comments`);
    const root = rootOf(comments, target);
    const twin = duplicateReply(comments, root.id, body);
    if (twin) throw new Error(`reply ${twin.id} in thread ${root.id} already says this; nothing posted`);
    const notices = await recheckTarget(figma, flags, root.client_meta?.node_id ?? null, body);
    console.log(`WRITE → Figma ${figma.file} thread ${root.id} : 1 reply`);
    consumeApproval(process.argv, [body]);
    sayNotices(notices);
    const created = await figma.request(`/files/${figma.file}/comments`, { method: "POST", body: { message: body, comment_id: root.id } });
    await verify(figma, created.id, body);
    logPostedText("figma-reply", flags["body-file"], created.id, body);
    return 0;
  }
  if (command === "delete" && target) {
    const me = await figma.request("/me");
    const { comments } = await figma.request(`/files/${figma.file}/comments`);
    const comment = comments.find((candidate) => candidate.id === target);
    if (!comment) throw new Error(`comment ${target} not found`);
    if (comment.user.handle !== me.handle) throw new Error(`comment ${target} belongs to ${comment.user.handle}; only your own comments are deleted`);
    console.log(`WRITE → Figma ${figma.file} : delete own comment ${target}`);
    consumeApproval(process.argv, []);
    await figma.request(`/files/${figma.file}/comments/${target}`, { method: "DELETE" });
    console.log(`deleted ${target}`);
    return 0;
  }
  console.error("usage: figma-comments.mjs list [--since <ISO>] [--file <key>] | post <node-id> --body-file <f> --file <key> | reply <comment-id> --body-file <f> --file <key> | delete <comment-id> --file <key>");
  return 2;
}

export function run() {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`figma-comments: ${error.message}`);
      process.exit(1);
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
