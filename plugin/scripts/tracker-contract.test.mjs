import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { trackerCheck } from "./project-map.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("every command the OpenProject adapter accepts has a section in the tracker contract", () => {
  const usage = read("./openproject.mjs").match(/usage: openproject\.mjs ([^"]+)"/)[1];
  const commands = [...new Set(usage.split(" | ").map((part) => part.split(" ")[0]))];
  assert.deepEqual(commands, ["get", "list", "preview", "apply", "set", "comment", "comment-edit", "relation", "relation-delete", "pr-body", "rollback"]);
  const contract = read("../shared/tracker-contract.md");
  for (const command of commands) assert.match(contract, new RegExp(`^### \`${command}[ \`]`, "m"), command);
  assert.match(read("../skills/pm/references/tracker-openproject.md"), /shared\/tracker-contract\.md/);
});

test("doctor names a tracker type that has no adapter, and accepts openproject or no tracker", () => {
  assert.equal(trackerCheck({}), null);
  assert.deepEqual(trackerCheck({ tracker: { type: "openproject" } }), { check: "tracker type", status: "ok", detail: "openproject" });
  assert.deepEqual(trackerCheck({ tracker: { type: "jira" } }), { check: "tracker type", status: "fail", detail: "jira has no adapter; supported: openproject (see plugin/shared/tracker-contract.md)" });
});
