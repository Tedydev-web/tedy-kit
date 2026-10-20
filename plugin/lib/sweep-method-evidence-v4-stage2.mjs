import { EMPTY_TABLE, derive, normal } from "./sweep-screening-derive.mjs";
import {
  AUDIT_ROWS,
  RECALL_TARGET,
  autoPass,
  canonical,
  figureLine,
  hashedSample,
  interval,
  kappa,
  lower,
} from "./sweep-method-evidence-v4-shared.mjs";

export function stage2Plans(io, topic, strata, passes, members, limit) {
  const plans = Object.fromEntries(strata.map((s) => {
    const passed = [...(passes[s]?.passed ?? [])].sort((a, b) => a - b);
    return [s, { passes: passed, order: passed, stop: null }];
  }));
  const total = strata.reduce((sum, s) => sum + plans[s].passes.length, 0);
  if (limit === null || limit === undefined || total <= limit) return plans;
  const standard = new Set(members);
  const need = Math.ceil(RECALL_TARGET * standard.size);
  const repo = (s, r) => lower(passes[s].pool.get(r)?.repo);
  const reachable = new Set(strata.flatMap((s) => plans[s].passes.map((r) => repo(s, r))).filter((m) => standard.has(m)));
  const base = { limit, members: standard.size, need, passed: reachable.size, reachable: reachable.size >= need };
  if (!base.reachable) {
    const stop = { ...base, depth: total, found: reachable.size, reached: false, interval: interval(reachable.size, standard.size) };
    return Object.fromEntries(strata.map((s) => [s, { ...plans[s], stop }]));
  }
  const ranks = Object.keys(topic?.facets ?? {}).flatMap((f) => strata.map((s) => [s, new Map((io.json(`facets/${f}/${s}-ranked.json`)?.rows ?? []).map((r) => [lower(r.repo), r.order_rank]))]));
  const best = (s, r) => Math.min(Infinity, ...ranks.filter(([t, m]) => t === s && m.has(repo(s, r))).map(([, m]) => m.get(repo(s, r))));
  const ordered = strata.flatMap((s) => plans[s].passes.map((r) => [s, r, best(s, r)])).sort((a, b) => a[2] - b[2] || strata.indexOf(a[0]) - strata.indexOf(b[0]) || a[1] - b[1]);
  let depth = limit;
  const found = new Set();
  for (const [index, [s, r]] of ordered.slice(0, limit).entries()) {
    if (standard.has(repo(s, r))) found.add(repo(s, r));
    if (found.size >= need) {
      depth = index + 1;
      break;
    }
  }
  const stop = { ...base, depth, found: found.size, reached: found.size >= need, interval: interval(found.size, standard.size) };
  return Object.fromEntries(strata.map((s) => [s, { ...plans[s], order: ordered.slice(0, depth).filter(([t]) => t === s).map(([, r]) => r).sort((a, b) => a - b), stop }]));
}

export function samePlan(written, plan) {
  const keys = ["limit", "members", "need", "passed", "reachable", "depth", "found", "reached"];
  if (canonical(written.passes) !== canonical(plan.passes) || canonical(written.order) !== canonical(plan.order)) return false;
  if (!plan.stop || !written.stop) return !plan.stop && !written.stop;
  return keys.every((k) => written.stop[k] === plan.stop[k]) && plan.stop.interval.every((v, i) => Math.abs(v - written.stop.interval?.[i]) < 1e-9);
}

