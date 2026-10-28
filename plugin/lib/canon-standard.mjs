import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { kitArtifacts, latestReleaseTag, showAt } from "./canon-checks.mjs";

const LEDGER = "docs/canon/standard.json";
const REGISTER = "docs/canon/conformance.json";
const CLASSES = new Set(["model-gap", "user-policy", "platform"]);
const SCOPES = new Set(["skill", "adr", "card", "sweep", "repo"]);
const FIELDS = ["id", "text", "since", "scope", "reason", "class", "problems", "enforced", "notCovered", "approved"];
const TEST_FILE = /^plugin\/tests\/[\w.-]+\.test\.mjs$/;
const TITLE = /\btest\(\s*"((?:[^"\\]|\\.)*)"/g;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const missing = (value) => value === undefined || value === null || value === "";
const inVersion = (value, top) => Number.isInteger(value) && value >= 1 && value <= top;
const waiverKey = (waiver) => `${waiver.rule} ${waiver.artifact}`;

function enforcementErrors(id, enforced, { read, exists }) {
  const { kind, file, title, whyNotMachine } = enforced;
  if (kind === "review") return missing(whyNotMachine) ? [`${id}: a review rule needs whyNotMachine`] : [];
  if (kind !== "test") return [`${id}: unknown enforcement kind ${kind}`];
  if (!TEST_FILE.test(file ?? "")) return [`${id}: ${file} is not a test file npm test runs`];
  if (!exists(file)) return [`${id}: enforcing test file ${file} does not exist`];
  const titles = [...read(file).matchAll(TITLE)].map(([, text]) => JSON.parse(`"${text}"`));
  return titles.includes(title) ? [] : [`${id}: ${file} has no test titled "${title}"`];
}

function historyErrors({ version, history }) {
  if (!Array.isArray(history)) return ["the standard has no history"];
  const errors = [];
  for (let at = 1; at <= version; at += 1) {
    const entries = history.filter((entry) => entry.version === at);
    if (entries.length !== 1) errors.push(`history needs exactly one entry for version ${at}, found ${entries.length}`);
    for (const entry of entries) {
      for (const field of ["trigger", "change"]) if (missing(entry[field])) errors.push(`history ${at}: no ${field}`);
      if (!DATE.test(entry.date ?? "")) errors.push(`history ${at}: date ${entry.date} is not YYYY-MM-DD`);
      if (!Array.isArray(entry.redid)) errors.push(`history ${at}: redid must list the artifacts redone`);
    }
  }
  if (history.some((entry) => !inVersion(entry.version, version))) errors.push(`history holds a version outside 1 to ${version}`);
  return errors;
}

export function ledgerErrors({ ledger, read, exists }) {
  if (!Number.isInteger(ledger.version) || ledger.version < 1) return ["the standard has no positive integer version"];
  if (!Array.isArray(ledger.rules) || !ledger.rules.length) return ["the standard has no rules"];
  const seen = new Set();
  return [...historyErrors(ledger), ...ledger.rules.flatMap((rule) => {
    const id = rule.id ?? "(no id)";
    const errors = FIELDS.filter((field) => missing(rule[field])).map((field) => `${id}: no ${field}`);
    if (seen.has(id)) errors.push(`${id}: the id repeats`);
    seen.add(id);
    if (!missing(rule.class) && !CLASSES.has(rule.class)) errors.push(`${id}: unknown class ${rule.class}`);
    if (!missing(rule.scope) && !SCOPES.has(rule.scope)) errors.push(`${id}: unknown scope ${rule.scope}`);
    if (!missing(rule.since) && !inVersion(rule.since, ledger.version)) errors.push(`${id}: since ${rule.since} is not a standard version from 1 to ${ledger.version}`);
    if (!missing(rule.approved) && !DATE.test(rule.approved)) errors.push(`${id}: approved ${rule.approved} is not a YYYY-MM-DD date`);
    if (!missing(rule.problems) && !(Array.isArray(rule.problems) && rule.problems.every((problem) => /^S\d+$/.test(problem)))) errors.push(`${id}: problems must list registry ids such as S12`);
    if (!missing(rule.enforced)) errors.push(...enforcementErrors(id, rule.enforced, { read, exists }));
    const { scenario, with: kept, without } = rule.ablation ?? {};
    if (rule.class === "model-gap" && [scenario, kept, without].some(missing)) errors.push(`${id}: a model-gap rule needs an ablation naming its scenario and the arms with and without it`);
    return errors;
  })];
}

