import { stage1AuditErrors, stage1Errors } from "./sweep-method-evidence-v4-stage1.mjs";
import { prismaErrors, stage2Errors } from "./sweep-method-evidence-v4-stage2.mjs";
import {
  CALIBRATED,
  KAPPA_FLOOR,
  RECALL_TARGET,
  SENSITIVITY_FLOOR,
  blockHashes,
  covered,
  kappa,
  labelledRows,
  lower,
  reader,
} from "./sweep-method-evidence-v4-shared.mjs";

export { canonical, kappa, lowerBound } from "./sweep-method-evidence-v4-shared.mjs";

const DROP_COPY = /^dropped\/[\w.-]+$/;

function qgsErrors({ json, jsonl }, topic) {
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
  return { errors, members, strata };
}

function judgeErrors(io, topic, sessions, strata, rows) {
  const errors = [];
  const freeze = io.json("protocol-freeze.json");
  const roster = [["qgs-A", topic?.qgs_judges?.A?.model, "thin"], ["qgs-B", topic?.qgs_judges?.B?.model, "thin"], ["reader", topic?.reader?.model, "thin"],
    ["screening-A", freeze?.session_a?.model, "full"], ["screening-B", freeze?.session_b?.chosen?.model, "full"]];
  const validated = {};
  for (const [judge, model, shape] of roster) {
    if (!model) {
      errors.push(`${judge}: the topic config or the freeze names no model`);
      continue;
    }
    validated[judge] = new Set();
    for (const stratum of strata) {
      const mine = rows.filter((r) => r.stratum === stratum);
      for (const run of [1, 2]) {
        const key = `judge-${stratum}-${judge}-${model}-run${run}`;
        const entry = sessions[key];
        if (!entry?.blocks?.length) {
          errors.push(`${key}: meta.json records no validation run on the calibration rows`);
          continue;
        }
        const hashes = blockHashes(entry);
        if (mine.some((r) => hashes[String(r.order_rank)] !== (shape === "thin" ? r.qgs_sha256 : r.inputs_sha256))) errors.push(`${key}: the run judged other inputs than the calibration rows hold in the ${shape} shape`);
        if (entry.blocks.some((b) => b.shape !== shape)) errors.push(`${key}: the run read another input shape than the ${shape} shape its production runs read`);
        entry.blocks.forEach((b) => validated[judge].add(b.packet_sha256));
        if (shape !== "thin") continue;
        const answers = new Map(io.jsonl(`${key}.jsonl`).map((r) => [r.order_rank, r.verdict === "yes"]));
        const pairs = mine.map((r) => [r.user?.Relevance === 1, answers.get(r.order_rank) === true]);
        const positives = pairs.filter(([t]) => t);
        const sensitivity = positives.length ? positives.filter(([, d]) => d).length / positives.length : null;
        const k = kappa(pairs);
        if (sensitivity === null || sensitivity < SENSITIVITY_FLOOR || k === null || k < KAPPA_FLOOR) {
          errors.push(`${key}: ${judge} ${model} does not qualify on the ${stratum} calibration rows (sensitivity ${sensitivity}, kappa ${k}); a judge that fails is replaced before use`);
        }
      }
    }
  }
  for (const [judge, file, model] of [["qgs-A", "qgs-judge-A", topic?.qgs_judges?.A?.model], ["qgs-B", "qgs-judge-B", topic?.qgs_judges?.B?.model], ["reader", "qgs-reader", topic?.reader?.model]]) {
    const entry = sessions[file];
    const ids = io.jsonl(`${file}.jsonl`).map((r) => r.id);
    const blocks = entry?.blocks ?? [];
    const outside = entry?.model !== model || blocks.some((b) => b.shape !== "thin" || !validated[judge]?.has(b.packet_sha256));
    const coveredIds = covered(entry);
    if (ids.length && (outside || ids.some((id) => !coveredIds.has(id)))) {
      errors.push(`${file}.jsonl: its judgments come from outside the validated workflow (not all ${model} runs on the thin inputs under a validated packet)`);
    }
  }
  return errors;
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
  }
  return errors;
}

