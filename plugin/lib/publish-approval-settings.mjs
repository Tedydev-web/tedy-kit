import { chmodSync, copyFileSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { STATE_DIR } from "./state-dir.mjs";

export const CLAUDE_SETTINGS = process.env.TEDY_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");

export const KIT_PUBLISH_WRITE_VERBS = Object.freeze({
  "github-write.mjs": Object.freeze(["post", "reply", "edit", "minimize", "resolve", "unresolve", "pr-body"]),
  "openproject.mjs": Object.freeze(["apply"]),
  "figma-comments.mjs": Object.freeze(["post", "reply", "delete"]),
  "gdoc-comments.mjs": Object.freeze(["reply", "anchor", "edit", "delete"]),
});

export const KIT_PUBLISH_APPLY_VERBS = Object.freeze({
  "openproject.mjs": Object.freeze(["set", "comment", "comment-edit", "relation", "relation-delete", "rollback"]),
  "doc-comment-file.mjs": Object.freeze(["post"]),
});

const writeRules = (script) => KIT_PUBLISH_WRITE_VERBS[script].map((verb) => `Bash(*${script}*${verb}*)`);
const applyRules = (script) => KIT_PUBLISH_APPLY_VERBS[script].map((verb) => `Bash(*${script}*${verb}*--apply*)`);

export const KIT_PUBLISH_ASK_RULES = Object.freeze([
  ...writeRules("github-write.mjs"),
  ...writeRules("openproject.mjs"),
  ...applyRules("openproject.mjs"),
  ...writeRules("figma-comments.mjs"),
  ...writeRules("gdoc-comments.mjs"),
  ...applyRules("doc-comment-file.mjs"),
]);

export const retiredDenyRules = (state = STATE_DIR) => [`Edit(/${resolve(state, "approvals")}/**)`];

export function readSettings(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: not readable as JSON (${error.code ?? error.name})`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file}: must be a JSON object`);
  const ask = data.permissions?.ask ?? [];
  const deny = data.permissions?.deny ?? [];
  if (!Array.isArray(ask)) throw new Error(`${file}: permissions.ask must be an array`);
  if (!Array.isArray(deny)) throw new Error(`${file}: permissions.deny must be an array`);
  return { data, ask, deny };
}

export function plannedPermissions({ ask, deny }) {
  const retired = retiredDenyRules();
  return { ask: [...ask, ...KIT_PUBLISH_ASK_RULES.filter((rule) => !ask.includes(rule))], deny: deny.filter((rule) => !retired.includes(rule)) };
}

const sameRules = (a, b) => a.length === b.length && a.every((rule, index) => rule === b[index]);

export const unchanged = (current, next) => sameRules(current.ask, next.ask) && sameRules(current.deny, next.deny);

export function writePermissions(file, { data, ask, deny }, next) {
  const had = data.permissions ?? {};
  const permissions = { ...had, ask: next.ask, deny: next.deny };
  if (!next.ask.length && !("ask" in had)) delete permissions.ask;
  if (!next.deny.length && (deny.length || !("deny" in had))) delete permissions.deny;
  const target = realpathSync(file);
  const mode = statSync(target).mode & 0o777;
  const backup = `${target}.tedy-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(target, backup);
  chmodSync(backup, mode);
  const temporary = `${target}.tedy-write-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ ...data, permissions }, null, 2)}\n`, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, target);
  return { backup, removed: deny.length - next.deny.length, added: next.ask.length - ask.length };
}
