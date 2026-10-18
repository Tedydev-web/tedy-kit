import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CRITERIA = /^- Criteria: (\S+) sha256\[:16\] `([0-9a-f]{16})`$/m;
const INVENTORY = /^- Inventory: .*?`([0-9a-f]{16})`/m;
const ROLE = /^- Role: (\S+)$/m;
const DECISION = /^(?:study|study \(below-threshold: [\d.]+\)|eligible|excluded: [a-z-]+)$/;
const SURFACE_LINE = /^- (considered|not relevant|outside the inventory): (.+?): (.+)$/;
const DIGEST_LINE = /sha256\[:16\] of the sorted unique list: `([0-9a-f]{16})`/;
const SURFACE_ROW = /^\| ([^|]+?) \| (?:hook event|component|manifest|model setting) \|/;
const MECHANISM_LINE = /^([a-z0-9]+(?:-[a-z0-9]+)*): /;

function sections(text, heading) {
  const parts = text.split(/^(?=## )/m);
  return parts.filter((part) => part.startsWith(heading)).map((part) => ({ title: part.split("\n", 1)[0].slice(heading.length).trim(), body: part }));
}

function tableRows(body) {
  return body.split("\n").filter((line) => line.startsWith("| ") && !/^\|\s*-/.test(line)).slice(1).map((line) => line.slice(1, -1).split(" | ").map((cell) => cell.trim()));
}

function screenedRows(text) {
  return sections(text, "## Stratum:").flatMap(({ body }) => {
    const table = body.split(/^### Screened rows$/m)[1];
    return table ? tableRows(table.split(/^#{2,3} /m)[0]) : [];
  });
}

export function checkSweepRecord(text, { criteriaText, inventoryDigest, surfaces, latest }) {
  const errors = [];
  const criteria = text.match(CRITERIA);
  if (!criteria) errors.push("no Criteria line with a sha256[:16] pin");
  else if (createHash("sha256").update(criteriaText(criteria[1])).digest("hex").slice(0, 16) !== criteria[2]) errors.push(`criteria hash of ${criteria[1]} no longer matches ${criteria[2]}`);
  const inventory = text.match(INVENTORY);
  if (!inventory) errors.push("no Inventory line with a sha256[:16] pin");
  const strata = sections(text, "## Stratum:");
  if (!strata.length) errors.push("no ## Stratum: section");
  for (const { title, body } of strata) if (!/^(?:stop|no candidates): \S/m.test(body)) errors.push(`${title}: no stop line or no-candidates line`);
  for (const row of screenedRows(text)) {
    const [, repo, , , decision, , reason] = row;
    if (!DECISION.test(decision ?? "")) errors.push(`${repo}: unknown decision "${decision}"`);
    if (!reason) errors.push(`${repo}: no reason`);
  }
  if (!latest) return errors;
  if (inventory && inventory[1] !== inventoryDigest) errors.push(`pins inventory ${inventory[1]}, current is ${inventoryDigest}; redo the surface listing`);
  const listed = new Set();
  for (const line of (sections(text, "## Surfaces")[0]?.body ?? "").split("\n")) {
    const match = line.match(SURFACE_LINE);
    if (!match || match[1] === "outside the inventory") continue;
    if (!surfaces.includes(match[2])) errors.push(`surface "${match[2]}" is not in the inventory`);
    listed.add(match[2]);
  }
  for (const surface of surfaces) if (!listed.has(surface)) errors.push(`surface "${surface}" not listed as considered or not relevant`);
  return errors;
}

export function checkCardsStudied(cardsDir, recordTexts) {
  const studied = new Set(recordTexts.flatMap((text) => screenedRows(text).filter((row) => (row[4] ?? "").startsWith("study")).map((row) => row[1].toLowerCase())));
  return readdirSync(cardsDir).filter((file) => file.endsWith(".md")).flatMap((file) => {
    const name = readFileSync(join(cardsDir, file), "utf8").match(/^---\n(?:(?!---\n)[^\n]*\n)*?name: (.+)\n/)?.[1].trim();
    return name && !studied.has(name.toLowerCase()) ? [`card ${file.slice(0, -3)} (${name}) has no study row`] : [];
  });
}

export function checkMeasuredAdrs(adrDir) {
  return readdirSync(adrDir).filter((file) => file.endsWith(".md")).sort().flatMap((file) => {
    const text = readFileSync(join(adrDir, file), "utf8");
    if (!/^measured: yes$/m.test(text)) return [];
    const variants = sections(text, "## Variants")[0]?.body ?? "";
    return tableRows(variants).filter((row) => row.slice(1).some((cell) => /\d/.test(cell))).length >= 2 ? [] : [`${file}: measured: yes needs ## Variants with at least 2 arms holding numbers`];
  });
}

export function checkCoverageMatrix(text) {
  const frame = sections(text, "## Frame")[0]?.body ?? "";
  const areas = (frame.match(/^- SWEBOK Guide V4 knowledge areas \([^)]*\)[^:]*: (.+)$/m)?.[1] ?? "").replace(/\.$/, "").split("; ").filter(Boolean);
  const steps = [...(frame.match(/^- Dev steps \([^)]*\): (.+)$/m)?.[1] ?? "").matchAll(/(?:^|; )(\d+) /g)].map((m) => m[1]);
  const problems = new Set([...text.matchAll(/^\| (P\d+) \|/gm)].map((m) => m[1]));
  if (!areas.length || !steps.length) return ["coverage matrix: Frame lists no knowledge areas or no dev steps"];
  const matrix = sections(text, "## Coverage matrix")[0]?.body ?? "";
  return areas.flatMap((area) => {
    const line = matrix.split("\n").find((l) => l.startsWith(`- ${area}: `));
    if (!line) return [`coverage matrix: ${area} has no row`];
    const cells = new Map(line.slice(area.length + 4).split(/; (?=\d+ )|; (?=\d+$)/).map((cell) => [cell.split(" ", 1)[0], cell.slice(cell.indexOf(" ") + 1).trim()]));
    return steps.flatMap((step) => {
      const cell = cells.get(step);
      if (cell === undefined || cell === step || !cell) return [`coverage matrix: ${area} step ${step} is empty`];
      if (/^none for dev: \S/.test(cell)) return [];
      return cell.split(", ").filter((p) => !problems.has(p)).map((p) => `coverage matrix: ${area} step ${step} names unknown ${p}`);
    });
  });
}

export function checkMechanismTable(table, coded) {
  const known = new Set([...coded, ...Object.keys(table.class)]);
  return Object.entries(table.aliases).flatMap(([from, to]) => [
    ...(coded.has(from) ? [] : [`alias ${from} names a mechanism no session coded`]),
    ...(known.has(to) ? [] : [`alias ${from} points at ${to}, which no session coded and the table does not classify`]),
  ]);
}

function codedMechanisms(folder) {
  const coded = new Set();
  for (const stratum of ["config", "product"]) {
    const mapFile = join(folder, `${stratum}-mechanism-map.json`);
    const map = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, "utf8")) : { A: {}, B: {} };
    for (const side of ["A", "B"]) {
      const file = join(folder, `${stratum}-screen-${side}-mechanisms.md`);
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const name = line.match(MECHANISM_LINE)?.[1];
        if (name && name !== "stop") coded.add(`${stratum}:${map[side]?.[name] ?? name}`);
      }
    }
    for (const file of readdirSync(folder).filter((f) => f.startsWith(`${stratum}-reader-C-extra`))) {
      for (const line of readFileSync(join(folder, file), "utf8").split("\n").filter(Boolean)) coded.add(`${stratum}:${JSON.parse(line).name}`);
    }
  }
  return coded;
}

