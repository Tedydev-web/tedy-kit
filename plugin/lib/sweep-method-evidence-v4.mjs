import { MalformedRow } from "./sweep-screening-derive.mjs";
import { proseErrors } from "./sweep-method-evidence-v4-prose.mjs";
import { calibrationErrors } from "./sweep-method-evidence-v4-calibration.mjs";
import { judgeErrors } from "./sweep-method-evidence-v4-judges.mjs";
import { stage1AuditErrors, stage1Errors } from "./sweep-method-evidence-v4-stage1.mjs";
import { agreementErrors, decisionErrors, prismaErrors, stage2Errors } from "./sweep-method-evidence-v4-stage2.mjs";
import {
  CALIBRATED,
  RECALL_TARGET,
  canonical,
  covered,
  escapeRegex,
  figureLine,
  interval,
  kappa,
  labelledRows,
  lower,
  reader,
} from "./sweep-method-evidence-v4-shared.mjs";

export { canonical, kappa, lowerBound } from "./sweep-method-evidence-v4-shared.mjs";

const DROP_COPY = /^dropped\/[\w.-]+$/;
const AUDIT_KEY = /^[a-z0-9]+-audit-(.+)$/;
const CROSS_FILE = /^qgs-cross-(.+)\.jsonl$/;

function crossQgsErrors(text, model, sides, cross) {
  const head = `- cross-family QGS judge ${model}: `;
  if (!cross.size) return text.split("\n").includes(`${head}no judgment kept`) ? [] : [`the record's cross-family QGS line does not say that no ${model} judgment was kept`];
  const overlap = [...cross.keys()].filter((id) => sides.A.has(id) && sides.B.has(id));
  const onlyCross = overlap.filter((id) => sides.A.get(id).verdict === "no" && sides.B.get(id).verdict === "no" && cross.get(id).verdict === "yes");
  const parts = ["A", "B"].flatMap((side, i) => {
    const pairs = overlap.map((id) => [sides[side].get(id).verdict === "yes", cross.get(id).verdict === "yes"]);
    const k = pairs.length ? kappa(pairs) : null;
    return [`${i ? ", " : ""}with qgs-${side} ${pairs.filter(([a, b]) => a === b).length}/${overlap.length} (kappa `, k === null ? "undefined (one category)" : [k, 3], ")"];
  });
  const line = [`${head}${cross.size} candidates judged, joined by repository name, ${overlap.length} also judged by both Claude judges; agreement `, ...parts,
    `; ${onlyCross.length} candidates both Claude judges rejected and it accepted went to the reader, which accepted ${onlyCross.filter((id) => sides.reader.get(id)?.verdict === "yes").length}`];
  return figureLine(text, line) ? [] : ["the record's cross-family QGS line is not the agreement the QGS judge files give"];
}

