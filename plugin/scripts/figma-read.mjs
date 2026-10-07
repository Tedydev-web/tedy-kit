import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { client } from "./figma-comments.mjs";

export function textLines(node, depth = 0, lines = []) {
  const pad = "  ".repeat(depth);
  if (node.type === "TEXT") lines.push(`${pad}"${node.characters.replace(/\s+/g, " ").trim()}"`);
  else if (["FRAME", "SECTION", "COMPONENT", "INSTANCE", "GROUP"].includes(node.type) && depth < 6) lines.push(`${pad}${node.type.toLowerCase()} ${node.name} (${node.id})`);
  for (const child of node.children ?? []) textLines(child, depth + 1, lines);
  return lines;
}

async function main([command, target, ...rest]) {
  const flags = Object.fromEntries(rest.flatMap((arg, index) => (arg.startsWith("--") ? [[arg.slice(2), rest[index + 1]]] : [])));
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
  console.error("usage: figma-read.mjs text <node-id> | image <node-id> [--file <key>]");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`figma-read: ${error.message}`);
      process.exit(1);
    },
  );
}
