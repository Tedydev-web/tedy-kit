import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePosition, positionErrors, renderPositions, kitPositions } from "../lib/positions.mjs";
import { kitEntries } from "../lib/prior-art-index.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

const page = ({ front = {}, derived = ["a", "b"], against = "- `c` says the opposite; it lost because it is narrower.", uses = 3 } = {}) => {
  const fields = { title: "Do the thing one way", question: "How should the thing be done?", domains: "cost", ring: "adopt", certainty: "low (vendor bias)", reviewed: "2026-11-04", living: "no", "kit-status": "conforms (ADR 0015)", ...front };
  const head = Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`).join("\n");
  const known = Array.from({ length: uses }, (_, index) => `- Project ${index + 1}: uses it.`).join("\n");
  return parsePosition({ slug: "thing", text: `---\n${head}\n---\n\n## Context and forces\n- x\n\n## Known uses\n${known}\n\n## Derived from\n${derived.map((slug) => `- \`${slug}\`: fact.`).join("\n")}\n\n## Against / dissent\n${against}\n\n## Moves\n- 2026-11-04: created.\n` });
};
const note = (slug, { read = "2026-11-03", domains = ["cost"], positions = ["thing"] } = {}) => ({ kind: "note", slug, read, domains, positions });
const notes = [note("a"), note("b"), note("c")];

test("a page is read for its front matter, its cited notes and its known uses", () => {
  const parsed = page();
  assert.equal(parsed.slug, "thing");
  assert.equal(parsed.ring, "adopt");
  assert.equal(parsed.kitStatus, "conforms (ADR 0015)");
  assert.deepEqual(parsed.domains, ["cost"]);
  assert.deepEqual([...parsed.derived], ["a", "b"]);
  assert.deepEqual([...parsed.against], ["c"]);
  assert.equal(parsed.knownUses, 3);
});

test("a page that cites every note naming it, with dissent and enough known uses, is clean", () => {
  assert.deepEqual(positionErrors([page()], notes), []);
});

test("a note that names the page but is cited nowhere makes the page pending", () => {
  assert.deepEqual(positionErrors([page({ against: "- `b` disagrees; open." , derived: ["a"] })], notes), ["thing: pending: note c names this position but is in neither Derived from nor Against"]);
});

test("a cited note read after the page's review makes it pending, and a cited note must name the page", () => {
  assert.deepEqual(positionErrors([page()], [note("a", { read: "2026-11-05" }), note("b"), note("c")]), ["thing: pending: note a was read 2026-11-05, after the review on 2026-11-04"]);
  assert.deepEqual(positionErrors([page()], [note("a", { positions: [] }), note("b"), note("c")]), ["thing: cited note a does not name this position in its positions: line"]);
  assert.deepEqual(positionErrors([page({ derived: ["a", "b", "gone"] })], notes), ["thing: cites note gone, which does not exist"]);
});

test("a newly read note in the page's domain must say which position it bears on, or none", () => {
  const fresh = note("d", { read: "2026-11-06", positions: [] });
  assert.deepEqual(positionErrors([page()], [...notes, fresh]), ["thing: pending: note d (cost, read 2026-11-06) has no positions: line; name this position or write positions: none"]);
  assert.deepEqual(positionErrors([page()], [...notes, { ...fresh, positions: ["none"] }]), []);
  assert.deepEqual(positionErrors([page()], [...notes, { ...fresh, domains: ["security"] }]), []);
  assert.deepEqual(positionErrors([page()], [...notes, { ...fresh, read: "2026-11-01" }]), []);
});

test("dissent is required, and none found needs two queries", () => {
  assert.deepEqual(positionErrors([page({ against: "", derived: ["a", "b", "c"] })], notes), ["thing: Against / dissent is empty; name the notes that disagree or write none found plus two quoted queries"]);
  assert.deepEqual(positionErrors([page({ against: "none found", derived: ["a", "b", "c"] })], notes), ["thing: Against / dissent is empty; name the notes that disagree or write none found plus two quoted queries"]);
  assert.deepEqual(positionErrors([page({ against: 'none found: x "agent thing"; web "thing practice"', derived: ["a", "b", "c"] })], notes), []);
});

test("the ring gate, the front matter vocabulary and a deviation without an ADR fail", () => {
  assert.deepEqual(positionErrors([page({ uses: 2 })], notes), ["thing: ring adopt needs at least 3 known uses, found 2"]);
  assert.deepEqual(positionErrors([page({ uses: 0, front: { ring: "trial" } })], notes), ["thing: ring trial needs at least 1 known use, found 0"]);
  assert.deepEqual(positionErrors([page({ uses: 0, front: { ring: "assess" } })], notes), []);
  assert.deepEqual(positionErrors([page({ front: { ring: "maybe", certainty: "sure", reviewed: "soon", "kit-status": "deviates (no record)", question: undefined, domains: "cost, magic" } })], notes), [
    "thing: no question: line",
    "thing: domain magic is not in the vocabulary",
    "thing: ring must be one of adopt, trial, assess, hold",
    "thing: certainty must start with one of high, moderate, low, very-low",
    "thing: reviewed must be YYYY-MM-DD",
    "thing: kit-status deviates must name an ADR (deviates (ADR NNNN: reason))",
  ]);
});

test("a note naming a position that has no page fails", () => {
  assert.deepEqual(positionErrors([page()], [...notes, note("e", { positions: ["thing", "ghost"] })]).filter((line) => line.includes("ghost")), ["notes/e: names position ghost, which has no page"]);
});

test("the index section lists each page with its ring, certainty, kit status and pending state", () => {
  const section = renderPositions([page()], ["thing: pending: note c names this position but is in neither Derived from nor Against"]);
  assert.match(section, /^## Positions\n/);
  assert.match(section, /^- \[Do the thing one way\]\(positions\/thing\.md\) \(adopt, low; kit conforms \(ADR 0015\); pending\): How should the thing be done\?$/m);
  assert.equal(renderPositions([], []), "");
});

test("the position pages on this machine lint clean against the notes", { skip: !existsSync(join(REPO, "docs/prior-art/private/positions")) }, () => {
  const entries = kitEntries(REPO, { withPrivate: true }).filter((entry) => entry.kind === "note");
  assert.deepEqual(positionErrors(kitPositions(REPO), entries), []);
});
