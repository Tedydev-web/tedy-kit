import { EMPTY_TABLE, derive } from "./sweep-screening-derive.mjs";
import { KAPPA_FLOOR, SENSITIVITY_FLOOR, blockHashes, covered, figureLine, interval, kappa, sha256 } from "./sweep-method-evidence-v4-shared.mjs";

const LABELLED = ["Authority", "Methodology", "Objectivity", "Position", "Relevance"];

function metrics(pairs) {
  const tp = pairs.filter(([t, d]) => t && d).length;
  const fn = pairs.filter(([t, d]) => t && !d).length;
  const fp = pairs.filter(([t, d]) => d && !t).length;
  const tn = pairs.length - tp - fn - fp;
  const sensitivity = tp + fn ? tp / (tp + fn) : null;
  const k = kappa(pairs);
  return { tp, positives: tp + fn, sensitivity, specificity: tn + fp ? tn / (tn + fp) : null, kappa: k,
    passed: sensitivity !== null && sensitivity >= SENSITIVITY_FLOOR && k !== null && k >= KAPPA_FLOOR };
}

function labelAgreement(thin, rows, answers) {
  if (thin) {
    const both = rows.filter((r) => r.user?.Relevance === 1 && answers.get(r.order_rank)?.verdict === "yes");
    const same = (a, b) => JSON.stringify([...new Set(a ?? [])].sort()) === JSON.stringify([...new Set(b ?? [])].sort());
    return { problems: [both.filter((r) => same(r.user.problems, answers.get(r.order_rank).problems)).length, both.length] };
  }
  return Object.fromEntries(LABELLED.map((c) => [c, [rows.filter((r) => answers.get(r.order_rank)?.scores?.[c]?.v === r.user?.[c]).length, rows.length]]));
}

const ci = (k, n) => (n ? [" (95% CI ", [interval(k, n)[0], 2], "-", [interval(k, n)[1], 2], ")"] : []);
const value = (v, empty = "undefined") => (v === null ? [empty] : [[v, 3]]);

function lineErrors(text, head, runs, differ, runKappa) {
  const run = (r, i) => [`run ${i + 1} sensitivity `, ...(r.sensitivity === null ? ["undefined"] : [[r.sensitivity, 3], ...ci(r.tp, r.positives)]), ", specificity ", ...value(r.specificity),
    ", kappa ", ...value(r.kappa, "undefined (one category)"), "; label agreement ",
    ...Object.entries(r.labels).flatMap(([name, [k, n]], j) => [`${j ? ", " : ""}${name} ${k}/${n}`, ...ci(k, n)])];
  const parts = [`- ${head}: `, ...run(runs[0], 0), "; ", ...run(runs[1], 1), `; runs differ on ${differ.count} of ${differ.rows} rows (kappa `,
    ...value(runKappa, "undefined (one category)"), "); qualified"];
  if (!text.split("\n").some((l) => l.startsWith(`- ${head}: `))) return [`the record has no judge line "- ${head}: ..." in the form the toolchain writes`];
  return figureLine(text, parts) ? [] : [`${head}: the record's judge metrics are not the ones the validation runs and the calibration labels give`];
}

