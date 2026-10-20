const NO_BARE_THREAT = "plugin hooks not excluded (no --bare)";
const AGY_THREAT = "agy MCP servers, hooks and user settings not excluded";
const UPPER_ESTIMATE = "QGS recall is an upper estimate: the QGS judges are the stage-1 models, and the candidates come from curated lists filtered by the topic's terms";
const V4_THREATS = ["- recall target not reached: ", "- discovery gap: ", "- no cross-family audit: ", "- cross-family audit pending: ",
  "- stage 2 stopped before every stage-1 pass: ", "- pooled recall target unreachable at stage 2: "];

const family = (model) => String(model ?? "").toLowerCase().split(/[-.]/)[0];
const sorted = (list) => [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export const sectionLines = (text, heading) => (text.split(`\n## ${heading}\n\n`)[1]?.split("\n## ")[0] ?? "").split("\n").filter((l) => l.trim());

function sweepDate(sweep) {
  const found = String(sweep ?? "").match(/^(\d\d)(\d\d)(\d\d)-/);
  return found ? `20${found[1]}-${found[2]}-${found[3]}` : null;
}

function protocolLines(freeze, strata, sessions, topic) {
  const lines = strata.map((s) => {
    const f = freeze.strata?.[s] ?? {};
    return `- ${s}: frozen after row ${f.frozen_after_rank} (pilot block of ${f.pilot_rows} unforced ${f.pilot_rows === 1 ? "row" : "rows"}), criteria sha256 `
      + `\`${f.criteria_sha256}\`, packet sha256 \`${f.packet_sha256}\` (${f.packet}), ${f.date}`;
  });
  const a = freeze.session_a ?? {};
  const b = freeze.session_b ?? {};
  lines.push(`- session A: ${a.cli} ${a.model}; session B: ${b.chosen?.cli} ${b.chosen?.model}, ${b.rule}`);
  lines.push(`- session B pilot, information only: ${Object.entries(b.pilot ?? {}).map(([m, p]) => `${m} agreement ${Number(p.agreement).toFixed(3)} on ${p.rows} rows`).join("; ")}`);
  const amendment = freeze.amendment ?? {};
  lines.push(`- packet amendment at the freeze: ${amendment.what}${amendment.changed ? `; pilot packets sha256[:16] ${(amendment.pilot_packet_sha256 ?? []).map((p) => `\`${p.slice(0, 16)}\``).join(", ")}` : ""}`);
  const templates = new Set(strata.map((s) => freeze.strata?.[s]?.template_sha256));
  lines.push(`- prompt template sha256 \`${[...templates][0]}\` (row note and reply format), pinned at the freeze for every screened stratum`);
  lines.push(`- Date: computed by the toolchain from facts.pushed and the sweep date ${sweepDate(topic?.sweep)} (within 90 days 1, within 365 days 0.5, older 0); `
    + "both sessions' Date values are replaced and kept as session_date");
  const entries = Object.values(sessions);
  const isolation = sorted(new Set(entries.map((e) => `${e.cli}\u0000${e.isolation}`))).map((k) => k.replace("\u0000", " "));
  lines.push(`- isolation: ${isolation.join("; ")}`);
  const versions = {};
  for (const e of entries) for (const block of e.blocks ?? []) (versions[e.cli] ??= new Set()).add(block.cli_version);
  lines.push(`- CLI versions: ${sorted(Object.keys(versions)).map((cli) => `${cli} ${sorted(versions[cli]).join(", ")}`).join(", ")}`);
  return { lines, templates };
}

function sessionLines(files, sessions) {
  const screen = sorted(files.filter((f) => /^[a-z0-9]+-screen-[AB]\.jsonl$/.test(f))).map((f) => f.slice(0, -6).replace("-screen-", "-"));
  const pilot = sorted(files.filter((f) => /-pilot-.*\.jsonl$/.test(f) && !f.includes("/"))).map((f) => f.slice(0, -6));
  return [...screen, ...pilot].map((key) => {
    const e = sessions[key] ?? {};
    const blocks = (e.blocks ?? []).map((b) => `ranks ${b.ranks?.[0]}-${b.ranks?.at(-1)} packet \`${String(b.packet_sha256).slice(0, 16)}\` prompt \`${String(b.prompt_sha256).slice(0, 16)}\` `
      + `inputs \`${String(b.inputs_sha256).slice(0, 16)}\` ${b.cli_version} ${b.date}`).join("; ");
    return `- ${key}: ${e.cli ?? "-"} ${e.model}, effort ${e.effort}; ${blocks}`;
  });
}

function baseThreats(topic, strata, sessions, freeze, papers) {
  const threats = [];
  for (const s of strata) {
    const a = sessions[`${s}-A`]?.model;
    const b = sessions[`${s}-B`]?.model;
    if (family(a) === family(b)) {
      threats.push(`- same model family: ${s} sessions A (${a}) and B (${b}) are both ${family(a)} models, so their errors correlate and their agreement shows consistency more than correctness`);
    }
  }
  const flagged = (threat) => sorted(Object.entries(sessions).filter(([, e]) => (e.threats ?? []).includes(threat)).map(([k]) => k));
  const unbare = flagged(NO_BARE_THREAT);
  if (unbare.length) {
    threats.push(`- ${NO_BARE_THREAT}: ${unbare.join(", ")} ran without --bare because no API-key auth source was set; settings, MCP servers, CLAUDE.md, `
      + "tools and session persistence were still excluded, but installed plugin hooks may have run");
  }
  const agy = flagged(AGY_THREAT);
  if (agy.length) {
    threats.push(`- ${AGY_THREAT}: ${agy.join(", ")} ran through agy, which has no flag to exclude its configured MCP servers, hooks or user settings; `
      + "its tools stay offered, so a reply with any tool step, denied action or second turn is refused");
  }
  const changed = sorted(Object.entries(sessions).map(([k, e]) => [k, sorted(new Set((e.blocks ?? []).map((b) => b.cli_version)))]).filter(([, v]) => v.length > 1).map(([k, v]) => `${k} (${v.join(", ")})`));
  if (changed.length) threats.push(`- CLI version changed within a session: ${changed.join("; ")}`);
  const chosen = freeze.session_b ?? {};
  if (String(chosen.rule).includes("fallback")) threats.push(`- session B fallback: ${chosen.rule}; B ran on ${chosen.chosen?.model}`);
  threats.push(`- session B fixed by the topic config (${chosen.chosen?.model}), not chosen by agreement with A; the pilot comparison is information only`);
  if (strata.some((s) => topic?.strata?.[s]?.channels?.academic)) {
    threats.push(`- academic papers logged, not screened: ${papers.length} papers in papers.jsonl named ${new Set(papers.flatMap((p) => p.linked_repos ?? [])).size} repositories `
      + "that joined the pool; the papers themselves are not scored");
  }
  return threats;
}

export function proseErrors(io, topic, strata, sessions) {
  const errors = [];
  const freeze = io.json("protocol-freeze.json") ?? {};
  for (const [side, frozen] of [["A", freeze.session_a], ["B", freeze.session_b?.chosen]]) {
    const named = topic?.sessions?.[side];
    if (named?.cli !== frozen?.cli || named?.model !== frozen?.model) errors.push(`protocol-freeze.json session ${side} is ${frozen?.cli} ${frozen?.model}, but the topic config names ${named?.cli} ${named?.model}`);
    for (const s of strata) {
      const entry = sessions[`${s}-${side}`];
      if (entry?.cli !== frozen?.cli || entry?.model !== frozen?.model) errors.push(`${s}-${side} ran ${entry?.cli} ${entry?.model}, the freeze names ${frozen?.cli} ${frozen?.model}`);
    }
  }
  const protocol = protocolLines(freeze, strata, sessions, topic);
  if (protocol.templates.size !== 1 || protocol.templates.has(undefined)) errors.push("protocol-freeze.json must pin one prompt template sha256 for every screened stratum");
  const compare = (heading, expected) => {
    const written = sectionLines(io.text, heading);
    const first = expected.findIndex((line, i) => written[i] !== line);
    if (first >= 0 || written.length !== expected.length) {
      errors.push(`the record's ${heading} section is not the one meta.json and protocol-freeze.json give (first differing line: "${expected[first] ?? written[expected.length]}")`);
    }
  };
  compare("Protocol", protocol.lines);
  compare("Screening sessions", sessionLines(io.files ?? [], sessions));
  const threats = sectionLines(io.text, "Threats");
  const base = baseThreats(topic, strata, sessions, freeze, io.jsonl("papers.jsonl"));
  const reader = topic?.reader?.model;
  const judges = [topic?.qgs_judges?.A?.model, topic?.qgs_judges?.B?.model];
  const expected = [...base, ...(judges.every((m) => family(m) === family(reader))
    ? [`- reader shares the QGS judges' model family: the reader ${reader} and the QGS judges ${judges[0]} and ${judges[1]} are all ${family(reader)} models, so an error they `
      + "share passes the adjudication; the cross-family judge's yes is the counter-check"] : [])];
  const missing = expected.filter((line) => !threats.includes(line));
  if (missing.length) errors.push(`the record's Threats section lacks the threat "${missing[0]}"`);
  const unknown = threats.filter((line) => !expected.includes(line) && !V4_THREATS.some((prefix) => line.startsWith(prefix)));
  if (unknown.length) errors.push(`the record's Threats section holds a threat the files do not give: "${unknown[0]}"`);
  if (!sectionLines(io.text, "Recall").includes(`- ${UPPER_ESTIMATE}`)) errors.push("the record's Recall section does not state that QGS recall is an upper estimate");
  return errors;
}
