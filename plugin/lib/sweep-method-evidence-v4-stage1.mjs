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
  figureLine,
  hashedSample,
  interval,
  labelledRows,
  lower,
  lowerBound,
  sha256,
  upperBound,
} from "./sweep-method-evidence-v4-shared.mjs";

function rungTextErrors(text, tried, chosen) {
  const lines = [];
  for (const t of tried) {
    lines.push([`- rung ${t.rung}: `, ...t.runs.flatMap((r, i) => [`${i ? "; " : ""}run ${i + 1} ${r.passed}/${r.positives} positives passed, one-sided 95% lower bound `, [r.lower, 4]]),
      `; the runs differ on ${t.differ} of ${t.rows} rows; ${t.meets ? "meets the rule" : "fails the rule"}`]);
    if (!t.meets) continue;
    for (const stratum of Object.keys(t.runs[0].strata)) {
      lines.push([`- rung ${t.rung} ${stratum}: `, ...t.runs.flatMap((r, i) => {
        const s = r.strata[stratum];
        const [low, high] = s.positives ? interval(s.passed, s.positives) : [];
        const head = `${i ? "; " : ""}run ${i + 1} `;
        return s.positives ? [`${head}sensitivity ${s.passed}/${s.positives} (95% CI `, [low, 2], "-", [high, 2], "), pass rate ", [s.passRate, 3]] : [`${head}no positive, pass rate `, [s.passRate, 3]];
      })]);
    }
  }
  lines.push([`- chosen: rung ${chosen} after ${tried.length} rungs tried; rule: pooled one-sided 95% Clopper-Pearson lower bound >= 0.95 in both runs`]);
  const missing = lines.filter((parts) => !figureLine(text, parts));
  return missing.length ? [`the record's stage-1 rung lines are not the ones the calibration runs give (first differing: "${missing[0].map((p) => (Array.isArray(p) ? p[0].toFixed(p[1]) : p)).join("")}")`] : [];
}

