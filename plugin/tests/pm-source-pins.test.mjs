import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { figmaPin, recheckFigma } from "../lib/figma-comments.mjs";
import { gdocPin, recheckGdoc } from "../lib/gdoc-comments.mjs";
import { requirePin, writeSources } from "../lib/source-pins.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const RECHECK = "re-read the changed sources, fix the draft, lint it again and ask the user again";
const node = (text) => ({ id: "1:2", type: "FRAME", name: "Card", absoluteBoundingBox: { x: 10, y: 10, width: 100, height: 50 }, children: [{ id: "1:3", type: "TEXT", characters: text }] });

function figmaStub({ version, nodes = {} }) {
  const calls = [];
  const request = async (path) => {
    calls.push(path);
    if (path === "/files/F1?depth=1") return { version };
    const at = path.match(/[?&]version=([^&]+)/)?.[1] ?? "latest";
    return { nodes: nodes[at] ? { "1:2": { document: nodes[at] } } : {} };
  };
  return { figma: { file: "F1", request }, calls };
}

test("a Figma pin is the file's current version", async () => {
  assert.deepEqual(await figmaPin(figmaStub({ version: "v1" }).figma), { kind: "figma", file: "F1", version: "v1" });
});

test("the Figma recheck compares the cited node at the pinned and the latest version when the file moved", async () => {
  const pin = { kind: "figma", file: "F1", version: "v1" };
  assert.deepEqual(await recheckFigma(figmaStub({ version: "v1" }).figma, pin, ["1:2"]), {});
  const kept = figmaStub({ version: "v2", nodes: { v1: node("Pay"), latest: node("Pay") } });
  assert.deepEqual(await recheckFigma(kept.figma, pin, ["1:2"]), { notice: "notice: Figma F1 version changed from v1 to v2 since the draft was linted; node 1:2 is unchanged, so it posts as drafted" });
  assert.ok(kept.calls.includes("/files/F1/nodes?ids=1%3A2&version=v1"), kept.calls.join("\n"));
  const changed = figmaStub({ version: "v2", nodes: { v1: node("Pay"), latest: node("Pay now") } });
  assert.deepEqual(await recheckFigma(changed.figma, pin, ["1:2"]), { refusal: `refused: Figma F1 version changed from v1 to v2 since the draft was linted and node 1:2 changed; ${RECHECK}` });
  const gone = figmaStub({ version: "v2", nodes: { v1: node("Pay") } });
  assert.match((await recheckFigma(gone.figma, pin, ["1:2"])).refusal, /and node 1:2 changed/);
  assert.match((await recheckFigma(changed.figma, { ...pin, nodes: ["9:9"] }, ["1:2", "9:9"])).refusal, /and node 1:2, 9:9 changed/);
  assert.deepEqual(await recheckFigma(figmaStub({ version: "v2" }).figma, pin, []), { refusal: `refused: Figma F1 version changed from v1 to v2 since the draft was linted and the draft cites no node to compare; ${RECHECK}` });
});

const paragraph = (text, extra = {}) => ({ paragraph: { elements: [{ startIndex: 1, textRun: { content: text, ...extra } }] } });
const docBody = (texts, extra = {}) => ({ documentId: "D1", ...extra, tabs: texts.map((text, index) => ({ tabProperties: { tabId: `t.${index}` }, documentTab: { body: { content: [paragraph(text)] } }, childTabs: [] })) });

function googleStub(document) {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    if (url === "https://docs.googleapis.com/v1/documents/D1?includeTabsContent=true&suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS") {
      if (document instanceof Error) throw document;
      return document;
    }
    throw new Error(`unexpected ${url}`);
  };
  return { google: { doc: "D1", request }, calls };
}

test("a Google Doc pin is the SHA-256 of the text of every tab, read without suggestions, never a revision field", async () => {
  const pin = await gdocPin(googleStub(docBody(["Crypto takes the price in USDT\n", "Fees\n"])).google);
  assert.deepEqual(Object.keys(pin), ["kind", "doc", "text"]);
  assert.match(pin.text, /^[0-9a-f]{64}$/);
  const same = { ...docBody(["Crypto takes the price in USDT\n", "Fees\n"], { revisionId: "r9", namedRanges: { kix: { name: "kix" } }, suggestedDocumentStyleChanges: { s1: {} } }) };
  same.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.suggestedInsertionIds = ["s1"];
  assert.equal((await gdocPin(googleStub(same).google)).text, pin.text);
  assert.notEqual((await gdocPin(googleStub(docBody(["Crypto takes the price in USDT\n", "Fees!\n"])).google)).text, pin.text);
  assert.notEqual((await gdocPin(googleStub(docBody(["Fees\n", "Crypto takes the price in USDT\n"])).google)).text, pin.text);
});

test("the Google Doc recheck refuses a text change for an account that gets no revisionId, unless the caller proved every anchor intact", async () => {
  const pin = await gdocPin(googleStub(docBody(["A\n"])).google);
  const short = pin.text.slice(0, 12);
  assert.deepEqual(await recheckGdoc(googleStub(docBody(["A\n"])).google, pin), {});
  const changed = await recheckGdoc(googleStub(docBody(["B\n"])).google, pin);
  assert.match(changed.refusal, new RegExp(`^refused: Google Doc D1 text changed from ${short} to [0-9a-f]{12} since the draft was linted; ${RECHECK}$`));
  assert.match((await recheckGdoc(googleStub(docBody(["B\n"])).google, pin, "every highlighted passage still appears exactly once")).notice, /^notice: Google Doc D1 text changed from .* every highlighted passage still appears exactly once, so it posts as drafted$/);
  assert.match((await recheckGdoc(googleStub(docBody(["A\n"])).google, { kind: "gdoc", doc: "D1", field: "revisionId" }, "kept")).refusal, /predates text pins/);
});

test("a Google Doc whose text cannot be read gives no pin and no pass", async () => {
  const pin = await gdocPin(googleStub(docBody(["A\n"])).google);
  for (const document of [new Error("HTTP 403"), {}, { revisionId: "r1" }]) {
    await assert.rejects(gdocPin(googleStub(document).google), /^Error: refused: .*Google Doc D1/);
    await assert.rejects(recheckGdoc(googleStub(document).google, pin, "kept"), /^Error: refused: .*Google Doc D1/);
  }
});

test("a publish without a pin for its target refuses and names the lint to run", () => {
  const file = join(tempDir("tedy-pm-pins-"), "c.txt");
  writeFileSync(file, "@a frame thiếu trạng thái lỗi nha\n");
  const relint = `draft-lint.mjs figma-comment ${file}`;
  assert.throws(() => requirePin(file, relint, (pin) => pin.kind === "figma", "Figma version of F1"), { message: `refused: ${file} has no pinned sources; run ${relint}, then ask the user again` });
  writeSources(file, [], "@a frame thiếu trạng thái lỗi nha\n");
  assert.throws(() => requirePin(file, relint, (pin) => pin.kind === "figma", "Figma version of F1"), { message: `refused: ${file} has no pinned Figma version of F1; run ${relint}, then ask the user again` });
  writeSources(file, [{ kind: "figma", file: "F1", version: "v1" }], "@a frame thiếu trạng thái lỗi nha\n");
  assert.deepEqual(requirePin(file, relint, (pin) => pin.kind === "figma", "Figma version of F1"), { kind: "figma", file: "F1", version: "v1" });
});
