import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { docReferenceErrors, hookEventErrors, kitHookEvents, kitHooks, skillModelErrors, kitDocFiles, kitRetiredNames, kitSkills, kitSourceFiles, kitTagVersions, retiredReferenceErrors, skillDescriptionErrors, skillSectionErrors, sourceCommentErrors, tagVersionErrors } from "../lib/kit-checks.mjs";

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

test("a path git ignores, such as the machine-local private knowledge base, is not required to exist", () => {
  const files = { "docs/p.md": "It writes `docs/prior-art/private/index.md` and `docs/prior-art/private/index.md:9`, not `docs/gone.md`.\n" };
  const ignored = (path) => path.startsWith("docs/prior-art/private/");
  assert.deepEqual(docReferenceErrors({ files: ["docs/p.md"], read: (f) => files[f], exists: (f) => f in files, ignored }), ["docs/p.md:1: docs/gone.md does not exist"]);
});

test("a published file that still names a retired file fails, and a longer name that ends in it does not", () => {
  const errors = retiredReferenceErrors({ retired: ["old-gate.mjs", "old-log.mjs"], scanned: [{ file: "plugin/hooks/hooks.json", text: '"command": "old-gate.mjs"' }, { file: "README.md", text: "clean" }, { file: "plugin/lib/a.mjs", text: 'import "./edit-old-log.mjs"; import "./bold-log.mjs";' }, { file: "plugin/lib/b.mjs", text: 'import "./old-log.mjs";' }] });
  assert.deepEqual(errors, ["plugin/hooks/hooks.json names the retired old-gate.mjs", "plugin/lib/b.mjs names the retired old-log.mjs"]);
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

test("a JavaScript comment fails, a tool directive or comment-like string does not", () => {
  const scripts = [
    { file: "clean.mjs", text: "// eslint-disable-next-line no-console\nconst url = \"https://example.com/a\";\n" },
    { file: "noted.mjs", text: "const a = 1;\n/* why a */\nconst b = 2; // why b\n" },
  ];
  assert.deepEqual(sourceCommentErrors({ scripts }), [
    "noted.mjs:2: /* why a */",
    "noted.mjs:3: // why b",
  ]);
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

test("every kit skill opens with a persona paragraph, then iron laws, then a not-this-skill section", () => {
  const skills = kitSkills(REPO);
  assert.ok(skills.length >= 7, String(skills.length));
  assert.deepEqual(skillSectionErrors(skills), []);
});

test("every kit skill description is under 1,024 characters and reads the same in plain YAML", () => {
  assert.deepEqual(skillDescriptionErrors(kitSkills(REPO)), []);
});

test("the kit's tracked JavaScript holds no comment other than a tool directive", () => {
  const source = kitSourceFiles(REPO);
  assert.ok(source.scripts.length >= 150, `${source.scripts.length} scripts`);
  assert.deepEqual(sourceCommentErrors(source), []);
});

test("a kit hook on an event that adds text to every prompt or every subagent spawn fails, except the cockpit's one ask-cards prompt hook", () => {
  assert.deepEqual(hookEventErrors(["PreToolUse", "SessionStart", "Stop"]), []);
  const askCards = { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-hooks.mjs" ask-cards', timeout: 10 };
  const other = { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-hooks.mjs" pending-handoffs', timeout: 10 };
  assert.deepEqual(hookEventErrors(["UserPromptSubmit"], { UserPromptSubmit: [{ hooks: [askCards] }] }), []);
  const refused = ["hooks.json registers UserPromptSubmit, whose output enters the context on every prompt or every subagent spawn"];
  assert.deepEqual(hookEventErrors(["UserPromptSubmit"], { UserPromptSubmit: [{ hooks: [other] }] }), refused);
  assert.deepEqual(hookEventErrors(["UserPromptSubmit"], { UserPromptSubmit: [{ hooks: [askCards, other] }] }), refused);
  assert.deepEqual(hookEventErrors(["UserPromptSubmit"], { UserPromptSubmit: [{ hooks: [askCards] }, { hooks: [askCards] }] }), refused);
  assert.deepEqual(hookEventErrors(["UserPromptExpansion"], { UserPromptExpansion: [{ hooks: [askCards] }] }), ["hooks.json registers UserPromptExpansion, whose output enters the context on every prompt or every subagent spawn"]);
  assert.deepEqual(hookEventErrors(["UserPromptSubmit", "SubagentStart", "Stop"]), [
    "hooks.json registers UserPromptSubmit, whose output enters the context on every prompt or every subagent spawn",
    "hooks.json registers SubagentStart, whose output enters the context on every prompt or every subagent spawn",
  ]);
});

test("a skill that sets model: in its front matter fails", () => {
  const skill = (name, front) => ({ name, text: `---\nname: ${name}\ndescription: d\n${front}---\nbody\n` });
  assert.deepEqual(skillModelErrors([skill("ok", ""), skill("pinned", "model: claude-haiku-5-5\n")]), [
    "pinned: sets model: in its front matter, which switches the session model and starts a cold prompt cache",
  ]);
});

test("the kit's hook events and skill models stay within the quota rules", () => {
  assert.deepEqual(hookEventErrors(kitHookEvents(REPO), kitHooks(REPO)), []);
  assert.deepEqual(skillModelErrors(kitSkills(REPO)), []);
});

test("the reviewer agent runs on the model measured at parity and without the user's CLAUDE.md, as measured", () => {
  const front = readFileSync(join(REPO, "plugin/agents/reviewer.md"), "utf8").split("---")[1];
  assert.match(front, /^model: claude-sonnet-5-5$/m);
  assert.match(front, /^omitClaudeMd: true$/m);
});
