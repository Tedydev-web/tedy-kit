import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, figmaPin, recheckFigma } from "../lib/figma-comments.mjs";
import { gdocPin, recheckGdoc } from "../lib/gdoc-comments.mjs";
import { recheckPinned, writeSources } from "../lib/source-pins.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const RECHECK = "re-read the changed sources, fix the draft, lint it again and ask the user again";
const node = (text) => ({ document: { id: "1:2", type: "FRAME", name: "Card", absoluteBoundingBox: { x: 10, y: 10, width: 100, height: 50 }, children: [{ id: "1:3", type: "TEXT", characters: text }] }, components: {}, styles: {} });
const status = (code) => Object.assign(new Error(`GET /v1/documents/D1 returned HTTP ${code}: no`), { status: code });

function figmaStub({ lastModified = "2026-10-01T00:00:00Z", nodes = {} }) {
  const calls = [];
  const request = async (path) => {
    calls.push(path);
    if (path === "/files/F1?depth=1") return { lastModified, version: "ignored" };
    const ids = decodeURIComponent(new URL(path, "https://x").searchParams.get("ids")).split(",");
    return { lastModified, nodes: Object.fromEntries(ids.map((id) => [id, nodes[id] ?? null])) };
  };
  return { figma: { file: "F1", request }, calls };
}

test("canonical JSON sorts keys at every depth, so key order never moves a pin", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } }), '{"a":{"c":null,"d":[{"x":2,"y":1}]},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
});

test("a Figma pin hashes the live JSON of each node, with no version parameter, and the file's lastModified", async () => {
  const stub = figmaStub({ nodes: { "1:2": node("Pay"), "3:4": node("Cancel") } });
  const pin = await figmaPin(stub.figma, ["1:2", "3:4"], false);
  assert.deepEqual(Object.keys(pin), ["kind", "file", "lastModified", "whole", "nodes"]);
  assert.equal(pin.lastModified, "2026-10-01T00:00:00Z");
  assert.deepEqual(Object.keys(pin.nodes), ["1:2", "3:4"]);
  assert.match(pin.nodes["1:2"], /^[0-9a-f]{64}$/);
  assert.notEqual(pin.nodes["1:2"], pin.nodes["3:4"]);
  assert.ok(stub.calls.includes("/files/F1/nodes?ids=1%3A2%2C3%3A4"), stub.calls.join("\n"));
  assert.ok(stub.calls.every((call) => !call.includes("version=")), stub.calls.join("\n"));
  await assert.rejects(figmaPin(figmaStub({}).figma, ["9:9"], false), /node 9:9 not found in Figma F1/);
  assert.deepEqual(await figmaPin(figmaStub({}).figma, [], true), { kind: "figma", file: "F1", lastModified: "2026-10-01T00:00:00Z", whole: true, nodes: {} });
});

test("the Figma recheck refuses a changed or deleted node, notes a file change elsewhere, and refuses any change to a whole-file pin", async () => {
  const pin = await figmaPin(figmaStub({ nodes: { "1:2": node("Pay") } }).figma, ["1:2"], false);
  assert.deepEqual(await recheckFigma(figmaStub({ nodes: { "1:2": node("Pay") } }).figma, pin), {});
  const reordered = { styles: {}, components: {}, document: { ...node("Pay").document } };
  assert.deepEqual(await recheckFigma(figmaStub({ nodes: { "1:2": reordered } }).figma, pin), {});
  assert.deepEqual(await recheckFigma(figmaStub({ lastModified: "2026-10-02T00:00:00Z", nodes: { "1:2": node("Pay") } }).figma, pin), {
    notice: "notice: Figma F1 lastModified changed from 2026-10-01T00:00:00Z to 2026-10-02T00:00:00Z since the draft was linted; node 1:2 is unchanged, so it posts as drafted",
  });
  assert.deepEqual(await recheckFigma(figmaStub({ nodes: { "1:2": node("Pay now") } }).figma, pin), { refusal: `refused: Figma F1 node 1:2 changed since the draft was linted; ${RECHECK}` });
  assert.deepEqual(await recheckFigma(figmaStub({}).figma, pin), { refusal: `refused: Figma F1 node 1:2 changed since the draft was linted; ${RECHECK}` });
  const whole = await figmaPin(figmaStub({}).figma, [], true);
  assert.deepEqual(await recheckFigma(figmaStub({}).figma, whole), {});
  assert.deepEqual(await recheckFigma(figmaStub({ lastModified: "2026-10-02T00:00:00Z" }).figma, whole), {
    refusal: `refused: Figma F1 lastModified changed from 2026-10-01T00:00:00Z to 2026-10-02T00:00:00Z since the draft was linted and the draft links the whole file, not a node; ${RECHECK}`,
  });
  assert.match((await recheckFigma(figmaStub({}).figma, { kind: "figma", file: "F1", version: "v1" })).refusal, /predates node pins/);
});

