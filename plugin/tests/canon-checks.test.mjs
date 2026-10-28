import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { docReferenceErrors, kitDocFiles, kitRetiredNames, kitTagVersions, retiredReferenceErrors, tagVersionErrors } from "../lib/canon-checks.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

test("a release tag whose manifest names another version, or a manifest behind the latest tag, fails", () => {
  const manifests = { "v0.2.11": "0.2.11", "v0.2.12": "0.2.11" };
  assert.deepEqual(tagVersionErrors({ tags: ["v0.2.11", "v0.2.12", "pre-split"], manifestAt: (tag) => manifests[tag], headVersion: "0.2.10" }), [
    "tag v0.2.12 holds plugin.json version 0.2.11",
    "plugin.json at HEAD is 0.2.10, behind the latest release tag v0.2.12",
  ]);
  assert.deepEqual(tagVersionErrors({ tags: ["v0.2.9", "v0.2.10"], manifestAt: (tag) => tag.slice(1), headVersion: "0.2.10" }), []);
});

test("a dead relative link, a missing repository path or a line past the end of its file fails", () => {
  const files = {
    "README.md": "See [the guide](docs/guide.md#start) and [gone](docs/gone.md), `plugin/lib/a.mjs:3`, `plugin/lib/a.mjs:40`, `plugin/lib/none.mjs` and `plugin/...`.\n",
    "docs/guide.md": "```\n[ignored](nowhere.md)\n```\nhttps://example.com/x and [mail](mailto:a@b.c)\n",
    "plugin/lib/a.mjs": "1\n2\n3\n",
  };
  const errors = docReferenceErrors({ files: ["README.md", "docs/guide.md"], read: (f) => files[f], exists: (f) => f in files });
  assert.deepEqual(errors, ["README.md:1: link docs/gone.md does not resolve", "README.md:1: plugin/lib/a.mjs has 3 lines, not line 40", "README.md:1: plugin/lib/none.mjs does not exist"]);
});

test("a published file that still names a retired file fails", () => {
  const errors = retiredReferenceErrors({ retired: ["old-gate.mjs"], scanned: [{ file: "plugin/hooks/hooks.json", text: '"command": "old-gate.mjs"' }, { file: "README.md", text: "clean" }] });
  assert.deepEqual(errors, ["plugin/hooks/hooks.json names the retired old-gate.mjs"]);
});

test("the kit's release tags match their manifests and its manifest is not behind the latest tag", () => {
  assert.deepEqual(tagVersionErrors(kitTagVersions(REPO)), []);
});

test("the kit's published docs hold no dead link, missing path or out-of-range line", () => {
  assert.deepEqual(docReferenceErrors(kitDocFiles(REPO)), []);
});

test("no published kit file names a file the kit retired", () => {
  assert.deepEqual(retiredReferenceErrors(kitRetiredNames(REPO)), []);
});
