import { CALIBRATED, canonical, lower, sha256 } from "./sweep-method-evidence-v4-shared.mjs";

const SET_SIZE = 60;
const LIKELY_TOP = 10;
const TOP_UP = [30, 40];
const HELD_OUT = /^held-out(?:-\d+)?$/;

const pyDumps = (value) => {
  if (Array.isArray(value)) return `[${value.map(pyDumps).join(", ")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}: ${pyDumps(value[k])}`).join(", ")}}`;
  return JSON.stringify(value);
};

export const examplesSha256 = (topic) => sha256((topic?.stage1_examples ?? []).map(pyDumps).join("\n"));

export function calibrationBatches(files) {
  const held = files.map((f) => f.match(/^(held-out(?:-\d+)?)-set\.json$/)?.[1]).filter(Boolean)
    .sort((a, b) => (Number(a.split("-")[2]) || 1) - (Number(b.split("-")[2]) || 1));
  return [...["calibration", "top-up"].filter((b) => files.includes(`${b}-set.json`)), ...held];
}

function drawStratum(io, topic, batch, earlier, stratum, size, readable) {
  const seed = `${topic.sweep}:${batch}:${stratum}`;
  const key = (tag) => (row) => sha256(`${seed}:${tag}:${row.order_rank}`);
  const byKey = (tag) => (a, b) => (key(tag)(a) < key(tag)(b) ? -1 : 1);
  const enriched = batch !== "calibration";
  const candidates = new Set(io.jsonl("qgs-candidates.jsonl").map((r) => lower(r.repo)));
  const before = new Set(earlier.flatMap((b) => (io.json(`${b}-set.json`)?.rows ?? []).filter((r) => r.stratum === stratum).map((r) => r.order_rank)));
  const examples = new Set((topic.stage1_examples ?? []).map((e) => lower(e.repo)));
  const order = io.jsonl(`${stratum}-screening-order.jsonl`).filter((r) => !examples.has(lower(r.repo)));
  const facets = Object.keys(topic.facets ?? {});
  const picked = new Map();
  const drawn = [];
  const take = (queue, want) => {
    const taken = [];
    while (queue.length && taken.length < want) {
      const row = queue.shift();
      if (!picked.has(row.order_rank) && readable(row)) taken.push(row);
    }
    return taken;
  };
  for (const [index, facet] of facets.entries()) {
    const share = Math.floor(size / facets.length) + (index < size % facets.length ? 1 : 0);
    const ranks = new Map((io.json(`facets/${facet}/${stratum}-ranked.json`)?.rows ?? []).map((r) => [lower(r.repo), r.order_rank]));
    const pool = order.filter((r) => ranks.has(lower(r.repo)) && !before.has(r.order_rank)).sort((a, b) => ranks.get(lower(a.repo)) - ranks.get(lower(b.repo)));
    const isLikely = (r) => candidates.has(lower(r.repo)) || ranks.get(lower(r.repo)) <= LIKELY_TOP;
    const likely = pool.filter(isLikely).sort(byKey(`${facet}:likely`));
    const others = pool.filter((r) => !isLikely(r));
    const random = new Set(enriched ? [] : others.map((r) => r.order_rank));
    if (!enriched) others.sort(byKey(`${facet}:random`));
    const rows = take(likely, enriched ? share : Math.ceil(share / 2));
    rows.push(...take(others, share - rows.length));
    rows.push(...take(likely, share - rows.length));
    if (rows.length < share) return null;
    for (const row of rows) {
      picked.set(row.order_rank, row);
      const kind = random.has(row.order_rank) ? "random" : candidates.has(lower(row.repo)) ? "qgs candidate" : "top-ranked";
      drawn.push({ order_rank: row.order_rank, facet, class: kind, facet_rank: ranks.get(lower(row.repo)) });
    }
  }
  return drawn.sort(byKey("order")).map((d) => ({ row: picked.get(d.order_rank), how: d }));
}

export function calibrationErrors(io, topic) {
  const errors = [];
  const strata = CALIBRATED.filter((s) => topic?.strata?.[s]?.channels && typeof topic.strata[s].channels === "object");
  const examples = new Set((topic?.stage1_examples ?? []).map((e) => lower(e.repo)));
  const freeze = io.json("stage1-freeze.json");
  if (freeze && freeze.examples_sha256 !== examplesSha256(topic)) errors.push("stage1-freeze.json froze other worked examples than the topic config's stage1_examples hold now");
  const batches = calibrationBatches(io.files ?? []);
  for (const [position, batch] of batches.entries()) {
    const text = io.read(`${batch}-set.json`);
    const sample = JSON.parse(text);
    const draw = io.json(`${batch}-draw.json`);
    if (draw?.set_sha256 !== sha256(text)) errors.push(`${batch}-draw.json was written for another ${batch} set; the draw records the hash of the set it wrote`);
    const sizes = sample.rows_per_stratum ?? {};
    const total = Object.values(sizes).reduce((a, b) => a + b, 0);
    const split = Object.fromEntries(strata.map((s, i) => [s, Math.floor(total / strata.length) + (i < total % strata.length ? 1 : 0)]));
    const fits = batch === "calibration" ? canonical(sizes) === canonical(Object.fromEntries(strata.map((s) => [s, SET_SIZE])))
      : total >= TOP_UP[0] && total <= TOP_UP[1] && canonical(sizes) === canonical(split);
    if (!fits) errors.push(`${batch}-set.json holds ${canonical(sizes)} rows per stratum; ${batch === "calibration" ? `the calibration set holds ${SET_SIZE} per stratum` : "a later batch holds 30 to 40 rows split evenly over the strata"}`);
    const leaked = (sample.rows ?? []).filter((r) => examples.has(lower(r.repo))).map((r) => r.repo);
    if (leaked.length) errors.push(`${batch}-set.json holds stage-1 worked-example repositories ${leaked.join(", ")}`);
    if (HELD_OUT.test(batch) && sample.rung_sha256 !== sha256(io.read("stage1-rung.json") ?? "")) {
      errors.push(`${batch}-set.json was not drawn after the current stage1-rung.json; a held-out batch is drawn once the rung is chosen`);
    }
    const rows = [];
    const provenance = [];
    let complete = true;
    for (const [stratum, count] of Object.entries(sizes)) {
      const gone = new Set(draw?.skipped?.[stratum] ?? []);
      const found = drawStratum(io, topic, batch, batches.slice(0, position), stratum, count, (row) => !gone.has(row.order_rank));
      if (!found) {
        complete = false;
        continue;
      }
      found.forEach(({ row, how }, i) => {
        const id = `${batch}-${stratum}-${i + 1}`;
        rows.push({ id, stratum, order_rank: row.order_rank, repo: row.repo });
        provenance.push({ id, facet: how.facet, class: how.class, facet_rank: how.facet_rank });
      });
    }
    const written = (sample.rows ?? []).map((r) => ({ id: r.id, stratum: r.stratum, order_rank: r.order_rank, repo: r.repo }));
    if (!complete || canonical(written) !== canonical(rows) || canonical(draw?.rows ?? []) !== canonical(provenance)) {
      errors.push(`${batch}-set.json is not the set its seed, the pools and the recorded unreadable rows give; a batch is drawn once, by draw-calibration-set.py`);
    }
  }
  return errors;
}