export function checkSweepFolder(repo) {
  const prior = join(repo, "docs", "prior-art");
  const sweeps = join(prior, "sweeps");
  const files = existsSync(sweeps) ? readdirSync(sweeps).filter((f) => f.endsWith(".md") && statSync(join(sweeps, f)).isFile()).sort() : [];
  if (!files.length) return ["docs/prior-art/sweeps: no sweep record"];
  const surfacesText = readFileSync(join(prior, "claude-code-surfaces.md"), "utf8");
  const inventoryDigest = surfacesText.match(DIGEST_LINE)?.[1];
  const surfaces = surfacesText.split("\n").map((line) => line.match(SURFACE_ROW)?.[1]).filter(Boolean);
  const texts = new Map(files.map((f) => [f, readFileSync(join(sweeps, f), "utf8")]));
  const latestByRole = new Map();
  for (const [file, text] of texts) latestByRole.set(text.match(ROLE)?.[1] ?? file, file);
  const latest = new Set(latestByRole.values());
  const errors = [];
  for (const [file, text] of texts) {
    const ctx = { criteriaText: (path) => readFileSync(join(repo, path), "utf8"), inventoryDigest, surfaces, latest: latest.has(file) };
    errors.push(...checkSweepRecord(text, ctx).map((e) => `sweeps/${file}: ${e}`));
    const folder = join(sweeps, file.slice(0, -3));
    const tableFile = join(folder, "mechanism-table.json");
    if (existsSync(tableFile)) errors.push(...checkMechanismTable(JSON.parse(readFileSync(tableFile, "utf8")), codedMechanisms(folder)).map((e) => `sweeps/${file}: ${e}`));
  }
  errors.push(...checkCardsStudied(prior, [...texts.values()]));
  errors.push(...checkMeasuredAdrs(join(repo, "docs", "adr")));
  errors.push(...checkCoverageMatrix(readFileSync(join(prior, "problems.md"), "utf8")));
  return errors;
}
