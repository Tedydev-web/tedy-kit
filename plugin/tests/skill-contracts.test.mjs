import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const script = (name) => existsSync(new URL(`../scripts/${name}.mjs`, import.meta.url));

test("learn reads every mapped repo's memory, ranks each lesson by the strongest form, and scans what leaves the project", () => {
  const learn = read("skills/learn/SKILL.md");
  for (const phrase of ["memory-stats.mjs", "public-scan.mjs file", "pending.mjs stub", "repeat-of", "learn_held", "## Metrics", "gate-log.jsonl", "baseline", "ISO timestamp", "docs/prior-art/", "none found"]) assert.ok(learn.includes(phrase), phrase);
  for (const name of ["memory-stats", "public-scan", "pending", "project-state", "edit-rate"]) assert.ok(script(name), name);
});

test("one blast-radius procedure sees every tracked file, reads siblings from the remote ref, and every role that traces callers points to it", () => {
  const access = read("shared/source-access.md");
  const section = access.slice(access.indexOf("## Blast radius"), access.indexOf("## PM demo"));
  for (const phrase of ["git -C <repo> grep -n -w -F", "origin/<branch>", "--untracked", "string contracts", "touched", "broken"]) assert.ok(section.includes(phrase), phrase);
  assert.match(read("agents/reviewer.md"), /\*\*bugs\*\*:[^\n]*Blast radius[^\n]*source-access\.md/);
  assert.match(read("skills/dev/SKILL.md"), /Blast radius steps in `\$\{CLAUDE_PLUGIN_ROOT\}\/shared\/source-access\.md`/);
  assert.match(read("skills/review-pr/SKILL.md"), /Blast radius in source-access\.md/);
});

test("every approval before a github-write post, reply or edit carries the verbatim body in an AskUserQuestion preview", () => {
  const review = read("skills/review-pr/SKILL.md");
  const approval = review.slice(review.indexOf("10. **Approval.**"), review.indexOf("12. **Next step.**"));
  assert.ok(approval.includes("verbatim in its `preview`"), "review-pr steps 10 and 11");
  for (const path of ["skills/review-pr/references/draft-format.md", "skills/review-pr/references/follow-up.md", "skills/dev/references/rebut.md"]) assert.ok(read(path).includes("`preview`"), path);
});

test("eval graders check facts only: no llm or baseline grader in any case", async () => {
  const { readdirSync } = await import("node:fs");
  const evals = new URL("../evals/", import.meta.url);
  const graders = readdirSync(evals, { recursive: true }).filter((path) => /(^|\/)graders\/[^/]+\.md$/.test(path));
  assert.ok(graders.length > 0);
  for (const path of graders) assert.doesNotMatch(readFileSync(new URL(path, evals), "utf8"), /^type:\s*(llm|baseline)\s*$/m, path);
});