export function conformanceErrors({ ledger, conformance, artifacts, base }) {
  const register = conformance.artifacts ?? {};
  const waivers = conformance.waivers ?? [];
  const rules = new Set(ledger.rules.map((rule) => rule.id));
  const errors = artifacts.filter((artifact) => !(artifact in register)).map((artifact) => `${artifact}: not in the conformance register`);
  for (const [artifact, version] of Object.entries(register)) {
    if (!artifacts.includes(artifact)) errors.push(`${artifact}: registered but not a kit artifact`);
    if (!inVersion(version, ledger.version)) errors.push(`${artifact}: version ${version} is not a standard version from 1 to ${ledger.version}`);
  }
  const seen = new Set();
  for (const waiver of waivers) {
    const key = waiverKey(waiver);
    if (!rules.has(waiver.rule)) errors.push(`waiver ${key}: unknown rule`);
    if (!(waiver.artifact in register)) errors.push(`waiver ${key}: the artifact is not registered`);
    if (missing(waiver.reason)) errors.push(`waiver ${key}: no reason`);
    if (!DATE.test(waiver.approved ?? "")) errors.push(`waiver ${key}: approved ${waiver.approved} is not YYYY-MM-DD`);
    if (!inVersion(waiver.version, ledger.version)) errors.push(`waiver ${key}: version ${waiver.version} is not a standard version from 1 to ${ledger.version}`);
    if (seen.has(key)) errors.push(`waiver ${key}: repeats`);
    seen.add(key);
  }
  if (!base) return { errors, skipped: "no release tag holds the standard and the register yet, so waiver growth and version changes are not compared" };
  const before = base.conformance.artifacts ?? {};
  const waivedBefore = new Set((base.conformance.waivers ?? []).map(waiverKey));
  for (const waiver of waivers) {
    if (!waivedBefore.has(waiverKey(waiver)) && !(waiver.version > base.ledger.version)) errors.push(`waiver ${waiverKey(waiver)}: added without a new standard version (the release has version ${base.ledger.version})`);
  }
  for (const [artifact, version] of Object.entries(register)) {
    if (artifact in before && version < before[artifact]) errors.push(`${artifact}: version went down from ${before[artifact]} to ${version}`);
    if (!(artifact in before) && version !== ledger.version) errors.push(`${artifact}: new since the release and registered at version ${version}, not the current ${ledger.version}`);
  }
  return { errors, skipped: null };
}

export function applies({ ledger, conformance }, ruleId, artifact) {
  const rule = ledger.rules.find((candidate) => candidate.id === ruleId);
  if (!rule) throw new Error(`the standard has no rule ${ruleId}`);
  const version = conformance.artifacts?.[artifact];
  if (version === undefined) throw new Error(`${artifact} is not in the conformance register`);
  return rule.since <= version && !(conformance.waivers ?? []).some((waiver) => waiver.rule === ruleId && waiver.artifact === artifact);
}

export function audit({ ledger, conformance }) {
  return Object.entries(conformance.artifacts ?? {}).map(([artifact, version]) => ({
    artifact,
    version,
    notJudgedBy: ledger.rules.filter((rule) => rule.since > version).map((rule) => rule.id),
    waived: (conformance.waivers ?? []).filter((waiver) => waiver.artifact === artifact).map((waiver) => waiver.rule),
  }));
}

export function kitLedger(repo) {
  return {
    ledger: JSON.parse(readFileSync(join(repo, LEDGER), "utf8")),
    read: (file) => readFileSync(join(repo, file), "utf8"),
    exists: (file) => existsSync(join(repo, file)),
  };
}

export function kitConformance(repo) {
  const ledger = JSON.parse(readFileSync(join(repo, LEDGER), "utf8"));
  const conformance = JSON.parse(readFileSync(join(repo, REGISTER), "utf8"));
  const tag = latestReleaseTag(repo);
  const [baseLedger, baseRegister] = tag ? [showAt(repo, tag, LEDGER), showAt(repo, tag, REGISTER)] : [];
  const base = baseLedger && baseRegister ? { ledger: JSON.parse(baseLedger), conformance: JSON.parse(baseRegister) } : null;
  return { ledger, conformance, artifacts: kitArtifacts(repo), base };
}
