import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { requestJson } from "./api-request.mjs";
import { lintChatComment, mapLanguage } from "./draft-lint.mjs";
import { logPostedText } from "./edit-log.mjs";
import { resolveMap } from "./project-map.mjs";

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
    .filter(({ root, replies }) => !since || [root, ...replies].some((comment) => comment.created_at >= since));
}

export function client(flags) {
  const token = readFileSync(join(homedir(), ".config", "figma", "token"), "utf8").trim();
  const file = flags.file ?? resolveMap(process.cwd())?.map.figma?.file;
  if (!file) throw new Error("no --file and no figma.file in the project map");
  return { file, request: (path, options = {}) => requestJson(`${API}${path}`, { ...options, headers: { "X-Figma-Token": token } }) };
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
    const node = target.replace("-", ":");
    const nodes = await figma.request(`/files/${figma.file}/nodes?ids=${encodeURIComponent(node)}`);
    const box = nodes.nodes?.[node]?.document?.absoluteBoundingBox;
    if (!box) throw new Error(`node ${node} not found in ${figma.file}`);
    const twin = duplicateOnNode((await figma.request(`/files/${figma.file}/comments`)).comments, node, body);
    if (twin) throw new Error(`comment ${twin.id} on node ${node} already says this; nothing posted`);
    console.log(`WRITE → Figma ${figma.file} node ${node} : 1 comment`);
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
    console.log(`WRITE → Figma ${figma.file} thread ${root.id} : 1 reply`);
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
    await figma.request(`/files/${figma.file}/comments/${target}`, { method: "DELETE" });
    console.log(`deleted ${target}`);
    return 0;
  }
  console.error("usage: figma-comments.mjs list [--since <ISO>] [--file <key>] | post <node-id> --body-file <f> | reply <comment-id> --body-file <f> | delete <comment-id>");
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
