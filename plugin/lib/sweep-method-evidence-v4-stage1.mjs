import { EMPTY_TABLE, derive } from "./sweep-screening-derive.mjs";
import {
  FAR_ROWS,
  HELD_OUT_POSITIVES,
  LADDER,
  NEAR_ROWS,
  POSITIVES_NEEDED,
  STAGE1_BOUND,
  autoPass,
  blockHashes,
  canonical,
  escapeRegex,
  labelledRows,
  lower,
  lowerBound,
  sha256,
  upperBound,
} from "./sweep-method-evidence-v4-shared.mjs";

export function stage1Errors(io, sessions, strata, rows) {
  const errors = [];
  const freeze = io.json("stage1-freeze.json");
  const chosen = io.json("stage1-rung.json");
  if (!freeze || !chosen) return { errors: ["no stage1-freeze.json and stage1-rung.json in the sweep folder"], passes: {} };
  if (canonical(freeze.ladder) !== canonical(LADDER)) errors.push("stage1-freeze.json froze another ladder than the toolchain's");
  const inputs = {};
  const checked = new Set();
  const loadInputs = (stratum, shape) => {
    const key = `${stratum}-${shape}`;
    if (inputs[key]) return inputs[key];
    const file = `stage1-inputs-${stratum}-${shape}.jsonl`;
    inputs[key] = new Map(io.jsonl(file).map((r) => [r.order_rank, r]));
    const pool = io.jsonl(`${stratum}-screening-order.jsonl`).map((r) => `${r.order_rank} ${lower(r.repo)}`).sort();
    const held = [...inputs[key].values()].map((r) => `${r.order_rank} ${lower(r.repo)}`).sort();
    if (pool.join("\n") !== held.join("\n")) errors.push(`${file} is not the final ${stratum} pool of ${stratum}-screening-order.jsonl: stage 1 must read every row the config-pool channel and the snowball added`);
    const forged = [...inputs[key].values()].filter((r) => !r.readme_lead_sha256 && sha256(canonical(Object.fromEntries(Object.entries(r).filter(([k]) => k !== "row_sha256")))) !== r.row_sha256);
    if (forged.length) errors.push(`${file}: rows ${forged.slice(0, 10).map((r) => r.order_rank).join(", ")} do not hash to their recorded row_sha256`);
    return inputs[key];
  };
  const provenance = (name, model, shape, stratum, rows) => {
    if (checked.has(name) || !rows.length) return;
    checked.add(name);
    const entry = sessions[name];
    if (entry?.model !== model) {
      errors.push(`${name}.jsonl has no ${model} session in meta.json; only verdicts run-stage1.py recorded count`);
      return;
    }
    const bad = (entry.blocks ?? []).some((b) => b.shape !== shape || b.packet_sha256 !== freeze.packets?.[stratum] || b.examples_sha256 !== freeze.examples_sha256 ||
      b.template_sha256 !== freeze.template_sha256 || b.ranks.length > freeze.batch_max);
    if (bad) errors.push(`${name}: a block ran on another shape, packet, worked examples or prompt template than the stage-1 freeze, or over ${freeze.batch_max} rows`);
    const hashes = blockHashes(entry);
    const pool = loadInputs(stratum, shape);
    const wrong = rows.filter((r) => hashes[String(r.order_rank)] === undefined || hashes[String(r.order_rank)] !== pool.get(r.order_rank)?.row_sha256);
    if (wrong.length) errors.push(`${name}: ranks ${wrong.slice(0, 10).map((r) => r.order_rank).join(", ")} were not judged on the rows the stage-1 inputs hold`);
  };
  const pass = (rung, stratum, names) => {
    const shapeRows = loadInputs(stratum, rung.shape);
    const answers = rung.models.map((m) => {
      const rows = io.jsonl(`${names(m)}.jsonl`);
      provenance(names(m), m, rung.shape, stratum, rows);
      return new Map(rows.map((r) => [r.order_rank, r.verdict]));
    });
    return (rank) => {
      const row = shapeRows.get(rank);
      if (row && autoPass(row)) return true;
      const verdicts = answers.map((a) => a.get(rank));
      if (verdicts.includes(undefined)) return undefined;
      return verdicts.some((v) => v !== "no");
    };
  };
  const tried = [];
  for (const rung of freeze.ladder ?? []) {
    const runs = [1, 2].map((run) => {
      const passed = Object.fromEntries(strata.map((s) => [s, pass(rung, s, (m) => `judge-${s}-stage1-${rung.shape}-${m}-run${run}`)]));
      const positives = rows.filter((r) => r.user?.decision === "eligible");
      const results = positives.map((r) => passed[r.stratum](r.order_rank));
      if (results.includes(undefined)) return null;
      return { positives: positives.length, lower: lowerBound(results.filter(Boolean).length, positives.length) };
    });
    if (runs.includes(null)) break;
    tried.push({ rung: rung.rung, meets: runs.every((r) => r.positives >= POSITIVES_NEEDED && r.lower >= STAGE1_BOUND) });
    if (tried.at(-1).meets) break;
  }
  const first = tried.find((t) => t.meets)?.rung;
  if (first === undefined) errors.push("no stage-1 rung meets the pass rule (pooled one-sided 95% lower bound >= 0.95 on at least 59 positives, in both runs) on the calibration files");
  else if (chosen.rung !== first) errors.push(`stage1-rung.json chose rung ${chosen.rung}, but the first rung the calibration files certify is rung ${first}`);
  const rung = (freeze.ladder ?? []).find((r) => r.rung === chosen.rung);
  if (!rung) return { errors: [...errors, `stage1-rung.json names rung ${chosen.rung}, which the frozen ladder does not hold`], passes: {} };
  if (chosen.rung > 1) {
    const batches = (io.files ?? []).map((f) => f.match(/^(held-out(?:-\d+)?)-labels\.json$/)?.[1]).filter(Boolean);
    const held = labelledRows(io, io.read, batches.length ? batches : ["held-out"]);
    errors.push(...held.errors);
    const positives = held.rows.filter((r) => r.user?.decision === "eligible").length;
    if (positives < HELD_OUT_POSITIVES) errors.push(`rung ${chosen.rung} is confirmed on held-out batches holding ${positives} positives, fewer than ${HELD_OUT_POSITIVES}`);
    for (const stratum of strata) {
      const passed = pass(rung, stratum, (m) => `judge-${stratum}-stage1-${rung.shape}-${m}-held-out`);
      const missed = held.rows.filter((r) => r.stratum === stratum && r.user?.decision === "eligible" && passed(r.order_rank) !== true);
      if (missed.length) errors.push(`${stratum}: rung ${chosen.rung} misses held-out positives ${missed.map((r) => r.repo).join(", ")}; it is not confirmed`);
    }
  }
  const passes = {};
  for (const stratum of strata) {
    const passed = pass(rung, stratum, (m) => `stage1-${stratum}-${rung.shape}-${m}`);
    const pool = inputs[`${stratum}-${rung.shape}`];
    const open = [...pool.keys()].filter((rank) => passed(rank) === undefined);
    if (open.length) errors.push(`${stratum}: stage 1 has not screened ranks ${open.slice(0, 10).join(", ")} with every model of rung ${rung.rung}`);
    passes[stratum] = { pool, passed: new Set([...pool.keys()].filter((rank) => passed(rank) === true)), excluded: {}, problems: new Map() };
    for (const model of rung.models) {
      const rows = io.jsonl(`stage1-${stratum}-${rung.shape}-${model}.jsonl`);
      passes[stratum].excluded[model] = rows.filter((r) => r.verdict === "no").length;
      for (const row of rows.filter((r) => r.verdict !== "no" && pool.has(r.order_rank) && !autoPass(pool.get(r.order_rank)))) {
        passes[stratum].problems.set(row.order_rank, new Set([...(passes[stratum].problems.get(row.order_rank) ?? []), ...(row.problems ?? [])]));
      }
    }
  }
  return { errors, passes, rung };
}

