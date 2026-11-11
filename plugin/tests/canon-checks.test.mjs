import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { alwaysOnChars, docReferenceErrors, footprintErrors, hookEventErrors, installedClaudeVersion, inventoryDigest, kitFootprint, kitHookEvents, kitHooks, skillModelErrors, inventoryVersionErrors, kitArtifacts, kitDocFiles, kitSurfaceFit, topicLineErrors, kitRetiredNames, kitSkills, kitSourceFiles, kitTagVersions, retiredReferenceErrors, skillDescriptionErrors, skillSectionErrors, sourceCommentErrors, surfaceFitErrors, tagVersionErrors } from "../lib/canon-checks.mjs";
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

test("a path git ignores, such as the machine-local private knowledge base, is not required to exist", () => {
  const files = { "docs/p.md": "It writes `docs/prior-art/private/index.md` and `docs/prior-art/private/index.md:9`, not `docs/gone.md`.\n" };
  const ignored = (path) => path.startsWith("docs/prior-art/private/");
  assert.deepEqual(docReferenceErrors({ files: ["docs/p.md"], read: (f) => files[f], exists: (f) => f in files, ignored }), ["docs/p.md:1: docs/gone.md does not exist"]);
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

test("a sweep record without a Topic line fails", () => {
  assert.deepEqual(topicLineErrors([{ file: "new.md", text: "# x\n\n- Topic: demo\n" }]), []);
  assert.deepEqual(topicLineErrors([{ file: "old.md", text: "# x\n\n- Role: demo\n" }, { file: "bare.md", text: "# x\n" }]), ['old.md: no "- Topic: <topic>" line', 'bare.md: no "- Topic: <topic>" line']);
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

test("every kit sweep record registered at a standard version with the topic line names its topic", () => {
  const register = kitConformance(REPO);
  const records = kitArtifacts(REPO).filter((file) => file.startsWith("docs/prior-art/sweeps/") && applies(register, "sweep-topic-line", file));
  assert.deepEqual(topicLineErrors(records.map((file) => ({ file, text: readFileSync(join(REPO, file), "utf8") }))), []);
});

test("the kit's tracked JavaScript and Python hold no comment other than a tool directive", () => {
  const source = kitSourceFiles(REPO);
  assert.ok(source.scripts.length >= 150 && source.python.length >= 100, `${source.scripts.length} scripts, ${source.python.length} python`);
  assert.deepEqual(sourceCommentErrors(source), []);
});

test("a kit need that leaves a surface of the inventory unjudged, or a fit judged against an older inventory, fails", () => {
  const inventory = { claudeCode: "2.1.314", docsDigest: "d1", hookEvents: ["PreToolUse", "Stop"], components: ["skill", "hooks", "MCP server", "theme"] };
  const fit = {
    inventory: inventoryDigest(inventory),
    extraSurfaces: ["sandbox"],
    notUsed: { theme: "colors only", sandbox: "user setting" },
    needs: [{ need: "gates", uses: { hooks: "PreToolUse" }, rejected: { skill: "advice, not a gate", "MCP server": "bypasses the shell gates" } }],
  };
  assert.deepEqual(surfaceFitErrors(inventory, fit), []);
  const grown = { ...inventory, hookEvents: [...inventory.hookEvents, "PostToolBatch"], components: [...inventory.components, "monitor"] };
  assert.deepEqual(surfaceFitErrors(grown, fit), [
    `surface-fit.json was judged against inventory ${fit.inventory}, the snapshot is now ${inventoryDigest(grown)}: re-judge every need against it, then set "inventory" to ${inventoryDigest(grown)}`,
    "gates: monitor is neither used, rejected with a reason, nor in notUsed",
  ]);
  const bad = {
    ...fit,
    notUsed: { theme: "", sandbox: "user setting", channel: "gone" },
    needs: [{ need: "gates", uses: { hooks: "PreToolUse", sandbox: "x" }, rejected: { "MCP server": "bypasses the shell gates" } }],
  };
  assert.deepEqual(surfaceFitErrors(inventory, bad), [
    "notUsed: theme has no reason",
    "notUsed: channel is not in the inventory",
    "gates: skill is neither used, rejected with a reason, nor in notUsed",
    "gates: sandbox is in notUsed but this need uses it",
  ]);
});

test("an inventory snapshot a minor version or more behind the installed Claude Code fails, a patch behind passes, and no installed Claude Code skips the check", () => {
  assert.deepEqual(inventoryVersionErrors("2.1.314", "2.1.314"), []);
  assert.deepEqual(inventoryVersionErrors("2.1.302", "2.1.314"), []);
  assert.deepEqual(inventoryVersionErrors("2.1.314", null), []);
  assert.deepEqual(inventoryVersionErrors("2.1.314", "2.2.0"), [
    "docs/canon/claude-code-inventory.json is from Claude Code 2.1.314, installed is 2.2.0: run python3 plugin/evals/probes/claude-code-inventory.py --json docs/canon/claude-code-inventory.json",
  ]);
  assert.equal(inventoryVersionErrors("2.9.0", "3.0.1").length, 1);
});

test("every kit need is judged against every Claude Code surface of the current inventory", () => {
  const { inventory, fit } = kitSurfaceFit(REPO);
  assert.ok(fit.needs.length >= 8 && inventory.hookEvents.length >= 30, `${fit.needs.length} needs, ${inventory.hookEvents.length} hook events`);
  assert.deepEqual(surfaceFitErrors(inventory, fit), []);
  assert.deepEqual(inventoryVersionErrors(inventory.claudeCode, installedClaudeVersion()), []);
});

test("always-on text counts each skill's and agent's description and when_to_use", () => {
  const doc = (front) => `---\nname: x\n${front}\n---\nbody that never counts\n`;
  assert.equal(alwaysOnChars([doc("description: abcd"), doc("description: ef\nwhen_to_use: ghi"), "no front matter"]), 9);
});

test("always-on text over its budget, or a budget raised since the latest release without a new standard version, fails", () => {
  assert.deepEqual(footprintErrors({ chars: 900, budget: 1000, tag: "v0.2.16", tagBudget: 1000, version: 3, tagVersion: 3 }), []);
  assert.deepEqual(footprintErrors({ chars: 900, budget: 1000, tag: "v0.2.16", tagBudget: undefined, version: 3, tagVersion: 2 }), []);
  assert.deepEqual(footprintErrors({ chars: 1200, budget: 1100, tag: "v0.2.16", tagBudget: 1000, version: 4, tagVersion: 3 }), [
    "the kit's always-on text is 1200 characters, over its budget of 1100 in docs/canon/footprint-budget.json",
  ]);
  assert.deepEqual(footprintErrors({ chars: 900, budget: 1100, tag: "v0.2.16", tagBudget: 1000, version: 3, tagVersion: 3 }), [
    "the always-on budget rose from 1000 at v0.2.16 to 1100 without a new standard version",
  ]);
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

test("the kit's always-on text, hook events and skill models stay within the quota rules", () => {
  const footprint = kitFootprint(REPO);
  assert.ok(footprint.chars > 1000, String(footprint.chars));
  assert.deepEqual(footprintErrors(footprint), []);
  assert.deepEqual(hookEventErrors(kitHookEvents(REPO), kitHooks(REPO)), []);
  assert.deepEqual(skillModelErrors(kitSkills(REPO)), []);
});

test("the reviewer agent runs on the model measured at parity and without the user's CLAUDE.md, as measured", () => {
  const front = readFileSync(join(REPO, "plugin/agents/reviewer.md"), "utf8").split("---")[1];
  assert.match(front, /^model: claude-sonnet-5-5$/m);
  assert.match(front, /^omitClaudeMd: true$/m);
});
