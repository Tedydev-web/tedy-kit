import {
  RECALL_TARGET,
  autoPass,
  canonical,
  interval,
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
    const sample = io.json("audit-sample.json")?.[stratum] ?? [];
    if (sample.some((r) => !screened[stratum].both.has(r))) errors.push(`${stratum}: the audit sample holds rows stage 2 did not screen`);
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
    const decided = [...table].filter(([k]) => k.startsWith(`${stratum}|stage 2: `)).reduce((a, [, n]) => a + n, 0);
    if (decided !== s.both.size) errors.push(`PRISMA ${stratum}: the stage-2 decisions add up to ${decided}, the files give ${s.both.size} assessed rows`);
  }
  return errors;
}