export function stopTextErrors(text, strata, plans) {
  const errors = [];
  for (const stratum of strata) {
    const plan = plans[stratum];
    const line = text.match(new RegExp(`^## Stratum: ${stratum}\\n\\n(stop: [^\\n]*)`, "m"))?.[1] ?? "";
    const stop = plan.stop;
    const expected = !stop?.reachable ? `stop: stage 2 screened every one of the ${plan.passes.length} stage-1 passes `
      : `stopped at pooled depth ${stop.depth} (limit ${stop.limit}); this stratum screens ${plan.order.length} of its ${plan.passes.length} passes; pooled recall at the stop ${stop.found}/${stop.members} `;
    if (!line.includes(expected)) errors.push(`${stratum}: the record's stage-2 stop line is not the plan the files give ("${expected.trim()}")`);
    if (stop && !stop.reachable && !line.includes(`only ${stop.passed} of the ${stop.members} deduplicated standard members passed stage 1 in any stratum`)) {
      errors.push(`${stratum}: the record's stage-2 stop line does not state the unreachable target the files give`);
    }
  }
  const stop = plans[strata[0]]?.stop;
  if (stop && !stop.reachable && !text.includes(`- pooled recall target unreachable at stage 2: ${stop.passed} of the ${stop.members} deduplicated standard members passed stage 1`)) {
    errors.push("the pooled recall target is unreachable at stage 2 and the record names no threat");
  }
  return errors;
}

function crossAuditErrors(io, stratum, sample, model) {
  const sides = Object.fromEntries(["A", "B"].map((side) => [side, new Map(io.jsonl(`${stratum}-screen-${side}.jsonl`).map((r) => [r.order_rank, r]))]));
  const frozen = io.json("protocol-freeze.json")?.strata?.[stratum]?.frozen_after_rank ?? Infinity;
  const ranks = [...sides.A.keys()].filter((r) => sides.B.has(r) && r > frozen).sort((a, b) => a - b);
  if (canonical(sample) !== canonical(hashedSample(ranks, AUDIT_ROWS, `${io.topic?.sweep}:audit:${stratum}`))) {
    return [`${stratum}: audit-sample.json is not the sample the stage-2 files give: the ${AUDIT_ROWS} rows both sessions screened after the pilot with the lowest sha256 under the sweep's seed`];
  }
  const rows = new Map(io.jsonl(`${stratum}-audit-${model}.jsonl`).map((r) => [r.order_rank, r]));
  if (!sample.length || sample.some((r) => !rows.has(r))) return [];
  const decide = (row) => derive(EMPTY_TABLE, stratum, { A: {}, B: {} }, "A", row).decision === "eligible";
  const audit = sample.map((r) => decide(rows.get(r)));
  const parts = ["A", "B"].flatMap((side, i) => {
    const pairs = sample.map((r, j) => [audit[j], decide(sides[side].get(r))]);
    const k = kappa(pairs);
    return [`${i ? ", " : ""}with ${side} ${pairs.filter(([a, b]) => a === b).length}/${sample.length} (kappa `, k === null ? "undefined (one category)" : [k, 3], ")"];
  });
  const line = [`- ${stratum} audit: ${sample.length} rows drawn after stage 2 ended and screened again by ${model}: eligibility agreement `, ...parts];
  return figureLine(io.text, line) ? [] : [`${stratum}: the record's cross-family audit line is not the agreement the audit and screening files give`];
}

