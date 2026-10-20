import { createHash } from "node:crypto";

const RECALL_TARGET = 0.8;
const SENSITIVITY_FLOOR = 0.9;
const KAPPA_FLOOR = 0.6;
const STAGE1_BOUND = 0.95;
const POSITIVES_NEEDED = 59;
const CALIBRATED = ["config", "product"];
const DROP_COPY = /^dropped\/[\w.-]+$/;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const lower = (name) => String(name ?? "").toLowerCase();

function logChoose(n, k) {
  let total = 0;
  for (let i = 1; i <= k; i += 1) total += Math.log(n - k + i) - Math.log(i);
  return total;
}

function tailAtLeast(k, n, p) {
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return 1;
  let total = 0;
  for (let i = k; i <= n; i += 1) total += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return total;
}

export function lowerBound(k, n, alpha = 0.05) {
  if (k === 0) return 0;
  let [lo, hi] = [0, 1];
  for (let step = 0; step < 100; step += 1) {
    const mid = (lo + hi) / 2;
    if (tailAtLeast(k, n, mid) < alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function kappa(pairs) {
  if (!pairs.length) return null;
  const n = pairs.length;
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  const yesA = pairs.filter(([a]) => a).length / n;
  const yesB = pairs.filter(([, b]) => b).length / n;
  const expected = yesA * yesB + (1 - yesA) * (1 - yesB);
  return expected < 1 ? (observed - expected) / (1 - expected) : null;
}

function reader(read) {
  const json = (name) => {
    const text = read(name);
    return text === undefined ? undefined : JSON.parse(text);
  };
  const jsonl = (name) => (read(name) ?? "").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  return { json, jsonl };
}

const covered = (entry) => new Set((entry?.blocks ?? []).flatMap((b) => b.ranks ?? []));
const blockHashes = (entry) => Object.assign({}, ...(entry?.blocks ?? []).map((b) => b.row_sha256 ?? {}));
const autoPass = (row) => !(row.description || row.asset_paths?.length || row.readme_lead || row.readme_lead_sha256);

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
  for (const [id, a] of sides.A) {
    const b = sides.B.get(id);
    if (!b) continue;
    const queued = a.verdict !== b.verdict || a.verdict === "unsure" || (a.verdict === "no" && b.verdict === "no" && cross.get(id)?.verdict === "yes");
    if (a.verdict === "yes" && b.verdict === "yes") members.push(lower(a.repo));
    else if (queued && sides.reader.get(id)?.verdict === "yes") members.push(lower(a.repo));
    else if (queued && !sides.reader.has(id)) errors.push(`QGS candidate ${id} ${a.repo} is queued for the reader, who has not judged it`);
  }
  const written = new Set((json("qgs-adjudicated.json")?.final ?? []).map(lower));
  if (written.size !== members.length || members.some((m) => !written.has(m))) errors.push("qgs-adjudicated.json is not the standard the judge, reader and cross-family files give");
  return { errors, members };
}

function labelledRows({ json }, read, batches) {
  const errors = [];
  const rows = [];
  const freeze = read("stage1-freeze.json");
  for (const batch of batches) {
    const set = read(`${batch}-set.json`);
    const labels = json(`${batch}-labels.json`);
    if (!set || !labels) {
      errors.push(`no ${batch}-set.json and ${batch}-labels.json in the sweep folder`);
      continue;
    }
    if (labels.set_sha256 !== sha256(set)) errors.push(`${batch}-labels.json was imported for another ${batch} set`);
    if (!freeze || labels.stage1_freeze_sha256 !== sha256(freeze)) errors.push(`${batch}-labels.json was not imported under stage1-freeze.json: the ladder is frozen before any label is read`);
    if (labels.complete !== labels.rows?.length) errors.push(`the user labelled ${labels.complete} of ${labels.rows?.length} ${batch} rows`);
    rows.push(...(labels.rows ?? []).map((r) => ({ ...r, batch })));
  }
  return { errors, rows };
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

function stage1Errors(io, sessions, strata, rows) {
  const errors = [];
  const freeze = io.json("stage1-freeze.json");
  const chosen = io.json("stage1-rung.json");
  if (!freeze || !chosen) return { errors: ["no stage1-freeze.json and stage1-rung.json in the sweep folder"], passes: {} };
  const inputs = {};
  const pass = (rung, stratum, names) => {
    const shapeRows = inputs[`${stratum}-${rung.shape}`] ??= new Map(io.jsonl(`stage1-inputs-${stratum}-${rung.shape}.jsonl`).map((r) => [r.order_rank, r]));
    const answers = rung.models.map((m) => new Map(io.jsonl(`${names(m)}.jsonl`).map((r) => [r.order_rank, r.verdict])));
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
    const held = labelledRows(io, io.read, ["held-out"]);
    errors.push(...held.errors);
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
    passes[stratum] = { pool, passed: new Set([...pool.keys()].filter((rank) => passed(rank) === true)), excluded: {} };
    for (const model of rung.models) {
      const key = `stage1-${stratum}-${rung.shape}-${model}`;
      const entry = sessions[key];
      if (entry?.model !== model || (entry?.blocks ?? []).some((b) => b.shape !== rung.shape || b.ranks.length > freeze.batch_max || b.packet_sha256 !== freeze.packets?.[stratum])) {
        errors.push(`${key}: the stage-1 pool run is not ${model} on the ${rung.shape} shape under the frozen packet in batches of at most ${freeze.batch_max}`);
      }
      passes[stratum].excluded[model] = io.jsonl(`${key}.jsonl`).filter((r) => r.verdict === "no").length;
    }
  }
  return { errors, passes, rung };
}

function stage2Errors(io, sessions, strata, passes) {
  const errors = [];
  const screened = {};
  for (const stratum of strata) {
    const plan = io.json(`${stratum}-stage2.json`);
    if (!plan) {
      errors.push(`no ${stratum}-stage2.json in the sweep folder`);
      continue;
    }
    const passed = passes[stratum]?.passed ?? new Set();
    if (plan.passes.length !== passed.size || plan.passes.some((r) => !passed.has(r))) errors.push(`${stratum}-stage2.json does not list the stage-1 passes the stage-1 files give`);
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

function dropErrors(io, read, meta) {
  const errors = [];
  for (const drop of meta.drops ?? []) {
    if (!String(drop?.reason ?? "").trim()) errors.push(`a drop of ${drop?.key} ranks ${drop?.ranks} records no reason`);
    if (!DROP_COPY.test(String(drop?.copy ?? "")) || read(`${drop.copy}.block.json`) === undefined) errors.push(`the drop of ${drop?.key} ranks ${drop?.ranks} has no copy of its block in the sweep folder`);
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

function prismaErrors(io, text, strata, passes, screened) {
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
  if (topic?.strata?.product?.channels?.config_pool === true && strata.includes("product")) {
    const joined = io.json("config-pool-channel.json")?.joined;
    const written = text.match(/^- product channel from the config pool: (\d+) repositories joined/m);
    if (!Array.isArray(joined) || !written || Number(written[1]) !== joined.length) errors.push("the config-pool channel count is not the one config-pool-channel.json gives");
  }
  return errors;
}

export function v4Errors(text, { read, topic, meta }) {
  const io = { ...reader(read), read, topic };
  const sessions = meta.sessions ?? {};
  const strata = CALIBRATED.filter((s) => new RegExp(`^## Stratum: ${s}$`, "m").test(text));
  if (!Object.keys(topic?.facets ?? {}).length) return ["a quality criteria v4 record needs a topic config that declares its facets"];
  const batches = ["calibration", ...(read("top-up-labels.json") !== undefined ? ["top-up"] : [])];
  const labelled = labelledRows(io, read, batches);
  const qgs = qgsErrors(io, topic);
  const stage1 = stage1Errors(io, sessions, strata, labelled.rows);
  const stage2 = stage2Errors(io, sessions, strata, stage1.passes);
  return [
    ...labelled.errors,
    ...qgs.errors,
    ...judgeErrors(io, topic, sessions, strata, labelled.rows),
    ...stage1.errors,
    ...stage2.errors,
    ...dropErrors(io, read, meta),
    ...prismaErrors(io, text, strata, stage1.passes, stage2.screened),
    ...recallErrors(io, text, topic, strata, qgs.members, stage1.passes, stage2.screened),
  ];
}