export function stage1Errors(io, sessions, strata, rows) {
  const errors = [];
  const freeze = io.json("stage1-freeze.json");
  const chosen = io.json("stage1-rung.json");
  if (!freeze || !chosen) return { errors: ["no stage1-freeze.json and stage1-rung.json in the sweep folder"], passes: {} };
  if (canonical(freeze.ladder) !== canonical(LADDER)) errors.push("stage1-freeze.json froze another ladder than the toolchain's");
  const ladder = `- ladder frozen ${freeze.date} before any label was read (stage1-freeze.json sha256 \`${sha256(io.read("stage1-freeze.json")).slice(0, 16)}\`): `
    + (freeze.ladder ?? []).map((r) => `rung ${r.rung} ${r.models.join(" + ")} on ${r.shape}`).join("; ");
  if (!io.text.split("\n").includes(ladder)) errors.push(`the record's ladder line is not the one stage1-freeze.json gives ("${ladder}")`);
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
      const all = rows.map((r) => passed[r.stratum]?.(r.order_rank));
      if (all.includes(undefined)) return null;
      const count = (list) => [list.filter((r) => r.user?.decision === "eligible").length, list.filter((r) => r.user?.decision === "eligible" && all[rows.indexOf(r)]).length];
      const [positives, hits] = count(rows);
      const perStratum = Object.fromEntries([...new Set(rows.map((r) => r.stratum))].sort().map((s) => {
        const mine = rows.filter((r) => r.stratum === s);
        const [p, h] = count(mine);
        return [s, { positives: p, passed: h, passRate: mine.filter((r) => all[rows.indexOf(r)]).length / mine.length }];
      }));
      return { positives, passed: hits, lower: positives ? lowerBound(hits, positives) : 0, strata: perStratum, all };
    });
    if (runs.includes(null)) break;
    const differ = runs[0].all.filter((d, i) => d !== runs[1].all[i]).length;
    tried.push({ rung: rung.rung, runs, differ, rows: rows.length, meets: runs.every((r) => r.positives >= POSITIVES_NEEDED && r.lower >= STAGE1_BOUND) });
    if (tried.at(-1).meets) break;
  }
  errors.push(...rungTextErrors(io.text, tried, chosen.rung));
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
    let hits = 0;
    for (const stratum of strata) {
      const passed = pass(rung, stratum, (m) => `judge-${stratum}-stage1-${rung.shape}-${m}-held-out`);
      const mine = held.rows.filter((r) => r.stratum === stratum && r.user?.decision === "eligible");
      const missed = mine.filter((r) => passed(r.order_rank) !== true);
      hits += mine.length - missed.length;
      if (missed.length) errors.push(`${stratum}: rung ${chosen.rung} misses held-out positives ${missed.map((r) => r.repo).join(", ")}; it is not confirmed`);
    }
    const line = [`- held-out confirmation: rung ${chosen.rung} passed ${hits}/${positives} held-out positives, missed none; the batch's own one-sided lower bound `,
      [positives ? lowerBound(hits, positives) : 0, 4], "; the pooled bound above was measured on the set the rung was chosen on"];
    if (hits === positives && !figureLine(io.text, line)) errors.push(`the record's held-out confirmation line is not the one the held-out runs give (${hits}/${positives})`);
  }
  const passes = {};
  for (const stratum of strata) {
    const passed = pass(rung, stratum, (m) => `stage1-${stratum}-${rung.shape}-${m}`);
    const pool = inputs[`${stratum}-${rung.shape}`];
    const open = [...pool.keys()].filter((rank) => passed(rank) === undefined);
    if (open.length) errors.push(`${stratum}: stage 1 has not screened ranks ${open.slice(0, 10).join(", ")} with every model of rung ${rung.rung}`);
    passes[stratum] = { pool, passed: new Set([...pool.keys()].filter((rank) => passed(rank) === true)), excluded: {} };
    for (const model of rung.models) {
      passes[stratum].excluded[model] = io.jsonl(`stage1-${stratum}-${rung.shape}-${model}.jsonl`).filter((r) => r.verdict === "no").length;
    }
  }
  return { errors, passes, rung };
}

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
    const key = `${stratum}-stage1-audit-${screener}`;
    const entry = io.sessions?.[key];
    const frozen = io.json("protocol-freeze.json")?.strata?.[stratum];
    const hashes = blockHashes(entry);
    const session = io.json("protocol-freeze.json")?.session_a;
    if (entry?.model !== session?.model || entry?.cli !== session?.cli || (entry?.blocks ?? []).some((b) => b.packet_sha256 !== frozen?.packet_sha256
      || b.criteria_sha256 !== frozen?.criteria_sha256 || b.shape !== "full") || canonical(Object.keys(hashes).map(Number).sort((a, b) => a - b)) !== canonical([...drawn].sort((a, b) => a - b))) {
      errors.push(`${key}: the stage-1 audit reading is not the stage-2 screener ${session?.model} on the full inputs under the frozen packet and criteria, covering exactly the drawn ranks`);
    }
    const calibration = new Map((io.files ?? []).filter((f) => /^(?:calibration|top-up|held-out(?:-\d+)?)-set\.json$/.test(f))
      .flatMap((f) => io.json(f).rows.filter((r) => r.stratum === stratum).map((r) => [String(r.order_rank), r.inputs_sha256])));
    const misread = Object.keys(hashes).filter((r) => calibration.has(r) && calibration.get(r) !== hashes[r]);
    if (misread.length) errors.push(`${key}: ranks ${misread.slice(0, 10).join(", ")} were read on other inputs than the calibration rows of the same ranks hold`);
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
    const parts = ["near", "far"].flatMap((part, i) => {
      const n = expected[part].length;
      const pool = expected[`${part}_pool`];
      const misses = expected[part].filter((r) => checks[String(r)] === "eligible").length;
      const head = `${i ? "; " : ""}${part} excludes ${n} of ${pool} read, ${misses} confirmed eligible, upper elusion bound `;
      if (!n) return [`${head}n/a`];
      const upper = upperBound(misses, n);
      return [head, [upper, 4], `, at most ${Math.ceil(upper * pool)} of the ${pool} eligible`];
    });
    const line = [`- ${stratum} stage-1 audit: ${expected.disagreements.length} model disagreements (they pass under the union); `, ...parts,
      `; the stage-2 screener flagged ${flagged.length} and the user checked every flagged row`];
    if (!figureLine(io.text, line)) errors.push(`${stratum}: the record's stage-1 audit line is not the elusion the audit files give (${flagged.length} flagged)`);
  }
  return errors;
}
