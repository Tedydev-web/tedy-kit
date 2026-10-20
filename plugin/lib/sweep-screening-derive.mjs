export const JUDGED = ["Authority", "Methodology", "Objectivity", "Date", "Position"];
export const EMPTY_TABLE = { aliases: {}, class: {}, default: "new" };
const COPYLIKE = ["copy", "dead", "aggregator"];
const ELIGIBLE_TOTAL = 4.5;

const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

function normal(decision) {
  const text = String(decision ?? "");
  const code = text.includes(":") ? text.slice(text.indexOf(":") + 1).trim().split(" ")[0].split("(")[0] : "";
  return text.startsWith("eligible") ? "eligible" : `excluded: ${code}`;
}

export function derive(table, stratum, mapping, side, row) {
  const scores = Object.fromEntries(Object.entries(row.scores ?? {}).map(([k, v]) => [capitalize(k), v?.v]));
  const evidence = new Set(Object.entries(table.class ?? {}).filter(([, kind]) => kind === "evidence").map(([m]) => m));
  const canon = (name) => {
    const key = `${stratum}:${mapping?.[side]?.[name] ?? name}`;
    return table.aliases?.[key] ?? key;
  };
  const mechs = new Set((row.mechanisms ?? []).map(canon).filter((m) => !evidence.has(m)));
  const first = normal(row.decision);
  const copy = COPYLIKE.includes(first.split(": ").at(-1));
  const kind = (m) => table.class?.[m] ?? table.default;
  const novelty = copy || !mechs.size ? 0 : [...mechs].some((m) => kind(m) === "new") ? 1 : 0.5;
  const relevance = mechs.size ? 1 : scores.Relevance === 0.5 ? 0.5 : 0;
  const total = JUDGED.reduce((sum, k) => sum + scores[k], 0) + novelty;
  let decision;
  if (copy) decision = first;
  else if (relevance === 1 && novelty >= 0.5 && total >= ELIGIBLE_TOTAL) decision = "eligible";
  else decision = relevance === 0 ? "excluded: irrelevant" : "excluded: below-threshold";
  return { scores, mechs, novelty, relevance, total, decision };
}