export const hashedSample = (pool, size, seed) => pool.map((r) => [sha256(`${seed}:${r}`), r]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, size).map(([, r]) => r).sort((a, b) => a - b);

export function auditSample(io, topic, stratum, rung, passes) {
  const terms = [...new Set(Object.values(topic?.facets ?? {}).flatMap((f) => f.terms ?? []))].sort();
  const term = new RegExp(`(?<![a-z0-9])(${(terms.length ? terms : topic?.terms ?? []).map(escapeRegex).join("|")})(?![a-z0-9])`, "i");
  const pool = passes[stratum].pool;
  const ranks = [...pool.keys()].sort((a, b) => a - b);
  const excluded = ranks.filter((r) => !passes[stratum].passed.has(r));
  const answers = rung.models.map((m) => new Map(io.jsonl(`stage1-${stratum}-${rung.shape}-${m}.jsonl`).map((r) => [r.order_rank, r.verdict])));
  const disagreements = ranks.filter((r) => !autoPass(pool.get(r)) && new Set(answers.map((a) => a.get(r))).size > 1);
  const text = (row) => `${String(row.repo).split("/").slice(1).join("/").replaceAll("_", "-")} ${row.description ?? ""}`;
  const near = excluded.filter((r) => term.test(text(pool.get(r))));
  const far = excluded.filter((r) => !near.includes(r));
  const seed = `${topic?.sweep}:stage1-audit:${stratum}`;
  return { stratum, rung: rung.rung, excluded: excluded.length, disagreements, near_pool: near.length, far_pool: far.length,
    near: hashedSample(near, NEAR_ROWS, `${seed}:near`), far: hashedSample(far, FAR_ROWS, `${seed}:far`) };
}