function qgsErrors({ json, jsonl, text }, topic) {
  const errors = [];
  const candidates = new Map(jsonl("qgs-candidates.jsonl").map((c) => [c.id, c.repo]));
  if (!candidates.size) return { errors: ["no qgs-candidates.jsonl in the sweep folder: the QGS is built once per topic"], members: [] };
  const drops = json("qgs-dropped.json") ?? {};
  for (const [id, drop] of Object.entries(drops)) if (!String(drop?.reason ?? "").trim()) errors.push(`QGS candidate ${id} is dropped without a reason`);
  const sides = {};
  for (const [side, name] of [["A", "qgs-judge-A.jsonl"], ["B", "qgs-judge-B.jsonl"], ["reader", "qgs-reader.jsonl"]]) {
    sides[side] = new Map();
    for (const row of jsonl(name)) {
      if (lower(candidates.get(row.id)) !== lower(row.repo)) errors.push(`${name} id ${row.id} names ${row.repo}, but candidate ${row.id} is ${candidates.get(row.id)}`);
      const strata = Array.isArray(row.strata) ? row.strata : [];
      if ((row.verdict === "yes") !== (strata.length > 0) || strata.some((s) => !CALIBRATED.includes(s))) errors.push(`${name} id ${row.id}: a yes names its strata (config, product or both), any other verdict none`);
      sides[side].set(row.id, row);
    }
  }
  const gaps = [...candidates].filter(([id]) => !(String(id) in drops) && !(sides.A.has(id) && sides.B.has(id)));
  for (const [id, repo] of gaps) errors.push(`QGS gap: candidate ${id} ${repo} is not judged by both judges and not dropped with a reason`);
  const byName = new Map([...candidates].map(([id, repo]) => [lower(repo), id]));
  const cross = new Map();
  const model = topic?.cross_family?.model;
  for (const row of model ? jsonl(`qgs-cross-${model}.jsonl`) : []) {
    const id = byName.get(lower(row.repo));
    if (id === undefined) errors.push(`qgs-cross-${model}.jsonl names ${row.repo}, which is not a candidate; the cross-family judgments join by repository name`);
    else if (row.id !== undefined && row.id !== id) errors.push(`qgs-cross-${model}.jsonl row id ${row.id} names ${row.repo}, which is candidate ${id}; the join is by repository name and the two disagree`);
    else cross.set(id, row);
  }
  const members = [];
  const strata = {};
  const queue = { disputed: 0, cross: 0, both: 0 };
  for (const [id, a] of sides.A) {
    const b = sides.B.get(id);
    if (!b) continue;
    queue.both += 1;
    if (a.verdict !== b.verdict || a.verdict === "unsure") queue.disputed += 1;
    else if (a.verdict === "no" && cross.get(id)?.verdict === "yes") queue.cross += 1;
  }
  for (const [id, a] of sides.A) {
    const b = sides.B.get(id);
    if (!b) continue;
    const queued = a.verdict !== b.verdict || a.verdict === "unsure" || (a.verdict === "no" && b.verdict === "no" && cross.get(id)?.verdict === "yes");
    if (a.verdict === "yes" && b.verdict === "yes") {
      members.push(lower(a.repo));
      strata[lower(a.repo)] = [...new Set([...(a.strata ?? []), ...(b.strata ?? [])])].sort();
    } else if (queued && sides.reader.get(id)?.verdict === "yes") {
      members.push(lower(a.repo));
      strata[lower(a.repo)] = [...new Set(sides.reader.get(id).strata ?? [])].sort();
    } else if (queued && !sides.reader.has(id)) errors.push(`QGS candidate ${id} ${a.repo} is queued for the reader, who has not judged it`);
  }
  const adjudicated = json("qgs-adjudicated.json") ?? {};
  const written = new Set((adjudicated.final ?? []).map(lower));
  if (written.size !== members.length || members.some((m) => !written.has(m))) errors.push("qgs-adjudicated.json is not the standard the judge, reader and cross-family files give");
  const writtenStrata = Object.fromEntries(Object.entries(adjudicated.strata ?? {}).map(([m, s]) => [lower(m), [...s].sort()]));
  if (members.some((m) => JSON.stringify(writtenStrata[m]) !== JSON.stringify(strata[m]))) errors.push("qgs-adjudicated.json does not hold the member strata the judges labelled");
  const line = `- standard: ${members.length} members from ${candidates.size} candidates; ${queue.both} judged by both Claude judges; reader queue ${queue.disputed} disputed or unsure, `
    + `${queue.cross} cross-family only; dropped ${Object.keys(drops).length}`;
  const dropped = Object.entries(drops).sort(([a], [b]) => Number(a) - Number(b)).map(([id, d]) => `; dropped ${id} ${d.repo} (${d.reason}, ${d.date})`).join("");
  if (!text.split("\n").includes(`${line}${dropped}`)) errors.push(`the record's standard line is not the one the QGS files give ("${line}${dropped}")`);
  if (model) errors.push(...crossQgsErrors(text, model, sides, cross));
  return { errors, members, strata };
}

function facetRankingErrors(io, topic, strata) {
  const errors = [];
  const same = (a, b) => JSON.stringify([...(a ?? [])].map(lower).sort()) === JSON.stringify([...(b ?? [])].map(lower).sort());
  for (const [facet, rule] of Object.entries(topic?.facets ?? {})) {
    for (const stratum of strata) {
      const ranked = io.json(`facets/${facet}/${stratum}-ranked.json`);
      if (!ranked) errors.push(`no facets/${facet}/${stratum}-ranked.json in the sweep folder: a facet's ranking orders stage 2 when it must stop`);
      else if (!same(ranked.terms, rule.terms)) errors.push(`facets/${facet}/${stratum}-ranked.json was ranked with the terms ${JSON.stringify(ranked.terms)}, not the facet's own ${JSON.stringify(rule.terms)}`);
    }
    const line = `- ${facet}: problems ${rule.problems.join(", ")}; terms ${rule.terms.join(", ")}; its ranking orders stage 2 only when stage 2 must stop`;
    if (!io.text.split("\n").includes(line)) errors.push(`the record's facet ${facet} line is not the topic config's ("${line}")`);
  }
  return errors;
}

