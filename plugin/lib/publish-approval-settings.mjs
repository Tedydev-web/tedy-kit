import { chmodSync, copyFileSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_SETTINGS = process.env.TEDY_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");

export const KIT_PUBLISH_ASK_RULES = Object.freeze([
  ...["post", "reply", "edit", "minimize", "resolve", "unresolve", "pr-body"].map((verb) => `Bash(*github-write.mjs*${verb}*)`),
  "Bash(*openproject.mjs*apply*)",
  ...["set", "comment", "comment-edit", "relation", "relation-delete", "rollback"].map((verb) => `Bash(*openproject.mjs*${verb}*--apply*)`),
  ...["post", "reply", "delete"].map((verb) => `Bash(*figma-comments.mjs*${verb}*)`),
  ...["reply", "anchor", "edit", "delete"].map((verb) => `Bash(*gdoc-comments.mjs*${verb}*)`),
  "Bash(*doc-comment-file.mjs*post*--apply*)",
]);

export const TRANSCRIPT_EDIT_DENY = "Edit(~/.claude/projects/**/*.jsonl)";

const KIT_SCRIPT =/github-write\.mjs|openproject\.mjs|figma-comments\.mjs|gdoc-comments\.mjs|doc-comment-file\.mjs/;

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

export function plannedPermissions({ ask, deny }, mode) {
  if (mode === "answer") return { ask: ask.filter((rule) => !KIT_PUBLISH_ASK_RULES.includes(rule)), deny: deny.includes(TRANSCRIPT_EDIT_DENY) ? deny : [...deny, TRANSCRIPT_EDIT_DENY] };
  return { ask: [...ask, ...KIT_PUBLISH_ASK_RULES.filter((rule) => !ask.includes(rule))], deny: deny.filter((rule) => rule !== TRANSCRIPT_EDIT_DENY) };
}

export const unchanged = (current, next) => current.ask.length === next.ask.length && current.deny.length === next.deny.length;

export const leftoverKitRules = (ask) => ask.filter((rule) => typeof rule === "string" && !KIT_PUBLISH_ASK_RULES.includes(rule) && KIT_SCRIPT.test(rule));

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
  return { backup, removed: ask.filter((rule) => !next.ask.includes(rule)).length, added: next.ask.filter((rule) => !ask.includes(rule)).length };
}