export function stage1AuditErrors(io, topic, strata, passes, rung) {
  const errors = [];
  const screener = io.json("protocol-freeze.json")?.session_a?.model;
  for (const stratum of strata) {
    const audit = io.json(`${stratum}-stage1-audit.json`);
    if (!audit) {
      errors.push(`no ${stratum}-stage1-audit.json in the sweep folder: the stage-1 excludes are audited before stage 2`);
      continue;
    }
    if (!rung || !passes[stratum]) continue;
    const expected = auditSample(io, topic, stratum, rung, passes);
    if (canonical(audit) !== canonical(expected)) {
      errors.push(`${stratum}-stage1-audit.json is not the sample the stage-1 files give: ${NEAR_ROWS} near and ${FAR_ROWS} far excludes ranked by their sha256 under the sweep's seed`);
      continue;
    }
    const drawn = [...expected.near, ...expected.far];
    const rows = new Map(io.jsonl(`${stratum}-stage1-audit-${screener}.jsonl`).map((r) => [r.order_rank, r]));
    const unread = drawn.filter((r) => !rows.has(r));
    if (unread.length) {
      errors.push(`${stratum}: the stage-2 screener has not read stage-1 audit ranks ${unread.slice(0, 10).join(", ")}`);
      continue;
    }
    const flagged = drawn.filter((r) => derive(EMPTY_TABLE, stratum, { A: {}, B: {} }, "A", rows.get(r)).decision === "eligible");
    const checks = io.json(`${stratum}-stage1-audit-checks.json`);
    if (checks === undefined) {
      errors.push(`no ${stratum}-stage1-audit-checks.json: the user checks every row the screener flagged`);
      continue;
    }
    const unchecked = flagged.filter((r) => !["eligible", "excluded"].includes(checks[String(r)]));
    if (unchecked.length) errors.push(`${stratum}: the user has not checked stage-1 audit ranks ${unchecked.slice(0, 10).join(", ")} that the screener flagged`);
    const outside = Object.keys(checks).map(Number).filter((r) => !flagged.includes(r));
    if (outside.length) errors.push(`${stratum}-stage1-audit-checks.json checks ranks ${outside.slice(0, 10).join(", ")} the screener did not flag`);
    const bounds = [];
    const parts = ["near", "far"].map((part) => {
      const n = expected[part].length;
      const misses = expected[part].filter((r) => checks[String(r)] === "eligible").length;
      if (!n) return `${part} excludes 0 of ${expected[`${part}_pool`]} read, 0 confirmed eligible, upper elusion bound n/a`;
      const upper = upperBound(misses, n);
      bounds.push(upper);
      return `${part} excludes ${n} of ${expected[`${part}_pool`]} read, ${misses} confirmed eligible, upper elusion bound ([0-9.]+), at most ${Math.ceil(upper * expected[`${part}_pool`])} of the ${expected[`${part}_pool`]} eligible`;
    });
    const literal = (s) => s.split("([0-9.]+)").map(escapeRegex).join("([0-9.]+)");
    const line = new RegExp(`^${literal(`- ${stratum} stage-1 audit: ${expected.disagreements.length} model disagreements (they pass under the union); ${parts.join("; ")}; the stage-2 screener flagged ${flagged.length} and the user checked every flagged row`)}$`, "m");
    const written = io.text.match(line);
    if (!written || bounds.some((b, i) => Math.abs(Number(written[i + 1]) - b) > 5.1e-5)) {
      errors.push(`${stratum}: the record's stage-1 audit line is not the elusion the audit files give (bounds ${bounds.map((b) => b.toFixed(4)).join(", ")}, ${flagged.length} flagged)`);
    }
  }
  return errors;
}
