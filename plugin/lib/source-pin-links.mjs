const FIGMA_LINK = /figma\.com\/(?:design|file|proto|board|slides|make|site)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?([^\s)"'`<>]*)/g;
const FIGMA_EMBED = /figma\.com\/embed\?[^\s)"'`<>]*?\burl=([^&\s)"'`<>]+)/g;
const DOC_LINK = /(?:https?:\/\/)?(?:docs\.google\.com\/(?:a\/[^/\s]+\/)?document\/(?:u\/\d+\/)?d\/(e\/)?([\w-]+)|(?:drive|docs)\.google\.com\/open\?(?:[^\s#)"'`<>]*?&)?id=([\w-]+)|drive\.google\.com\/(?:u\/\d+\/)?file\/d\/([\w-]+))[^\s)"'`<>]*/g;
const NODE_ID = /^I?\d+:\d+(?:;\d+:\d+)*$/;

const decoded = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return "";
  }
};

export function nodeId(raw) {
  const id = decoded(raw).replaceAll("-", ":");
  return NODE_ID.test(id) ? id : null;
}

export function linkedDocs(raw) {
  const text = raw.replace(/&amp;/g, "&");
  const scanned = [text, ...[...text.matchAll(FIGMA_EMBED)].map((match) => decoded(match[1]))].join("\n");
  const figma = new Map();
  const docs = [];
  const problems = [];
  for (const [, main, branch, rest] of scanned.matchAll(FIGMA_LINK)) {
    const file = branch ?? main;
    const entry = figma.get(file) ?? { file, nodes: [], whole: false };
    const node = nodeId(rest.match(/[?&]node-id=([\w%:;-]+)/)?.[1] ?? "");
    if (node && !entry.nodes.includes(node)) entry.nodes.push(node);
    if (!node) entry.whole = true;
    figma.set(file, entry);
  }
  for (const [link, published, doc, opened, file] of text.matchAll(DOC_LINK)) {
    if (published) problems.push(`${link} is a published-to-web copy of a Google Doc, which cannot be pinned; link the Doc itself (docs.google.com/document/d/<id>)`);
    else docs.push(doc ?? opened ?? file);
  }
  return { figma: [...figma.values()], docs: [...new Set(docs)], problems };
}