const paragraph = (text, extra = {}) => ({ paragraph: { elements: [{ startIndex: 1, textRun: { content: text, ...extra } }] } });
const docBody = (texts, extra = {}) => ({ documentId: "D1", ...extra, tabs: texts.map((text, index) => ({ tabProperties: { tabId: `t.${index}` }, documentTab: { body: { content: [paragraph(text)] } }, childTabs: [] })) });

function googleStub(document, { ownClient = true, exported = status(404) } = {}) {
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push(url);
    if (url === "https://docs.googleapis.com/v1/documents/D1?includeTabsContent=true&suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS") {
      if (document instanceof Error) throw document;
      return document;
    }
    if (url === "https://www.googleapis.com/drive/v3/files/D1/export?mimeType=text/plain" && options.as === "text") {
      if (exported instanceof Error) throw exported;
      return exported;
    }
    throw new Error(`unexpected ${url}`);
  };
  return { google: { doc: "D1", ownClient, request }, calls };
}

test("a Doc is pinned through its Drive text export without an own client, or when the Docs API answers 403, and never on another error", async () => {
  const viewer = await gdocPin(googleStub(status(403), { ownClient: false, exported: "Crypto takes the price in USDT\n" }).google);
  assert.deepEqual(Object.keys(viewer), ["kind", "doc", "method", "text"]);
  assert.equal(viewer.method, "drive-export");
  const denied = googleStub(status(403), { exported: "Crypto takes the price in USDT\n" });
  assert.deepEqual(await gdocPin(denied.google), viewer);
  for (const error of [status(500), status(404), new Error("socket hang up"), new Error("returned HTTP 403 in the text only")]) {
    const other = googleStub(error, { exported: "Crypto takes the price in USDT\n" });
    await assert.rejects(gdocPin(other.google), /^Error: refused: the text of Google Doc D1 could not be read through docs-text \(.+\), so its pin cannot be taken$/, error.message);
    assert.ok(!other.calls.some((url) => url.includes("/export")), error.message);
  }
  await assert.rejects(gdocPin(googleStub({}, { exported: "x\n" }).google), /could not be read through docs-text \(the Docs API returned no tabs\)/);
  assert.equal((await gdocPin(googleStub(docBody(["A\n"]), { exported: "Crypto takes the price in USDT\n" }).google)).method, "docs-text");
  assert.deepEqual(await recheckGdoc(googleStub(docBody(["changed\n"]), { exported: "Crypto takes the price in USDT\n" }).google, viewer), {});
  assert.match((await recheckGdoc(googleStub(status(500), { ownClient: false, exported: "Crypto takes the price in BTC\n" }).google, viewer)).refusal, /^refused: Google Doc D1 text changed from [0-9a-f]{12} to [0-9a-f]{12} since the draft was linted/);
  await assert.rejects(gdocPin(googleStub(status(403), { exported: status(403) }).google), /^Error: refused: the text of Google Doc D1 could not be read \(docs-text: .*; drive-export: .*\)/);
  await assert.rejects(recheckGdoc(googleStub(docBody(["A\n"]), { exported: status(500) }).google, viewer), /^Error: refused: the text of Google Doc D1 could not be read through drive-export/);
});

test("a Drive export pin drops the comment markers and the comment list the export appends, and nothing else", async () => {
  const exportOf = (body, comments) => `${body}\r\n\r\n${comments.map((text, index) => `[${String.fromCharCode(97 + index)}]${text}`).join("\r\n")}\r\n`;
  const viewer = (text) => gdocPin(googleStub(status(403), { ownClient: false, exported: text }).google);
  const bare = await viewer("Crypto takes the price in USDT\r\nThe fee is in GRAM\r\n");
  const one = await viewer(exportOf("Crypto takes the price in USDT[a]\r\nThe fee is in GRAM", ["Which wallet?"]));
  const two = await viewer(exportOf("Crypto takes the price in USDT[a]\r\nThe fee is in GRAM[b]", ["Which wallet?", "Paid by whom?"]));
  const reply = await viewer(exportOf("Crypto takes the price in USDT[a]\r\nThe fee is in GRAM[b][c]", ["Which wallet?", "Paid by whom?", "The payer."]));
  assert.equal(one.text, bare.text);
  assert.equal(two.text, bare.text);
  assert.equal(reply.text, bare.text);
  assert.notEqual((await viewer(exportOf("Crypto takes the price in BTC[a]\r\nThe fee is in GRAM", ["Which wallet?"]))).text, bare.text);
  assert.notEqual((await viewer(exportOf("Crypto takes the price in USDT[a]\r\nThe fee is in GRAM, plus [z] here", ["Which wallet?"]))).text, bare.text);
  const unmarked = exportOf("Crypto takes the price in USDT\r\nThe fee is in GRAM", ["Which wallet?"]);
  assert.notEqual((await viewer(unmarked)).text, bare.text);
});

