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

function googleStub({ ownClient, revisionId = "r1", version = 7 }) {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    if (url.startsWith("https://docs.googleapis.com/v1/documents/D1?fields=revisionId")) return { revisionId };
    if (url.startsWith("https://www.googleapis.com/drive/v3/files/D1?fields=version")) return { version: String(version) };
    throw new Error(`unexpected ${url}`);
  };
  return { google: { doc: "D1", ownClient, request }, calls };
}

test("a Google Doc pin is the Docs revisionId with an own OAuth client, else the Drive file version", async () => {
  assert.deepEqual(await gdocPin(googleStub({ ownClient: true }).google), { kind: "gdoc", doc: "D1", field: "revisionId", value: "r1" });
  assert.deepEqual(await gdocPin(googleStub({ ownClient: false }).google), { kind: "gdoc", doc: "D1", field: "version", value: "7" });
});

test("the Google Doc recheck refuses any change, unless the caller proved every anchor intact", async () => {
  const pin = { kind: "gdoc", doc: "D1", field: "revisionId", value: "r1" };
  assert.deepEqual(await recheckGdoc(googleStub({ ownClient: true }).google, pin), {});
  assert.deepEqual(await recheckGdoc(googleStub({ ownClient: true, revisionId: "r2" }).google, pin), { refusal: `refused: Google Doc D1 revisionId changed from r1 to r2 since the draft was linted; ${RECHECK}` });
  assert.deepEqual(await recheckGdoc(googleStub({ ownClient: true, revisionId: "r2" }).google, pin, "every highlighted passage still appears exactly once"), {
    notice: "notice: Google Doc D1 revisionId changed from r1 to r2 since the draft was linted; every highlighted passage still appears exactly once, so it posts as drafted",
  });
  const byVersion = googleStub({ ownClient: true, version: 8 });
  assert.match((await recheckGdoc(byVersion.google, { ...pin, field: "version", value: "7" })).refusal, /version changed from 7 to 8/);
  assert.ok(byVersion.calls.every((url) => url.includes("/drive/v3/")));
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
