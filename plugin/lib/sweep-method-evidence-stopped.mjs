import { createHash } from "node:crypto";

export const STOPPED = /^- Status: stopped at the scale checkpoint on (\d{4}-\d{2}-\d{2}): /m;
const STOP_MARK = "stop at the scale checkpoint";
const QUALITY = ["Authority", "Methodology", "Objectivity", "Position"];
const NEED = 2;
const PASSES = [
  [1, (s) => s.stars >= 100 && s.quality >= 3],
  [2, (s) => s.authority === 1 && s.quality >= 3.5],
];

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const problemKey = (p) => [p.replace(/\d+$/, ""), Number(p.match(/\d+$/)?.[0] ?? 0)];
const byProblem = (a, b) => {
  const [x, y] = [problemKey(a), problemKey(b)];
  return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1];
};
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function sources(eligible) {
  const out = new Map();
  for (const row of eligible) {
    const key = row.repo.toLowerCase();
    const entry = out.get(key) ?? { repo: row.repo, problems: new Set(), quality: 0, authority: 0, stars: 0 };
    for (const p of row.problems) entry.problems.add(p);
    entry.quality = Math.max(entry.quality, QUALITY.reduce((sum, c) => sum + row[c], 0));
    entry.authority = Math.max(entry.authority, row.Authority);
    entry.stars = Math.max(entry.stars, row.stars);
    out.set(key, entry);
  }
  return [...out.values()];
}

export function deepPicks(eligible) {
  const held = new Map();
  const picks = [];
  for (const [number, gate] of PASSES) {
    const pool = sources(eligible).filter(gate);
    for (;;) {
      const chosen = new Set(picks.map((p) => p.repo));
      const gain = (s) => [...s.problems].filter((p) => (held.get(p) ?? 0) < NEED).sort(byProblem);
      const left = pool.filter((s) => !chosen.has(s.repo) && gain(s).length);
      if (!left.length) break;
      const best = left.reduce((a, b) => {
        const order = [gain(a).length - gain(b).length, a.quality - b.quality, a.stars - b.stars, cmp(a.repo, b.repo)].find((d) => d !== 0) ?? 0;
        return order >= 0 ? a : b;
      });
      picks.push({ repo: best.repo, pass: number, adds: gain(best) });
      for (const p of best.problems) held.set(p, (held.get(p) ?? 0) + 1);
    }
  }
  return picks;
}

function studyRows(text) {
  return text.split("\n").filter((line) => /^\| [^|]+ \| [^|]+ \| [^|]+ \| [^|]+ \| study \| /.test(line)).map((line) => line.split(" | ").map((c) => c.replace(/^\| |\s\|$/g, "")));
}

export function stoppedErrors(text, { files, read, criteriaText }) {
  const errors = [];
  const json = (name) => {
    const raw = read(name);
    if (raw === undefined || raw === null) errors.push(`the stopped sweep has no ${name}`);
    return raw ? JSON.parse(raw) : null;
  };
  const meta = json("meta.json");
  const stop = json("stop.json");
  const study = json("deep-study.json");
  if (!meta || !stop || !study) return errors;
  if (!criteriaText(meta.criteria).includes(STOP_MARK)) errors.push(`${meta.criteria} names no ${STOP_MARK}`);
  if (text.match(STOPPED)?.[1] !== stop.date) errors.push(`the Status line does not state the stop of ${stop.date}`);
  const facts = new Map(study.rows.map((r) => [`${r.batch} ${r.stratum} ${r.rank}`, r]));
  const freezes = files.filter((f) => /^reference-freeze-[\w-]+\.json$/.test(f));
  if (!freezes.length) errors.push("no reference-freeze-<batch>.json: a stopped sweep reads frozen reference labels only");
  const eligible = [];
  for (const file of freezes) {
    const batch = file.slice("reference-freeze-".length, -".json".length);
    const freeze = JSON.parse(read(file));
    for (const kind of ["set", "labels"]) {
      const raw = read(`${batch}-${kind}.json`);
      if (raw === undefined || raw === null || sha256(raw) !== freeze[`${kind}_sha256`]) errors.push(`${batch}-${kind}.json is not the file ${file} froze`);
    }
    for (const row of JSON.parse(read(`${batch}-labels.json`) ?? '{"rows": []}').rows) {
      const fact = facts.get(`${batch} ${row.stratum} ${row.order_rank}`);
      if (!fact || fact.repo.toLowerCase() !== row.repo.toLowerCase()) {
        errors.push(`deep-study.json holds no row for ${batch} ${row.stratum} rank ${row.order_rank}`);
        continue;
      }
      if (row.user.decision === "eligible") eligible.push({ repo: row.repo, stars: fact.stars, ...row.user });
    }
  }
  const supplement = new Set();
  for (const extra of study.supplement) {
    if (!String(extra.reason ?? "").trim()) errors.push(`supplement ${extra.repo} needs a reason`);
    supplement.add(extra.repo.toLowerCase());
  }
  const picks = new Map(deepPicks(eligible).map((p) => [p.repo.toLowerCase(), p]));
  const studied = studyRows(text);
  for (const [rank, repo, , , , , reason] of studied) {
    const key = repo.toLowerCase();
    if (rank === "supplement" ? !supplement.has(key) : !picks.has(key)) errors.push(`${repo} is studied, but it is neither a pick of the deep-study rule nor a named supplement`);
    else if (rank !== "supplement" && !reason.startsWith(`pass ${picks.get(key).pass}: adds `)) errors.push(`${repo}: the reason does not state its pass`);
  }
  const shown = new Set(studied.map((r) => r[1].toLowerCase()));
  for (const [key, pick] of picks) if (!shown.has(key)) errors.push(`${pick.repo} is a pick of the deep-study rule but has no study row`);
  for (const key of supplement) if (!shown.has(key)) errors.push(`supplement ${key} has no study row`);
  return errors;
}