function dropErrors(io, read, meta, dropped) {
  const errors = [];
  for (const drop of meta.drops ?? []) {
    if (!String(drop?.reason ?? "").trim()) errors.push(`a drop of ${drop?.key} ranks ${drop?.ranks} records no reason`);
    if (!DROP_COPY.test(String(drop?.copy ?? "")) || read(`${drop.copy}.block.json`) === undefined) errors.push(`the drop of ${drop?.key} ranks ${drop?.ranks} has no copy of its block in the sweep folder`);
  }
  const copies = new Set((meta.drops ?? []).map((d) => d?.copy));
  const loose = [...new Set(dropped.map((name) => `dropped/${name.replace(/\.(?:block\.json|rows\.jsonl|inputs\.jsonl)$/, "")}`))].filter((copy) => !copies.has(copy)).sort();
  if (loose.length) errors.push(`${loose.join(", ")}: a dropped copy without its meta.json drops entry; a run is dropped only by drop-run.py, which records both`);
  const runLike = /^(?:judge-.+|stage1-(?!inputs-).+|qgs-judge-[AB]|qgs-reader|[a-z0-9]+-(?:stage1-)?audit-.+|[a-z0-9]+-screen-[AB]|[a-z0-9]+-pilot-.+)\.jsonl$/;
  for (const file of io.files ?? []) {
    if (!runLike.test(file)) continue;
    const key = file.slice(0, -6).replace(/^([a-z0-9]+)-screen-([AB])$/, "$1-$2");
    if (!meta.sessions?.[key]) errors.push(`${file} has no session in meta.json: its rows count only when a recorded run produced them`);
  }
  const files = io.files ?? [];
  const missing = Object.keys(meta.sessions ?? {}).filter((key) => !files.includes(`${key.replace(/^([a-z0-9]+)-([AB])$/, "$1-screen-$2")}.jsonl`));
  if (missing.length) {
    errors.push(`meta.json records sessions ${missing.slice(0, 10).join(", ")} whose output files are not in the sweep folder; a recorded run's rows are never deleted, only dropped with drop-run.py`);
  }
  const audits = Object.keys(meta.sessions ?? {}).filter((key) => AUDIT_KEY.test(key));
  const model = io.topic?.cross_family?.model;
  const runs = [...new Set([...audits.map((key) => key.match(AUDIT_KEY)[1]), ...files.map((f) => f.match(CROSS_FILE)?.[1]).filter(Boolean)])].sort();
  if (runs.some((m) => m !== model)) {
    errors.push(`the sweep folder holds cross-family runs of ${runs.join(", ")}, but the topic's cross_family is ${model ?? "none"}; a topic config edit never removes the cross-family audit or QGS judgments that ran`);
  }
  if (audits.length && !files.includes("audit-sample.json")) {
    errors.push(`meta.json records the cross-family audit sessions ${audits.sort().join(", ")}, but the sweep folder has no audit-sample.json they screened`);
  }
  for (const [key, entry] of Object.entries(meta.sessions ?? {})) {
    const rows = io.jsonl(`${key}.jsonl`);
    if (!rows.length || /-(?:screen|pilot)-/.test(`${key}.jsonl`) || /^[a-z0-9]+-[AB]$/.test(key)) continue;
    const blocks = covered(entry);
    const loose = rows.map((r) => r.order_rank ?? r.id).filter((r) => !blocks.has(r));
    if (loose.length) errors.push(`${key}.jsonl holds rows ${loose.slice(0, 10).join(", ")} that no recorded block covers; drop or rerun a block with the redo tools, never by editing meta.json`);
  }
  return errors;
}