test("a Google Doc pin is the SHA-256 of the text of every tab, read without suggestions, never a revision field", async () => {
  const pin = await gdocPin(googleStub(docBody(["Crypto takes the price in USDT\n", "Fees\n"])).google);
  assert.deepEqual(Object.keys(pin), ["kind", "doc", "method", "text"]);
  assert.equal(pin.method, "docs-text");
  assert.match(pin.text, /^[0-9a-f]{64}$/);
  const same = { ...docBody(["Crypto takes the price in USDT\n", "Fees\n"], { revisionId: "r9", namedRanges: { kix: { name: "kix" } }, suggestedDocumentStyleChanges: { s1: {} } }) };
  same.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.suggestedInsertionIds = ["s1"];
  assert.equal((await gdocPin(googleStub(same).google)).text, pin.text);
  assert.notEqual((await gdocPin(googleStub(docBody(["Crypto takes the price in USDT\n", "Fees!\n"])).google)).text, pin.text);
  assert.notEqual((await gdocPin(googleStub(docBody(["Fees\n", "Crypto takes the price in USDT\n"])).google)).text, pin.text);
});

test("the Google Doc recheck refuses a text change unless the caller proved every anchor intact", async () => {
  const pin = await gdocPin(googleStub(docBody(["A\n"])).google);
  const short = pin.text.slice(0, 12);
  assert.deepEqual(await recheckGdoc(googleStub(docBody(["A\n"])).google, pin), {});
  const changed = await recheckGdoc(googleStub(docBody(["B\n"])).google, pin);
  assert.match(changed.refusal, new RegExp(`^refused: Google Doc D1 text changed from ${short} to [0-9a-f]{12} since the draft was linted; ${RECHECK}$`));
  assert.match((await recheckGdoc(googleStub(docBody(["B\n"])).google, pin, "every highlighted passage still appears exactly once")).notice, /^notice: Google Doc D1 text changed from .* every highlighted passage still appears exactly once, so it posts as drafted$/);
  assert.match((await recheckGdoc(googleStub(docBody(["A\n"])).google, { kind: "gdoc", doc: "D1", field: "revisionId" }, "kept")).refusal, /predates text pins/);
  assert.match((await recheckGdoc(googleStub(docBody(["A\n"])).google, { kind: "gdoc", doc: "D1", text: pin.text }, "kept")).refusal, /predates text pins/);
});

test("a Google Doc whose text cannot be read gives no pin and no pass", async () => {
  const pin = await gdocPin(googleStub(docBody(["A\n"])).google);
  for (const document of [status(403), {}, { revisionId: "r1" }]) {
    await assert.rejects(gdocPin(googleStub(document).google), /^Error: refused: .*Google Doc D1/);
    await assert.rejects(recheckGdoc(googleStub(document).google, pin, "kept"), /^Error: refused: .*Google Doc D1/);
  }
});

test("a publish without a pin for its target refuses and names the lint to run", async () => {
  const file = join(tempDir("tedy-pm-pins-"), "c.txt");
  writeFileSync(file, "@a frame thiếu trạng thái lỗi nha\n");
  const relint = `draft-lint.mjs figma-comment ${file} --file F1 --node 1-2`;
  const covers = { covers: (pin) => pin.kind === "figma" && pin.file === "F1" && (pin.whole || Object.hasOwn(pin.nodes, "1:2")), what: "Figma F1 node 1:2" };
  assert.deepEqual(await recheckPinned(file, relint, covers), { refusals: [`refused: ${file} has no pinned sources; run ${relint}, then ask the user again`], notices: [] });
  writeSources(file, [], "@a frame thiếu trạng thái lỗi nha\n");
  assert.deepEqual(await recheckPinned(file, relint, covers), { refusals: [`refused: ${file} has no pinned Figma F1 node 1:2; run ${relint}, then ask the user again`], notices: [] });
});
