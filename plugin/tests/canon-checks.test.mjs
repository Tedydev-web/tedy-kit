import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { docReferenceErrors, kitDocFiles, kitRetiredNames, kitSkills, kitSourceFiles, kitTagVersions, retiredReferenceErrors, skillDescriptionErrors, skillSectionErrors, sourceCommentErrors, tagVersionErrors } from "../lib/canon-checks.mjs";
import { applies, kitConformance } from "../lib/canon-standard.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

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

test("a skill without a persona before its iron laws, or without a not-this-skill section after them, fails", () => {
  const front = "---\nname: x\ndescription: Does x.\n---\n\n";
  const good = `${front}Plugin root: here.\n\nYou are the reviewer.\n\n## Iron laws\n\n1. x\n\n## Not this skill\n\nY goes to /z.\n`;
  assert.deepEqual(skillSectionErrors([{ name: "good", text: good }]), []);
  assert.deepEqual(skillSectionErrors([
    { name: "no-persona", text: `${front}Plugin root: here.\n\n## Iron laws\n\n## Not this skill\n` },
    { name: "no-laws", text: `${front}You are x.\n\n## Not this skill\n` },
    { name: "no-not-this", text: `${front}You are x.\n\n## Iron laws\n` },
    { name: "not-this-first", text: `${front}## Not this skill\n\nYou are x.\n\n## Iron laws\n` },
  ]), [
    'no-persona: the paragraph before ## Iron laws is not a persona opening with "You "',
    "no-laws: no ## Iron laws section",
    "no-not-this: no ## Not this skill section after ## Iron laws",
    "not-this-first: no ## Not this skill section after ## Iron laws",
  ]);
});

test("a skill description of 1,024 characters or more, holding ' #' or ': ', or not on one line, fails", () => {
  const skill = (name, description) => ({ name, text: `---\nname: ${name}\ndescription: ${description}\n---\nbody\n` });
  assert.deepEqual(skillDescriptionErrors([skill("ok", "Review a pull request - and draft hints.")]), []);
  assert.deepEqual(skillDescriptionErrors([
    skill("long", "x".repeat(1024)),
    skill("hash", "Review it #now"),
    skill("colon", "Use for: reviews"),
    skill("block", ">-\n  folded text"),
    { name: "none", text: "---\nname: none\n---\nbody\n" },
  ]), [
    "long: the description is 1024 characters, not under 1,024",
    'hash: the description holds " #" or ": ", which plain YAML reads as a comment or a mapping',
    'colon: the description holds " #" or ": ", which plain YAML reads as a comment or a mapping',
    "block: no one-line description in the front matter",
    "none: no one-line description in the front matter",
  ]);
});

test("a JavaScript or Python comment fails, a shebang, coding line, tool directive or comment-like string does not", () => {
  const dir = tempDir("canon-source-");
  writeFileSync(join(dir, "clean.py"), "#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nimport os  # noqa: F401\nx = '# not a comment'\ny = 1  # type: ignore\n");
  writeFileSync(join(dir, "noted.py"), "x = 1\n\n# explains x\ny = 2  # and y\n");
  const scripts = [
    { file: "clean.mjs", text: "// eslint-disable-next-line no-console\nconst url = \"https://example.com/a\";\n" },
    { file: "noted.mjs", text: "const a = 1;\n/* why a */\nconst b = 2; // why b\n" },
  ];
  assert.deepEqual(sourceCommentErrors({ scripts, python: ["clean.py", "noted.py"], cwd: dir }), [
    "noted.mjs:2: /* why a */",
    "noted.mjs:3: // why b",
    "noted.py:3: # explains x",
    "noted.py:4: # and y",
  ]);
  assert.match(sourceCommentErrors({ scripts: [], python: ["absent.py"], cwd: dir }).join("\n"), /python3 could not scan the Python files/);
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

const skillsUnder = (rule) => {
  const register = kitConformance(REPO);
  return kitSkills(REPO).filter(({ name }) => applies(register, rule, `plugin/skills/${name}/SKILL.md`));
};

test("every kit skill opens with a persona paragraph, then iron laws, then a not-this-skill section", () => {
  const skills = skillsUnder("skill-sections");
  assert.ok(skills.length >= 7, String(skills.length));
  assert.deepEqual(skillSectionErrors(skills), []);
});

test("every kit skill description is under 1,024 characters and reads the same in plain YAML", () => {
  assert.deepEqual(skillDescriptionErrors(skillsUnder("description-yaml")), []);
});

test("the kit's tracked JavaScript and Python hold no comment other than a tool directive", () => {
  const source = kitSourceFiles(REPO);
  assert.ok(source.scripts.length >= 150 && source.python.length >= 100, `${source.scripts.length} scripts, ${source.python.length} python`);
  assert.deepEqual(sourceCommentErrors(source), []);
});
