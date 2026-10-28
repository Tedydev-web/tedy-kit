import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LEDGER = "docs/canon/standard.json";
const CLASSES = new Set(["model-gap", "user-policy", "platform"]);
const FIELDS = ["id", "text", "since", "reason", "class", "problems", "enforced", "notCovered", "approved"];
const TEST_FILE = /^plugin\/tests\/[\w.-]+\.test\.mjs$/;
const TITLE = /\btest\(\s*"((?:[^"\\]|\\.)*)"/g;

const missing = (value) => value === undefined || value === null || value === "";

function enforcementErrors(id, enforced, { read, exists }) {
  const { kind, file, title, whyNotMachine } = enforced;
  if (kind === "review") return missing(whyNotMachine) ? [`${id}: a review rule needs whyNotMachine`] : [];
  if (kind !== "test") return [`${id}: unknown enforcement kind ${kind}`];
  if (!TEST_FILE.test(file ?? "")) return [`${id}: ${file} is not a test file npm test runs`];
  if (!exists(file)) return [`${id}: enforcing test file ${file} does not exist`];
  const titles = [...read(file).matchAll(TITLE)].map(([, text]) => JSON.parse(`"${text}"`));
  return titles.includes(title) ? [] : [`${id}: ${file} has no test titled "${title}"`];
}

export function ledgerErrors({ ledger, read, exists }) {
  if (!Number.isInteger(ledger.version) || ledger.version < 1) return ["the standard has no positive integer version"];
  if (!Array.isArray(ledger.rules) || !ledger.rules.length) return ["the standard has no rules"];
  const seen = new Set();
  return ledger.rules.flatMap((rule) => {
    const id = rule.id ?? "(no id)";
    const errors = FIELDS.filter((field) => missing(rule[field])).map((field) => `${id}: no ${field}`);
    if (seen.has(id)) errors.push(`${id}: the id repeats`);
    seen.add(id);
    if (!missing(rule.class) && !CLASSES.has(rule.class)) errors.push(`${id}: unknown class ${rule.class}`);
    if (!missing(rule.since) && !(Number.isInteger(rule.since) && rule.since >= 1 && rule.since <= ledger.version)) errors.push(`${id}: since ${rule.since} is not a standard version from 1 to ${ledger.version}`);
    if (!missing(rule.approved) && !/^\d{4}-\d{2}-\d{2}$/.test(rule.approved)) errors.push(`${id}: approved ${rule.approved} is not a YYYY-MM-DD date`);
    if (!missing(rule.problems) && !(Array.isArray(rule.problems) && rule.problems.every((problem) => /^S\d+$/.test(problem)))) errors.push(`${id}: problems must list registry ids such as S12`);
    if (!missing(rule.enforced)) errors.push(...enforcementErrors(id, rule.enforced, { read, exists }));
    return errors;
  });
}

export function kitLedger(repo) {
  return {
    ledger: JSON.parse(readFileSync(join(repo, LEDGER), "utf8")),
    read: (file) => readFileSync(join(repo, file), "utf8"),
    exists: (file) => existsSync(join(repo, file)),
  };
}