function recallErrors(io, text, topic, strata, members, memberStrata, passes, screened) {
  const errors = [];
  const pools = Object.fromEntries(strata.map((s) => [s, new Map([...(passes[s]?.pool ?? new Map()).values()].map((r) => [lower(r.repo), r.order_rank]))]));
  const count = (list) => {
    const inPool = list.filter((m) => strata.some((s) => pools[s].has(m)));
    const passed = inPool.filter((m) => strata.some((s) => pools[s].has(m) && passes[s].passed.has(pools[s].get(m))));
    const done = passed.filter((m) => strata.some((s) => pools[s].has(m) && screened[s]?.both.has(pools[s].get(m))));
    return [done.length, list.length, inPool.length, passed.length, done];
  };
  const rates = (line) => (line ? line.slice(1).map(Number) : null);
  const rate = (k, n) => (n ? [`${k}/${n} (`, [k / n, 3], ", 95% CI ", [interval(k, n)[0], 2], "-", [interval(k, n)[1], 2], ")"] : ["0/0 (no member)"]);
  const [found, size, inPool, passed, done] = count(members);
  const line = rates(text.match(/^- pooled topic recall (\d+)\/(\d+) .*?; in-pool rate (\d+)\/(\d+) .*?; stage-1 pass rate of in-pool members (\d+)\/(\d+) /m));
  if (canonical(line) !== canonical([found, size, inPool, size, passed, inPool])) {
    errors.push(`pooled topic recall: the record says ${line ? `${line[0]}/${line[1]}, in-pool ${line[2]}/${line[3]}, stage-1 pass ${line[4]}/${line[5]}` : "nothing"}, `
      + `the files give ${found}/${size}, in-pool ${inPool}/${size}, stage-1 pass ${passed}/${inPool}`);
  }
  const met = size && found / size >= RECALL_TARGET;
  if (met && /^- recall target not reached: /m.test(text)) errors.push("the record names a recall target threat although pooled topic recall meets the target");
  const missed = members.filter((m) => !done.includes(m)).sort();
  const pooled = ["- pooled topic recall ", ...rate(found, size), ` of the ${size} deduplicated standard members, screened by both stage-2 sessions; in-pool rate `, ...rate(inPool, size),
    "; stage-1 pass rate of in-pool members ", ...rate(passed, inPool), met ? `; meets the ${RECALL_TARGET.toFixed(2)} target` : `; below the ${RECALL_TARGET.toFixed(2)} target; missed: ${missed.join(", ")}`];
  if (!figureLine(text, pooled)) errors.push("the record's pooled recall line is not the one the files give (rates, intervals, target and missed members)");
  const threat = text.match(/^- recall target not reached: pooled topic recall (\d+)\/(\d+); outside every pool (\d+), excluded by stage 1 (\d+), not screened in stage 2 (\d+)$/m);
  if (size && found / size < RECALL_TARGET && canonical(rates(threat)) !== canonical([found, size, size - inPool, inPool - passed, passed - found])) {
    errors.push("pooled topic recall is below the target and the record does not name the recall target threat with the losses the files give");
  }
  const labels = Object.fromEntries(Object.entries(io.json("qgs-adjudicated.json")?.labels ?? {}).map(([m, p]) => [lower(m), p]));
  for (const [facet, rule] of Object.entries(topic?.facets ?? {})) {
    const mine = members.filter((m) => (labels[m] ?? []).some((p) => rule.problems.includes(p)));
    const [k, n, a, b] = count(mine);
    const written = rates(text.match(new RegExp(`^- facet ${facet}: recall (\\d+)/(\\d+) .*?; in-pool rate (\\d+)/(\\d+) .*?; stage-1 pass rate (\\d+)/(\\d+) `, "m")));
    if (canonical(written) !== canonical([k, n, a, n, b, a])) {
      errors.push(`facet ${facet} recall: the record says ${written ? `${written[0]}/${written[1]}` : "nothing"} (in-pool and stage-1 pass rates included), the files give ${k}/${n}, in-pool ${a}/${n}, stage-1 pass ${b}/${a}`);
    }
    const full = [`- facet ${facet}: recall `, ...rate(k, n), ` of the ${n} members labelled for it; in-pool rate `, ...rate(a, n), "; stage-1 pass rate ", ...rate(b, a), "; reported, no pass or fail"];
    if (!figureLine(text, full)) errors.push(`the record's facet ${facet} recall line is not the one the files give (rates and intervals)`);
  }
  const snow = io.jsonl("snowball-screening-order.jsonl").filter((r) => !pools.config?.has(lower(r.repo)));
  if (snow.length) errors.push(`snowballed repositories ${snow.map((r) => r.repo).join(", ")} are not in the config stage-1 pool`);
  if (strata.includes("config")) {
    const key = (r) => `${r.order_rank}:${lower(r.repo)}`;
    const above = (rows) => [...new Set(rows.filter((r) => r.order_rank > 1000).map(key))].sort();
    const rows = io.jsonl("snowball-screening-order.jsonl").map(key);
    const unique = [...new Set(rows)].sort();
    const order = above(io.jsonl("config-screening-order.jsonl"));
    const inputs = above([...(passes.config?.pool.values() ?? [])]);
    if (unique.length !== rows.length || canonical(unique) !== canonical(order) || canonical(order) !== canonical(inputs)) {
      errors.push(`snowball-screening-order.jsonl holds ${rows.length} rows (${unique.length} distinct), but the config pool holds ${order.length} and the stage-1 inputs ${inputs.length} `
        + "snowballed rows above rank 1000; the snowball rows are the pool's own, once each");
    }
  }
  const snowballed = io.jsonl("snowball-screening-order.jsonl").length;
  if (snowballed && !text.split("\n").includes(`- snowball: ${snowballed} repositories from the aggregators joined the config pool from rank 1001 on (cut: ${io.json("snowball-cut.json")?.source}); stage 1 read every one`)) {
    errors.push(`the record's snowball line does not state the ${snowballed} snowballed repositories snowball-screening-order.jsonl holds`);
  }
  const cutFile = io.json("snowball-cut.json");
  if (!cutFile) errors.push("no snowball-cut.json in the sweep folder; under quality criteria v4 snowball-above-cut.py --all records cut_row null");
  const cut = cutFile?.cut_row;
  if (cut !== undefined && cut !== null) errors.push(`snowball-cut.json cuts the snowball at row ${cut}; quality criteria v4 refuses a snowball cut, every snowballed repository joins the pool`);
  const switchedOn = topic?.strata?.product?.channels?.config_pool === true;
  if (!switchedOn && (io.files?.includes("config-pool-channel.json") || io.jsonl("product-screening-order.jsonl").some((r) => r.channels?.includes("config-pool")))) {
    errors.push("the sweep folder holds the config-pool channel's evidence (config-pool-channel.json or product rows credited with config-pool), but the topic config does not set "
      + "strata.product.channels.config_pool; a topic config edit never removes the requirement-5 line of a channel that ran");
  }
  if (switchedOn && strata.includes("product")) errors.push(...configPoolErrors(io, text, topic, strata, passes, pools, memberStrata));
  return errors;
}

