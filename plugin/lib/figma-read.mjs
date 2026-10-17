import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { client } from "./figma-comments.mjs";
import { notBefore } from "./since.mjs";

const FRAME_TYPES = ["FRAME", "SECTION", "COMPONENT", "COMPONENT_SET"];
const BOX_KEYS = ["absoluteBoundingBox", "absoluteRenderBounds"];
const NODE_BATCH = 25;

export function textLines(node, depth = 0, lines = []) {
  const pad = "  ".repeat(depth);
  if (node.type === "TEXT") lines.push(`${pad}"${node.characters.replace(/\s+/g, " ").trim()}"`);
  else if (["FRAME", "SECTION", "COMPONENT", "INSTANCE", "GROUP"].includes(node.type) && depth < 6) lines.push(`${pad}${node.type.toLowerCase()} ${node.name} (${node.id})`);
  for (const child of node.children ?? []) textLines(child, depth + 1, lines);
  return lines;
}

export const versionsSince = (versions, since) => (since ? versions.filter((version) => notBefore(version.created_at, since)) : versions);

export function subtreeHash(node) {
  const origin = node.absoluteBoundingBox ?? { x: 0, y: 0 };
  const json = JSON.stringify({ ...node, name: undefined }, (key, value) =>
    BOX_KEYS.includes(key) && value ? { ...value, x: value.x - origin.x, y: value.y - origin.y } : value,
  );
  return createHash("sha1").update(json).digest("hex");
}

export function compactFrames(pages, maxDepth) {
  const frames = {};
  const walk = (node, page, level) => {
    if (level > maxDepth) return;
    if (FRAME_TYPES.includes(node.type)) frames[node.id] = { name: node.name, page, type: node.type, hash: subtreeHash(node) };
    for (const child of node.children ?? []) walk(child, page, level + 1);
  };
  for (const page of pages) for (const node of page.children) walk(node, page.name, 2);
  return frames;
}

export function diffSnapshots(before, after) {
  const label = (frame) => `${frame.page} / ${frame.name}`;
  const lines = [];
  for (const [id, frame] of Object.entries(after.frames)) {
    const old = before.frames[id];
    if (!old) lines.push(`added    ${id} ${label(frame)}`);
    else {
      if (old.name !== frame.name || old.page !== frame.page) lines.push(`renamed  ${id} ${label(old)} → ${label(frame)}`);
      if (old.hash !== frame.hash) lines.push(`changed  ${id} ${label(frame)}`);
    }
  }
  for (const [id, frame] of Object.entries(before.frames)) if (!after.frames[id]) lines.push(`removed  ${id} ${label(frame)}`);
  return lines;
}

async function fullPages(figma, version) {
  const pin = version ? `&version=${encodeURIComponent(version)}` : "";
  const outline = await figma.request(`/files/${figma.file}?depth=2${pin}`);
  const ids = outline.document.children.flatMap((page) => (page.children ?? []).map((node) => node.id));
  const full = {};
  for (let at = 0; at < ids.length; at += NODE_BATCH) {
    const batch = ids.slice(at, at + NODE_BATCH);
    const data = await figma.request(`/files/${figma.file}/nodes?ids=${encodeURIComponent(batch.join(","))}${pin}`);
    for (const id of batch) {
      const document = data.nodes?.[id]?.document;
      if (!document) throw new Error(`node ${id} missing from the nodes response`);
      full[id] = document;
    }
  }
  const pages = outline.document.children.map((page) => ({ name: page.name, children: (page.children ?? []).map((node) => full[node.id]) }));
  return { version: outline.version, pages };
}

async function main([command, target, ...rest]) {
  const args = target?.startsWith("--") ? [target, ...rest] : rest;
  const flags = Object.fromEntries(args.flatMap((arg, index) => (arg.startsWith("--") ? [[arg.slice(2), args[index + 1]]] : [])));
  if (command === "diff" && target && rest[0]) {
    const [before, after] = [target, rest[0]].map((path) => JSON.parse(readFileSync(path, "utf8")));
    const lines = diffSnapshots(before, after);
    console.log(`${before.file} ${before.version} → ${after.version}: ${lines.length ? lines.length : "no"} frame changes`);
    if (lines.length) console.log(lines.join("\n"));
    return 0;
  }
  const figma = client(flags);
  const node = (target ?? "").replace("-", ":");
  if (command === "text" && node) {
    const data = await figma.request(`/files/${figma.file}/nodes?ids=${encodeURIComponent(node)}`);
    const document = data.nodes?.[node]?.document;
    if (!document) throw new Error(`node ${node} not found in ${figma.file}`);
    console.log(textLines(document).join("\n"));
    return 0;
  }
  if (command === "image" && node) {
    const data = await figma.request(`/images/${figma.file}?ids=${encodeURIComponent(node)}&format=png&scale=1`);
    const url = data.images?.[node];
    if (!url) throw new Error(`no image rendered for node ${node}`);
    const path = `/tmp/figma-${figma.file}-${node.replace(":", "-")}.png`;
    writeFileSync(path, Buffer.from(await (await fetch(url)).arrayBuffer()));
    console.log(path);
    return 0;
  }
  if (command === "versions") {
    const versions = [];
    let before = "";
    for (;;) {
      const data = await figma.request(`/files/${figma.file}/versions?page_size=50${before ? `&before=${before}` : ""}`);
      versions.push(...data.versions);
      const last = data.versions.at(-1);
      if (!flags.since || !last || !data.pagination?.next_page || last.created_at < flags.since) break;
      before = last.id;
    }
    for (const version of versionsSince(versions, flags.since)) {
      const note = [version.label, version.description].filter(Boolean).join(" · ").replace(/\s+/g, " ");
      console.log(`${version.id} ${version.created_at} ${version.user?.handle ?? "-"}${note ? ` ${note}` : ""}`);
    }
    return 0;
  }
  if (command === "snapshot" && flags.out) {
    const depth = Number(flags.depth ?? 3);
    if (!Number.isInteger(depth) || depth < 2) throw new Error("--depth must be an integer of at least 2 (page = 1, top-level frame = 2)");
    const { version, pages } = await fullPages(figma, flags.version);
    const snapshot = { file: figma.file, version, at: new Date().toISOString(), frames: compactFrames(pages, depth) };
    writeFileSync(flags.out, `${JSON.stringify(snapshot, null, 1)}\n`);
    console.log(`${flags.out}: ${Object.keys(snapshot.frames).length} frames at version ${version}`);
    return 0;
  }
  console.error("usage: figma-read.mjs text <node-id> | image <node-id> | versions [--since <ISO>] | snapshot [--version <id>] [--depth 3] --out <file.json> | diff <a.json> <b.json>   (all but diff take [--file <key>])");
  return 2;
}

export function run() {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`figma-read: ${error.message}`);
      process.exit(1);
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