export function judgeErrors(io, topic, sessions, strata, rows, batches) {
  const errors = [];
  const freeze = io.json("protocol-freeze.json");
  const roster = [["qgs-A", topic?.qgs_judges?.A, "thin"], ["qgs-B", topic?.qgs_judges?.B, "thin"], ["reader", topic?.reader, "thin"],
    ["screening-A", freeze?.session_a, "full"], ["screening-B", freeze?.session_b?.chosen, "full"]];
  const validated = {};
  for (const [judge, option, shape] of roster) {
    const model = option?.model;
    if (!model) {
      errors.push(`${judge}: the topic config or the freeze names no model`);
      continue;
    }
    const thin = shape === "thin";
    validated[judge] = new Set();
    for (const stratum of strata) {
      const mine = rows.filter((r) => r.stratum === stratum);
      const runs = [];
      for (const run of [1, 2]) {
        const key = `judge-${stratum}-${judge}-${model}-run${run}`;
        const entry = sessions[key];
        if (!entry?.blocks?.length) {
          errors.push(`${key}: meta.json records no validation run on the calibration rows`);
          continue;
        }
        if (entry.cli !== option.cli || entry.model !== model) {
          errors.push(`${key}: the run was ${entry.cli} ${entry.model}, not the roster's ${option.cli} ${model} it validates; a validation run counts only for its own judge`);
        }
        const hashes = blockHashes(entry);
        if (mine.some((r) => hashes[String(r.order_rank)] !== (thin ? r.qgs_sha256 : r.inputs_sha256))) errors.push(`${key}: the run judged other inputs than the calibration rows hold in the ${shape} shape`);
        if (entry.blocks.some((b) => b.shape !== shape)) errors.push(`${key}: the run read another input shape than the ${shape} shape its production runs read`);
        const frozen = freeze?.strata?.[stratum];
        if (!thin && entry.blocks.some((b) => b.packet_sha256 !== frozen?.packet_sha256 || b.criteria_sha256 !== frozen?.criteria_sha256)) {
          errors.push(`${key}: a block ran under a packet or criteria other than the frozen ones`);
        }
        entry.blocks.forEach((b) => validated[judge].add(b.packet_sha256));
        const answers = new Map(io.jsonl(`${key}.jsonl`).map((r) => [r.order_rank, r]));
        const wanted = new Set(mine.map((r) => r.order_rank));
        const odd = [...new Set([...answers.keys(), ...wanted])].filter((r) => answers.has(r) !== wanted.has(r));
        if (odd.length) {
          errors.push(`${key}.jsonl covers ranks ${odd.slice(0, 10).join(", ")} that the ${stratum} calibration rows do not, or the reverse`);
          continue;
        }
        const decide = (row) => (thin ? row.verdict === "yes" : derive(EMPTY_TABLE, stratum, { A: {}, B: {} }, "A", row).decision === "eligible");
        const decisions = mine.map((r) => decide(answers.get(r.order_rank)));
        const result = metrics(mine.map((r, i) => [thin ? r.user?.Relevance === 1 : r.user?.decision === "eligible", decisions[i]]));
        if (!result.passed) {
          errors.push(`${key}: ${judge} ${model} does not qualify on the ${stratum} calibration rows (sensitivity ${result.sensitivity}, kappa ${result.kappa}); a judge that fails is replaced before use`);
        }
        runs.push({ ...result, decisions, labels: labelAgreement(thin, mine, answers) });
      }
      if (runs.length !== 2 || !mine.length) continue;
      const differ = { count: runs[0].decisions.filter((d, i) => d !== runs[1].decisions[i]).length, rows: mine.length };
      const runKappa = kappa(runs[0].decisions.map((d, i) => [d, runs[1].decisions[i]]));
      errors.push(...lineErrors(io.text, `${judge} ${option.cli} ${model}, ${stratum}, ${shape} inputs, batches ${batches.join(", ")}`, runs, differ, runKappa));
    }
  }
  for (const stratum of strata) {
    for (const [side, judge] of [["A", freeze?.session_a?.model], ["B", freeze?.session_b?.chosen?.model]]) {
      const entry = sessions[`${stratum}-${side}`];
      if (entry?.model !== judge || (entry?.blocks ?? []).some((b) => (b.shape ?? "full") !== "full")) {
        errors.push(`${stratum}-${side} did not run the validated screening-${side} ${judge} on the full inputs it was validated on`);
      }
    }
  }
  for (const [judge, file, option] of [["qgs-A", "qgs-judge-A", topic?.qgs_judges?.A], ["qgs-B", "qgs-judge-B", topic?.qgs_judges?.B], ["reader", "qgs-reader", topic?.reader]]) {
    const model = option?.model;
    const entry = sessions[file];
    const ids = io.jsonl(`${file}.jsonl`).map((r) => r.id);
    const blocks = entry?.blocks ?? [];
    const outside = entry?.model !== model || entry?.cli !== option?.cli || blocks.some((b) => b.shape !== "thin" || !validated[judge]?.has(b.packet_sha256));
    const coveredIds = covered(entry);
    if (ids.length && (outside || ids.some((id) => !coveredIds.has(id)))) {
      errors.push(`${file}.jsonl: its judgments come from outside the validated workflow (not all ${option?.cli} ${model} runs on the thin inputs under a validated packet)`);
    }
    const line = ids.length || entry ? `- QGS ${judge}: ${model} judged ${new Set(ids).size} candidates on the thin inputs it was validated on, under the validated packet`
      : "- QGS reader: no candidate was queued for the reader";
    if (!io.text.split("\n").includes(line)) errors.push(`the record's QGS ${judge} line is not the one ${file}.jsonl gives ("${line}")`);
  }
  const cross = topic?.cross_family;
  const crossKey = cross?.model ? `qgs-cross-${cross.model}` : null;
  if (crossKey && io.files?.includes(`${crossKey}.jsonl`)) {
    const entry = sessions[crossKey];
    const blocks = entry?.blocks ?? [];
    const ids = new Set(io.jsonl(`${crossKey}.jsonl`).map((r) => r.id));
    const ranks = covered(entry);
    const packet = sha256(io.read("qgs-packet.md") ?? "");
    if (entry?.cli !== cross.cli || entry?.model !== cross.model || !blocks.length || blocks.some((b) => b.shape !== "thin" || b.packet_sha256 !== packet)
      || ids.size !== ranks.size || [...ids].some((id) => !ranks.has(id))) {
      errors.push(`${crossKey}.jsonl: its judgments are not all ${cross.cli} ${cross.model} runs on the thin inputs under qgs-packet.md, covering exactly its rows`);
    }
  }
  return [...errors, ...qgsHashErrors(sessions, ["qgs-judge-A", "qgs-judge-B", "qgs-reader", ...(crossKey ? [crossKey] : [])])];
}

export function qgsHashErrors(sessions, names) {
  const seen = new Map();
  for (const name of names) {
    for (const block of sessions[name]?.blocks ?? []) {
      for (const rank of block.ranks ?? []) {
        const digest = block.row_sha256?.[String(rank)];
        seen.set(rank, (seen.get(rank) ?? new Set()).add(typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest) ? digest : null));
      }
    }
  }
  const split = [...seen].filter(([, digests]) => digests.size > 1 || digests.has(null)).map(([rank]) => rank).sort((a, b) => a - b);
  return split.length ? [`the QGS sessions judged candidates ${split.slice(0, 10).join(", ")} on different thin inputs, or recorded no input hash for them; every QGS judge reads the same candidate inputs`] : [];
}
