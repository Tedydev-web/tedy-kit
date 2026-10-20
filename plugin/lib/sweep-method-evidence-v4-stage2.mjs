import { EMPTY_TABLE, JUDGED, derive, normal } from "./sweep-screening-derive.mjs";
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

const SHORT = { Authority: "A", Methodology: "M", Objectivity: "O", Date: "D", Position: "P" };

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
  let depth = ordered.length;
  const found = new Set();
  for (const [index, [s, r]] of ordered.entries()) {
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
  return keys.every((k) => written.stop[k] === plan.stop[k]) && plan.stop.interval.every((v, i) => Math.abs(v - written.stop.interval?.[i]) < 1e-6);
}

export function stopTextErrors(text, strata, plans, passes, rung) {
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
    const every = `stop: stage 2 screened every one of the ${plan.passes.length} stage-1 passes of the ${passes[stratum]?.pool.size}-row pool (rung ${rung})`;
    const full = !stop ? [every]
      : !stop.reachable ? [`${every} and ignored the limit of ${stop.limit} rows: only ${stop.passed} of the ${stop.members} deduplicated standard members passed stage 1 in any stratum, `
        + `and the ${RECALL_TARGET.toFixed(2)} pooled recall target needs ${stop.need}`]
        : [`stop: stage 2 ranked the stage-1 passes of every stratum together by facet and stopped at pooled depth ${stop.depth} (limit ${stop.limit}); this stratum screens `
          + `${plan.order.length} of its ${plan.passes.length} passes; pooled recall at the stop ${stop.found}/${stop.members} (`, [stop.found / stop.members, 3], ", 95% CI ",
        [stop.interval[0], 2], "-", [stop.interval[1], 2], `) of the ${stop.members} deduplicated standard members; ${stop.reached ? "target reached" : "target not reached"}`];
    if (!figureLine(line, full)) errors.push(`${stratum}: the record's stage-2 stop line is not the whole stop the plan gives`);
  }
  for (const stratum of strata) {
    const plan = plans[stratum];
    const threat = text.match(new RegExp(`^- stage 2 stopped before every stage-1 pass: ${stratum} screened (\\d+) of (\\d+) passes$`, "m"));
    const cut = plan.order.length < plan.passes.length;
    if (cut ? Number(threat?.[1]) !== plan.order.length || Number(threat?.[2]) !== plan.passes.length : threat) {
      errors.push(`${stratum}: the record's stage-2 stop threat is not the one the plan gives (${plan.order.length} of ${plan.passes.length} passes screened)`);
    }
  }
  const stop = plans[strata[0]]?.stop;
  if (stop && !stop.reachable && !text.includes(`- pooled recall target unreachable at stage 2: ${stop.passed} of the ${stop.members} deduplicated standard members passed stage 1`)) {
    errors.push("the pooled recall target is unreachable at stage 2 and the record names no threat");
  }
  if ((!stop || stop.reachable) && text.includes("- pooled recall target unreachable at stage 2: ")) {
    errors.push("the record names an unreachable pooled recall target the stage-2 plan does not give");
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

export function stage2Errors(io, sessions, strata, passes, members, rung) {
  const errors = [];
  const screened = {};
  const limits = strata.map((s) => io.json(`${s}-stage2.json`)?.limit ?? null);
  if (new Set(limits).size > 1) errors.push(`the stage-2 plans hold different limits ${limits.join(", ")}; plan-stage2.py plans every stratum together`);
  const plans = stage2Plans(io, io.topic, strata, passes, members, limits[0]);
  if (strata.every((s) => io.json(`${s}-stage2.json`))) errors.push(...stopTextErrors(io.text, strata, plans, passes, rung));
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
    const beyond = new Set([...both[0], ...both[1]].filter((r) => !screened[stratum].both.has(r))).size;
    const section = io.text.split(`## Stratum: ${stratum}\n\n`)[1]?.split("\n## ")[0] ?? "";
    if (!section.split("\n").includes(`Screened beyond the stop or outside both sessions: ${beyond} rows, kept in the data files.`)) {
      errors.push(`${stratum}: the record does not state the ${beyond} rows screened beyond the stop or outside both sessions`);
    }
    const last = ["A", "B"].flatMap((side) => (sessions[`${stratum}-${side}`]?.blocks ?? []).map((b) => b.date)).sort().at(-1);
    const option = io.topic?.cross_family;
    const model = option?.model;
    const audit = sessions[`${stratum}-audit-${model}`];
    const lines = io.text.split("\n");
    const auditLine = lines.some((l) => l.startsWith(`- ${stratum} audit: `));
    if (!option) {
      if (!lines.includes("- no cross-family audit: the topic config names no cross_family model, so no model of another family checks the screening") || auditLine) {
        errors.push(`${stratum}: the topic names no cross_family model and the record does not state the missing audit as a threat`);
      }
      continue;
    }
    if (/^claude[-.]/i.test(model)) errors.push(`the cross_family model ${model} is a Claude model; the audit needs a model outside the Claude family`);
    if (audit && (audit.model !== model || audit.cli !== option.cli)) errors.push(`${stratum}-audit-${model}: the audit session ran ${audit.cli} ${audit.model}, not the topic's cross_family ${option.cli} ${model}`);
    const drawn = io.json("audit-sample.json");
    const sample = drawn?.[stratum] ?? [];
    const read = new Set(io.jsonl(`${stratum}-audit-${model}.jsonl`).map((r) => r.order_rank));
    const done = sample.length > 0 && sample.every((r) => read.has(r)) && Boolean(audit);
    if (drawn) errors.push(...crossAuditErrors(io, stratum, sample, model));
    const pending = `- cross-family audit pending: ${stratum}: ${sample.filter((r) => read.has(r)).length} of ${sample.length} audit rows screened by ${model}; `
      + "the same-family screening has no cross-family check until it runs";
    if (done ? lines.includes(pending) || !auditLine : !lines.includes(pending) || auditLine) {
      errors.push(`${stratum}: the record's cross-family audit state is not the one the audit files give (${done ? "an audit line and no pending threat" : `the threat "${pending}" and no audit line`})`);
    }
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
  const studied = new Map(Object.entries(io.json("study.json")?.study ?? {}).map(([k, v]) => [lower(k), v]));
  const sides = Object.fromEntries(["A", "B"].map((side) => [side, new Map(io.jsonl(`${stratum}-screen-${side}.jsonl`).map((r) => [r.order_rank, r]))]));
  const rows = [];
  for (const rank of ranks) {
    const a = derive(table, stratum, mapping, "A", sides.A.get(rank));
    const b = derive(table, stratum, mapping, "B", sides.B.get(rank));
    const adj = adjudicated[String(rank)];
    const sums = `sums A ${a.total}, B ${b.total}`;
    let decision;
    let reason;
    if (!adj && a.decision === b.decision) [decision, reason] = [a.decision, `both sessions ${a.decision}; ${sums}`];
    else if (!adj && ![a.decision, b.decision].includes("eligible")) [decision, reason] = [a.decision, `both sessions exclude; codes differ (A ${a.decision}, B ${b.decision}); ${sums}`];
    else if (adj) [decision, reason] = [normal(adj.decision), `adjudicated: ${adj.why}`];
    else {
      errors.push(`${stratum}: stage-2 rank ${rank} needs an adjudication row in ${stratum}-adjudication.json: one session says eligible, the other ${a.decision === "eligible" ? b.decision : a.decision}`);
      continue;
    }
    const repo = sides.A.get(rank).repo;
    if (studied.has(lower(repo))) [decision, reason] = [decision === "eligible" ? "study" : `study (below-threshold: ${a.total})`, studied.get(lower(repo))];
    const score = [...JUDGED.map((c) => `${SHORT[c]}${a.scores[c]}${a.scores[c] === b.scores[c] ? "" : `/${b.scores[c]}`}`), `N${a.novelty}${a.novelty === b.novelty ? "" : `/${b.novelty}`}`].join(" ");
    const commit = sides.A.get(rank).commit || sides.B.get(rank).commit || "-";
    rows.push({ rank, repo, commit, decision, score, reason: String(reason).replaceAll("|", "/") });
  }
  return { errors, rows };
}

function categoricalKappa(pairs) {
  if (!pairs.length) return null;
  const share = (side, label) => pairs.filter((p) => p[side] === label).length / pairs.length;
  const observed = pairs.filter(([a, b]) => a === b).length / pairs.length;
  const expected = [...new Set(pairs.flat())].reduce((sum, label) => sum + share(0, label) * share(1, label), 0);
  return expected < 1 ? (observed - expected) / (1 - expected) : null;
}

const kappaParts = (k) => (k === null ? ["undefined (one category)"] : [[k, 3]]);

export function agreementErrors(io, text, strata) {
  const errors = [];
  const table = io.json("mechanism-table.json") ?? EMPTY_TABLE;
  const criteria = JUDGED.filter((c) => c !== "Date");
  for (const stratum of strata) {
    const mapping = io.json(`${stratum}-mechanism-map.json`) ?? { A: {}, B: {} };
    const sides = ["A", "B"].map((side) => new Map(io.jsonl(`${stratum}-screen-${side}.jsonl`).map((r) => [r.order_rank, r])));
    const common = [...sides[0].keys()].filter((r) => sides[1].has(r)).sort((a, b) => a - b);
    const pairs = common.map((r) => [derive(table, stratum, mapping, "A", sides[0].get(r)), derive(table, stratum, mapping, "B", sides[1].get(r))]);
    const after = io.json("protocol-freeze.json")?.strata?.[stratum]?.frozen_after_rank;
    const measured = pairs.filter((_, i) => common[i] > after);
    if (!measured.length) continue;
    const same = (list) => measured.reduce((sum, [a, b]) => sum + list.filter((c) => a.scores[c] === b.scores[c]).length, 0);
    const cells = measured.length * criteria.length;
    const dated = measured.length * JUDGED.length;
    const eligible = measured.map(([a, b]) => [a.decision === "eligible", b.decision === "eligible"]);
    const lines = [
      [`- ${stratum}: post-freeze rows ${measured.length} (every row both sessions screened that is ranked after the pilot block, which ends at row ${after}): `
        + `${same(criteria)}/${cells} judged cells identical without the computed Date (`, [same(criteria) / cells, 3], `); with Date ${same(JUDGED)}/${dated} (`, [same(JUDGED) / dated, 3],
      "); target 0.90 without Date"],
      [`- ${stratum} kappa: `, ...criteria.flatMap((c, i) => [`${i ? ", " : ""}${c} `, ...kappaParts(categoricalKappa(measured.map(([a, b]) => [a.scores[c], b.scores[c]])))]),
        "; eligibility kappa ", ...kappaParts(categoricalKappa(eligible)), ` (${eligible.filter(([a, b]) => a !== b).length} of ${measured.length} decisions differ); Date is computed, not judged, and left out`],
    ];
    const mechs = [0, 1].map((side) => new Set(pairs.flatMap((p) => [...p[side].mechs])));
    const shared = [...mechs[0]].filter((m) => mechs[1].has(m)).length;
    const chapman = ((mechs[0].size + 1) * (mechs[1].size + 1)) / (shared + 1) - 1;
    lines.push([`- ${stratum} capture-recapture over every row both sessions screened: A ${mechs[0].size}, B ${mechs[1].size}, shared ${shared}, union ${mechs[0].size + mechs[1].size - shared}; Chapman `,
      [Math.round(chapman * 10) / 10, 1], " is a lower bound"]);
    const wrong = lines.filter((parts, i) => !figureLine(text, parts, i === 2));
    if (wrong.length) errors.push(`${stratum}: the record's session agreement lines are not the ones the screening files give (${wrong.length} of 3 differ)`);
  }
  return errors;
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
    const ids = new Map();
    for (const side of ["A", "B"]) for (const row of io.jsonl(`${stratum}-screen-${side}.jsonl`)) ids.set(row.order_rank, new Set([...(ids.get(row.order_rank) ?? []), ...(row.problems ?? [])]));
    const held = (rank) => facets.filter((f) => [...(ids.get(rank) ?? [])].some((problem) => topic.facets[f].problems.includes(problem)));
    const section = text.split(`## Stratum: ${stratum}\n\n`)[1]?.split("\n## ")[0] ?? "";
    const cells = new Map(section.split("\n").filter((l) => /^\| \d+ \| /.test(l)).map((l) => l.split(" | ")).map((c) => [Number(c[0].slice(2)), c]));
    const wrong = found.rows.filter((r) => {
      const c = cells.get(r.rank);
      return c?.[1] !== r.repo || c?.[2] !== r.commit || c?.[3] !== r.score || c?.[4] !== r.decision || c?.[6] !== r.reason || c?.at(-1) !== `${held(r.rank).join(", ") || "-"} |`;
    });
    if (wrong.length) errors.push(`${stratum}: the record's stage-2 rows ${wrong.slice(0, 10).map((r) => r.rank).join(", ")} do not hold the commit, scores, decision, reason and facets the screening files give`);
    const included = found.rows.filter((r) => r.decision === "eligible" || r.decision === "study");
    const pairs = {};
    for (const r of included) {
      const mine = held(r.rank);
      mine.forEach((f, i) => mine.slice(i + 1).forEach((g) => { pairs[`${f}+${g}`] = (pairs[`${f}+${g}`] ?? 0) + 1; }));
    }
    const per = facets.map((f) => `${f} ${included.filter((r) => held(r.rank).includes(f)).length}`).join(", ");
    const bare = included.filter((r) => !ids.get(r.rank)?.size);
    if (bare.length) errors.push(`${stratum}: included rank ${bare[0].rank} names no registry problem at stage 2; eligibility means addressing a registry problem`);
    const line = `- ${stratum}: ${included.length} repositories included once each; counted per facet ${per}; overlap ${Object.entries(pairs).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; `
      + "facets come from the problem ids the stage-2 sessions name, at least one per included row";
    if (!text.split("\n").includes(line)) errors.push(`${stratum}: the record's facet line is not the inclusion the files give ("${line}")`);
  }
  return errors;
}