function batchLineErrors(io, topic, strata, text) {
  const errors = [];
  const held = (io.files ?? []).map((f) => f.match(/^(held-out(?:-\d+)?)-set\.json$/)?.[1]).filter(Boolean);
  const lines = new Set(text.split("\n"));
  let pooled = 0;
  for (const batch of ["calibration", "top-up", ...held]) {
    const labels = io.json(`${batch}-labels.json`);
    if (!labels) continue;
    const drawn = new Map((io.json(`${batch}-draw.json`)?.rows ?? []).map((d) => [d.id, d]));
    const purpose = io.json(`${batch}-set.json`)?.purpose;
    for (const stratum of strata) {
      const rows = (labels.rows ?? []).filter((r) => r.stratum === stratum);
      const eligible = rows.filter((r) => r.user?.decision === "eligible").length;
      if (!batch.startsWith("held-out")) pooled += eligible;
      const facets = Object.keys(topic?.facets ?? {}).map((f) => `${f} ${rows.filter((r) => drawn.get(r.id)?.facet === f).length}`).join(", ");
      const line = `- ${batch} ${stratum}: ${rows.length} rows (${purpose}), drawn per facet ${facets}; likely positives ${rows.filter((r) => drawn.get(r.id)?.class !== "random").length}; `
        + `the user labelled ${eligible} eligible`;
      if (!lines.has(line)) errors.push(`the record's ${batch} ${stratum} batch line is not the one the label and draw files give ("${line}")`);
    }
  }
  if (!lines.has(`- positives pooled over the batches the rung was chosen on: ${pooled}`)) errors.push(`the record's pooled positives are not the ${pooled} the label files give`);
  return errors;
}

function productFilter(topic) {
  const channels = topic.strata.product.channels;
  const term = new RegExp(`(?<![a-z0-9])(${(topic.terms ?? []).map(escapeRegex).join("|")})(?![a-z0-9])`, "i");
  const harness = new RegExp(channels.harness ?? "(?!)", "i");
  const extra = channels.extra_text ? new RegExp(channels.extra_text, "i") : null;
  return (text) => harness.test(text) && (term.test(text) || Boolean(extra?.test(text)));
}