export function stage2Errors(io, sessions, strata, passes, members) {
  const errors = [];
  const screened = {};
  const limits = strata.map((s) => io.json(`${s}-stage2.json`)?.limit ?? null);
  if (new Set(limits).size > 1) errors.push(`the stage-2 plans hold different limits ${limits.join(", ")}; plan-stage2.py plans every stratum together`);
  const plans = stage2Plans(io, io.topic, strata, passes, members, limits[0]);
  if (strata.every((s) => io.json(`${s}-stage2.json`))) errors.push(...stopTextErrors(io.text, strata, plans));
  for (const stratum of strata) {
    const plan = io.json(`${stratum}-stage2.json`);
    if (!plan) {
      errors.push(`no ${stratum}-stage2.json in the sweep folder`);
      continue;
    }
    const passed = passes[stratum]?.passed ?? new Set();
    if (plan.passes.length !== passed.size || plan.passes.some((r) => !passed.has(r))) errors.push(`${stratum}-stage2.json does not list the stage-1 passes the stage-1 files give`);
    else if (!samePlan(plan, plans[stratum])) errors.push(`${stratum}-stage2.json is not the pooled plan the stage-1 files, the facet rankings and the QGS standard give`);
    const both = ["A", "B"].map((side) => new Set(io.jsonl(`${stratum}-screen-${side}.jsonl`).map((r) => r.order_rank)));
    const extra = [...new Set([...both[0], ...both[1]])].filter((r) => !passed.has(r));
    if (extra.length) errors.push(`${stratum}: stage 2 screened ranks ${extra.slice(0, 10).join(", ")} that passed no stage-1 model`);
    const open = plan.order.filter((r) => !(both[0].has(r) && both[1].has(r)));
    if (open.length) errors.push(`${stratum}: stage-2 ranks ${open.slice(0, 10).join(", ")} are not screened by both sessions`);
    screened[stratum] = { plan, both: new Set(plan.order.filter((r) => both[0].has(r) && both[1].has(r))) };
    const last = ["A", "B"].flatMap((side) => (sessions[`${stratum}-${side}`]?.blocks ?? []).map((b) => b.date)).sort().at(-1);
    const model = io.topic?.cross_family?.model;
    const audit = sessions[`${stratum}-audit-${model}`];
    const drawn = io.json("audit-sample.json");
    const sample = drawn?.[stratum] ?? [];
    if (drawn) errors.push(...crossAuditErrors(io, stratum, sample, model));
    if ((audit?.blocks ?? []).some((b) => b.date < last)) errors.push(`${stratum}: the cross-family audit ran before stage 2 ended on ${last}; the audit sample is drawn after stage 2 ends`);
  }
  return { errors, screened };
}

export function prismaErrors(io, text, strata, passes, screened) {
  const errors = [];
  const table = new Map([...text.matchAll(/^\| (\S+) \| ([^|]+?) \| (\d+) \|$/gm)].map((m) => [`${m[1]}|${m[2]}`, Number(m[3])]));
  for (const stratum of strata) {
    const order = io.jsonl(`${stratum}-screening-order.jsonl`);
    const channels = {};
    for (const row of order) for (const c of row.channels?.length ? row.channels : ["unknown"]) channels[c] = (channels[c] ?? 0) + 1;
    const p = passes[stratum];
    const s = screened[stratum];
    if (!p || !s) continue;
    const expected = {
      ...Object.fromEntries(Object.entries(channels).map(([c, n]) => [`identified: ${c}`, n])),
      "duplicates across channels": Object.values(channels).reduce((a, b) => a + b, 0) - order.length,
      "stage-1 screened": p.pool.size,
      "stage-1 passed unread (no text)": [...p.pool.values()].filter(autoPass).length,
      ...Object.fromEntries(Object.entries(p.excluded).map(([m, n]) => [`stage-1 no from ${m}`, n])),
      "excluded by automation (union rule)": p.pool.size - p.passed.size,
      "stage-2 assessed": s.both.size,
      "stage-1 passes not assessed (stage-2 stop)": s.plan.passes.length - s.plan.order.length,
    };
    for (const [stage, count] of Object.entries(expected)) {
      const written = table.get(`${stratum}|${stage}`);
      if (written !== count) errors.push(`PRISMA ${stratum} "${stage}": the record says ${written ?? "nothing"}, the files give ${count}`);
    }
  }
  return errors;
}

