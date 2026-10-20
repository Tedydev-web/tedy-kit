import { EMPTY_TABLE, derive } from "./sweep-screening-derive.mjs";
import { KAPPA_FLOOR, SENSITIVITY_FLOOR, blockHashes, covered, escapeRegex, kappa } from "./sweep-method-evidence-v4-shared.mjs";

const LABELLED = ["Authority", "Methodology", "Objectivity", "Position", "Relevance"];
const NUMBER = "(undefined|-?\\d+\\.\\d+)";

function metrics(pairs) {
  const tp = pairs.filter(([t, d]) => t && d).length;
  const fn = pairs.filter(([t, d]) => t && !d).length;
  const fp = pairs.filter(([t, d]) => d && !t).length;
  const tn = pairs.length - tp - fn - fp;
  const sensitivity = tp + fn ? tp / (tp + fn) : null;
  const k = kappa(pairs);
  return { sensitivity, specificity: tn + fp ? tn / (tn + fp) : null, kappa: k,
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

const close = (written, value, digits) => (value === null ? written === "undefined" : written !== "undefined" && Math.abs(Number(written) - value) <= 0.5 * 10 ** -digits + 1e-9);

function lineErrors(text, head, runs, differ, runKappa) {
  const part = (i) => `run ${i} sensitivity ${NUMBER}(?: \\(95% CI [0-9.]+-[0-9.]+\\))?, specificity ${NUMBER}, kappa ${NUMBER}(?: \\(one category\\))?; label agreement ([^;]*)`;
  const line = text.match(new RegExp(`^- ${escapeRegex(head)}: ${part(1)}; ${part(2)}; runs differ on (\\d+) of (\\d+) rows \\(kappa ${NUMBER}(?: \\(one category\\))?\\); qualified$`, "m"));
  if (!line) return [`the record has no judge line "- ${head}: ..." in the form the toolchain writes`];
  const ok = runs.every((run, i) => {
    const [sens, spec, k, labels] = line.slice(1 + 4 * i, 5 + 4 * i);
    const written = Object.fromEntries([...labels.matchAll(/(\w+) (\d+)\/(\d+)/g)].map((m) => [m[1], [Number(m[2]), Number(m[3])]]));
    return close(sens, run.sensitivity, 3) && close(spec, run.specificity, 3) && close(k, run.kappa, 3) && JSON.stringify(written) === JSON.stringify(run.labels);
  });
  if (!ok || Number(line[9]) !== differ.count || Number(line[10]) !== differ.rows || !close(line[11], runKappa, 3)) {
    return [`${head}: the record's judge metrics are not the ones the validation runs and the calibration labels give`];
  }
  return [];
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