function configPoolErrors(io, text, topic, strata, passes, pools, memberStrata) {
  const errors = [];
  const joined = io.json("config-pool-channel.json")?.joined;
  if (!Array.isArray(joined)) return ["no config-pool-channel.json with its joined list: the topic draws the product channel from the config pool"];
  const names = new Set(joined.map(lower));
  const relevant = productFilter(topic);
  const product = new Set(io.jsonl("product-screening-order.jsonl").filter((r) => r.channels?.includes("config-pool")).map((r) => lower(r.repo)));
  const missed = [...(passes.config?.pool.values() ?? [])].filter((r) => relevant(`${r.repo} ${r.description ?? ""}`) && !(names.has(lower(r.repo)) && product.has(lower(r.repo))))
    .map((r) => r.repo);
  if (missed.length) errors.push(`the config-pool channel did not run on the final config pool: ${missed.slice(0, 10).join(", ")} pass the product filter but did not join the product pool before stage 1`);
  const stray = [...product].filter((repo) => !names.has(repo));
  if (stray.length) errors.push(`product-screening-order.jsonl credits the config-pool channel with ${stray.slice(0, 10).join(", ")}, which config-pool-channel.json does not list`);
  const labelled = Object.entries(memberStrata).filter(([, s]) => s.includes("product")).map(([m]) => m);
  const outside = labelled.filter((m) => !strata.some((s) => pools[s].has(m)));
  const line = `- product channel from the config pool: ${product.size} repositories joined the product pool before stage 1; they recover ${labelled.filter((m) => product.has(m)).length} of `
    + `the ${labelled.length} standard members the QGS judges labelled product; ${outside.length} of those members remain outside every pool`;
  if (!text.split("\n").includes(line)) errors.push(`the record's config-pool channel line is not the one the files give ("${line}")`);
  const gap = text.match(/^- discovery gap: (\d+) standard members labelled product are in no pool: (.*)$/m);
  const listed = gap ? gap[2].split(", ").map(lower).sort() : [];
  if (outside.length ? Number(gap?.[1]) !== outside.length || canonical(listed) !== canonical([...outside].sort()) : gap) {
    errors.push(`the record's discovery gap does not name the ${outside.length} product members the files leave outside every pool`);
  }
  return errors;
}

function recomputedErrors(text, { read, files, topic, meta, dropped = [] }) {
  const io = { ...reader(read), read, topic, files, text, sessions: meta.sessions ?? {} };
  const sessions = meta.sessions ?? {};
  const strata = CALIBRATED.filter((s) => topic?.strata?.[s]?.channels && typeof topic.strata[s].channels === "object");
  if (!Object.keys(topic?.facets ?? {}).length) return ["a quality criteria v4 record needs a topic config that declares its facets"];
  const batches = ["calibration", ...(read("top-up-labels.json") !== undefined ? ["top-up"] : [])];
  const labelled = labelledRows(io, read, batches);
  const qgs = qgsErrors(io, topic);
  const stage1 = stage1Errors(io, sessions, strata, labelled.rows);
  const stage2 = stage2Errors(io, sessions, strata, stage1.passes, qgs.members, stage1.rung?.rung);
  return [
    ...labelled.errors,
    ...calibrationErrors(io, topic),
    ...proseErrors(io, topic, strata, sessions, meta),
    ...batchLineErrors(io, topic, strata, text),
    ...qgs.errors,
    ...judgeErrors(io, topic, sessions, strata, labelled.rows, batches),
    ...stage1.errors,
    ...stage1AuditErrors(io, topic, strata, stage1.passes, stage1.rung),
    ...facetRankingErrors(io, topic, strata),
    ...stage2.errors,
    ...dropErrors(io, read, meta, dropped),
    ...prismaErrors(io, text, strata, stage1.passes, stage2.screened),
    ...decisionErrors(io, text, topic, strata, stage1.passes, stage2.screened),
    ...agreementErrors(io, text, strata),
    ...recallErrors(io, text, topic, strata, qgs.members, qgs.strata ?? {}, stage1.passes, stage2.screened),
  ];
}

export function v4Errors(text, evidence) {
  try {
    return recomputedErrors(text, evidence);
  } catch (error) {
    if (error instanceof MalformedRow) return [error.message];
    throw error;
  }
}