function stage2Rows(io, stratum, ranks) {
  const errors = [];
  const table = io.json("mechanism-table.json") ?? EMPTY_TABLE;
  const mapping = io.json(`${stratum}-mechanism-map.json`) ?? { A: {}, B: {} };
  const adjudicated = io.json(`${stratum}-adjudication.json`)?.rows ?? {};
  const studied = new Set(Object.keys(io.json("study.json")?.study ?? {}).map(lower));
  const sides = Object.fromEntries(["A", "B"].map((side) => [side, new Map(io.jsonl(`${stratum}-screen-${side}.jsonl`).map((r) => [r.order_rank, r]))]));
  const rows = [];
  for (const rank of ranks) {
    const a = derive(table, stratum, mapping, "A", sides.A.get(rank));
    const b = derive(table, stratum, mapping, "B", sides.B.get(rank));
    const adj = adjudicated[String(rank)];
    let decision;
    if (!adj && (a.decision === b.decision || ![a.decision, b.decision].includes("eligible"))) decision = a.decision;
    else if (adj) decision = normal(adj.decision);
    else {
      errors.push(`${stratum}: stage-2 rank ${rank} needs an adjudication row in ${stratum}-adjudication.json: one session says eligible, the other ${a.decision === "eligible" ? b.decision : a.decision}`);
      continue;
    }
    const repo = sides.A.get(rank).repo;
    if (studied.has(lower(repo))) decision = decision === "eligible" ? "study" : `study (below-threshold: ${a.total})`;
    rows.push({ rank, repo, decision });
  }
  return { errors, rows };
}

export function decisionErrors(io, text, topic, strata, passes, screened) {
  const errors = [];
  const table = new Map([...text.matchAll(/^\| (\S+) \| ([^|]+?) \| (\d+) \|$/gm)].map((m) => [`${m[1]}|${m[2]}`, Number(m[3])]));
  const facets = Object.keys(topic?.facets ?? {});
  for (const stratum of strata) {
    const s = screened[stratum];
    const p = passes[stratum];
    if (!s || !p) continue;
    const found = stage2Rows(io, stratum, [...s.both].sort((x, y) => x - y));
    errors.push(...found.errors);
    const counts = {};
    for (const row of found.rows) counts[row.decision] = (counts[row.decision] ?? 0) + 1;
    const written = Object.fromEntries([...table].filter(([k]) => k.startsWith(`${stratum}|stage 2: `)).map(([k, n]) => [k.slice(`${stratum}|stage 2: `.length), n]));
    if (canonical(written) !== canonical(counts)) errors.push(`PRISMA ${stratum} stage 2: the record says ${canonical(written)}, the files give ${canonical(counts)}`);
    const held = (rank) => facets.filter((f) => [...(p.problems.get(rank) ?? [])].some((problem) => topic.facets[f].problems.includes(problem)));
    const section = text.split(`## Stratum: ${stratum}\n\n`)[1]?.split("\n## ")[0] ?? "";
    const cells = new Map(section.split("\n").filter((l) => /^\| \d+ \| /.test(l)).map((l) => l.split(" | ")).map((c) => [Number(c[0].slice(2)), c]));
    const wrong = found.rows.filter((r) => cells.get(r.rank)?.[1] !== r.repo || cells.get(r.rank)?.[4] !== r.decision || cells.get(r.rank)?.at(-1) !== `${held(r.rank).join(", ") || "-"} |`);
    if (wrong.length) errors.push(`${stratum}: the record's stage-2 rows ${wrong.slice(0, 10).map((r) => r.rank).join(", ")} do not hold the decision and facets the screening files give`);
    const included = found.rows.filter((r) => r.decision === "eligible" || r.decision === "study");
    const pairs = {};
    for (const r of included) {
      const mine = held(r.rank);
      mine.forEach((f, i) => mine.slice(i + 1).forEach((g) => { pairs[`${f}+${g}`] = (pairs[`${f}+${g}`] ?? 0) + 1; }));
    }
    const per = facets.map((f) => `${f} ${included.filter((r) => held(r.rank).includes(f)).length}`).join(", ");
    const unread = included.filter((r) => autoPass(p.pool.get(r.rank))).length;
    const line = `- ${stratum}: ${included.length} repositories included once each; counted per facet ${per}; overlap ${Object.entries(pairs).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; `
      + `facets come from the stage-1 problem labels; ${unread} of them passed stage 1 unread and carry no facet label`;
    if (!text.split("\n").includes(line)) errors.push(`${stratum}: the record's facet line is not the inclusion the files give ("${line}")`);
  }
  return errors;
}