function dropErrors(io, read, meta) {
  const errors = [];
  for (const drop of meta.drops ?? []) {
    if (!String(drop?.reason ?? "").trim()) errors.push(`a drop of ${drop?.key} ranks ${drop?.ranks} records no reason`);
    if (!DROP_COPY.test(String(drop?.copy ?? "")) || read(`${drop.copy}.block.json`) === undefined) errors.push(`the drop of ${drop?.key} ranks ${drop?.ranks} has no copy of its block in the sweep folder`);
  }
  const runLike = /^(?:judge-.+|stage1-(?!inputs-).+|qgs-judge-[AB]|qgs-reader|[a-z0-9]+-(?:stage1-)?audit-.+|[a-z0-9]+-screen-[AB]|[a-z0-9]+-pilot-.+)\.jsonl$/;
  for (const file of io.files ?? []) {
    if (!runLike.test(file)) continue;
    const key = file.slice(0, -6).replace(/^([a-z0-9]+)-screen-([AB])$/, "$1-$2");
    if (!meta.sessions?.[key]) errors.push(`${file} has no session in meta.json: its rows count only when a recorded run produced them`);
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

function recallErrors(io, text, topic, strata, members, passes, screened) {
  const errors = [];
  const pools = Object.fromEntries(strata.map((s) => [s, new Map([...(passes[s]?.pool ?? new Map()).values()].map((r) => [lower(r.repo), r.order_rank]))]));
  const count = (list) => {
    const inPool = list.filter((m) => strata.some((s) => pools[s].has(m)));
    const passed = inPool.filter((m) => strata.some((s) => pools[s].has(m) && passes[s].passed.has(pools[s].get(m))));
    const done = passed.filter((m) => strata.some((s) => pools[s].has(m) && screened[s]?.both.has(pools[s].get(m))));
    return [done.length, list.length];
  };
  const [found, size] = count(members);
  const line = text.match(/^- pooled topic recall (\d+)\/(\d+) /m);
  if (!line || Number(line[1]) !== found || Number(line[2]) !== size) errors.push(`pooled topic recall: the record says ${line ? `${line[1]}/${line[2]}` : "nothing"}, the files give ${found}/${size}`);
  if (size && found / size < RECALL_TARGET && !/^- recall target not reached: /m.test(text)) errors.push("pooled topic recall is below the target and the record names no recall target threat");
  const labels = Object.fromEntries(Object.entries(io.json("qgs-adjudicated.json")?.labels ?? {}).map(([m, p]) => [lower(m), p]));
  for (const [facet, rule] of Object.entries(topic?.facets ?? {})) {
    const mine = members.filter((m) => (labels[m] ?? []).some((p) => rule.problems.includes(p)));
    const [k, n] = count(mine);
    const written = text.match(new RegExp(`^- facet ${facet}: recall (\\d+)/(\\d+) `, "m"));
    if (!written || Number(written[1]) !== k || Number(written[2]) !== n) errors.push(`facet ${facet} recall: the record says ${written ? `${written[1]}/${written[2]}` : "nothing"}, the files give ${k}/${n}`);
  }
  const snow = io.jsonl("snowball-screening-order.jsonl").filter((r) => !pools.config?.has(lower(r.repo)));
  if (snow.length) errors.push(`snowballed repositories ${snow.map((r) => r.repo).join(", ")} are not in the config stage-1 pool`);
  const cut = io.json("snowball-cut.json")?.cut_row;
  if (cut !== undefined && cut !== null) errors.push(`snowball-cut.json cuts the snowball at row ${cut}; quality criteria v4 refuses a snowball cut, every snowballed repository joins the pool`);
  if (topic?.strata?.product?.channels?.config_pool === true && strata.includes("product")) {
    const joined = io.json("config-pool-channel.json")?.joined;
    const written = text.match(/^- product channel from the config pool: (\d+) repositories joined/m);
    if (!Array.isArray(joined) || !written || Number(written[1]) !== joined.length) errors.push("the config-pool channel count is not the one config-pool-channel.json gives");
  }
  return errors;
}

export function v4Errors(text, { read, files, topic, meta }) {
  const io = { ...reader(read), read, topic, files, text };
  const sessions = meta.sessions ?? {};
  const strata = CALIBRATED.filter((s) => topic?.strata?.[s]?.channels && typeof topic.strata[s].channels === "object");
  if (!Object.keys(topic?.facets ?? {}).length) return ["a quality criteria v4 record needs a topic config that declares its facets"];
  const batches = ["calibration", ...(read("top-up-labels.json") !== undefined ? ["top-up"] : [])];
  const labelled = labelledRows(io, read, batches);
  const qgs = qgsErrors(io, topic);
  const stage1 = stage1Errors(io, sessions, strata, labelled.rows);
  const stage2 = stage2Errors(io, sessions, strata, stage1.passes, qgs.members);
  return [
    ...labelled.errors,
    ...qgs.errors,
    ...judgeErrors(io, topic, sessions, strata, labelled.rows),
    ...stage1.errors,
    ...stage1AuditErrors(io, topic, strata, stage1.passes, stage1.rung),
    ...facetRankingErrors(io, topic, strata),
    ...stage2.errors,
    ...dropErrors(io, read, meta),
    ...prismaErrors(io, text, strata, stage1.passes, stage2.screened),
    ...recallErrors(io, text, topic, strata, qgs.members, stage1.passes, stage2.screened),
  ];
}
