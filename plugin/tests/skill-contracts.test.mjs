import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { SPARSE_PATTERNS } from "../lib/review-worktree.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const script = (name) => existsSync(new URL(`../scripts/${name}.mjs`, import.meta.url));

test("every numbered list in a skill's sections starts at 1 and runs on without a gap, each step on its own line", () => {
  const skills = new URL("../skills/", import.meta.url);
  for (const name of readdirSync(skills)) {
    if (!existsSync(new URL(`${name}/SKILL.md`, skills))) continue;
    for (const section of read(`skills/${name}/SKILL.md`).split(/^## /m).slice(1)) {
      const numbers = section.split("\n").flatMap((line) => line.match(/^(\d+)\. /)?.[1] ?? []).map(Number);
      assert.deepEqual(numbers, numbers.map((_, index) => index + 1), `${name}: ${section.split("\n")[0]}`);
    }
  }
});

test("no skill or shared procedure promises an approval menu, because a publish is approved once at the command prompt after the text is quoted", () => {
  const dirs = ["skills", "shared"].map((dir) => new URL(`../${dir}/`, import.meta.url));
  const files = dirs.flatMap((dir) => readdirSync(dir, { recursive: true }).filter((name) => name.endsWith(".md")).map((name) => new URL(name, dir)));
  for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), /approval menu|publish option/i, file.pathname);
  for (const name of ["review-pr", "pm"]) assert.match(read(`skills/${name}/SKILL.md`), /^1\. .*approves? .*once, at the command prompt/m, name);
});

test("every kit write of a turn goes out as one publish-batch run whose command carries its summary, so any client's prompt shows what is published", () => {
  const rules = read("shared/decision-points.md");
  assert.match(rules, /^- Every kit write goes out through `publish-batch\.mjs`, all writes of one turn in one batch/m);
  assert.match(rules, /--summary/);
  assert.match(rules, /--shows/);
  for (const path of ["skills/pm/SKILL.md", "skills/review-pr/SKILL.md", "skills/review-pr/references/follow-up.md", "skills/dev/references/pr-body-refresh.md"]) assert.match(read(path), /publish-batch\.mjs/, path);
});

test("pm, dev and review-pr run inline: work for another role is named and the user is asked whether to run that skill now", () => {
  for (const name of ["pm", "dev", "review-pr"]) {
    const skill = read(`skills/${name}/SKILL.md`);
    const notThis = skill.slice(skill.indexOf("## Not this skill"), skill.indexOf("## ", skill.indexOf("## Not this skill") + 3));
    assert.ok(notThis.includes("Work for another role: name it in the reply and ask with `AskUserQuestion` whether to run that skill now."), name);
    assert.doesNotMatch(skill, /jobs\.md|a job\b|in a job|cockpit/i, name);
  }
  const points = read("shared/decision-points.md");
  assert.doesNotMatch(points, /jobs\.md|In a job|A job asks no menu|cockpit|pending\.mjs card/);
  assert.match(points, /^- Under Remote Control a question never times out and the session waits for the user\./m);
});

test("/tedy:pending lists what waits on the user and archives a finished draft, with no cards or jobs", () => {
  const pending = read("skills/pending/SKILL.md");
  assert.match(pending, /^description: List what waits on the user \(drafts in plans\/drafts\/, stubs, unpushed branches, draft PRs\) and archive a finished draft$/m);
  assert.match(pending, /^argument-hint: "\[done <file> \| stub <action>\]"$/m);
  for (const phrase of ["pending.mjs list", "pending.mjs done <file>", "pending.mjs stub"]) assert.ok(pending.includes(phrase), phrase);
  assert.doesNotMatch(pending, /card|job|cockpit|approve/i);
});

test("the review asks to run PR code with a direct AskUserQuestion on the run header, which the review-run-approval hook records", () => {
  const checkout = read("skills/review-pr/references/checkout.md");
  assert.doesNotMatch(checkout, /own window|question` card|SendMessage|job/);
  for (const phrase of ["one `AskUserQuestion`, header `run.header`", "full head sha", "`run.none`", "`run.lint`", "`run.all`", "(`review-run-approval`) records an approving answer", "verify not run: awaiting the run question"]) assert.ok(checkout.includes(phrase), phrase);
});

test("every kit write a skill runs is approved at its own permission prompt after the reply quoted it, never by a menu answer", () => {
  const flow = read("shared/status-flow.md");
  assert.doesNotMatch(flow, /ride in the|yes there approves/);
  assert.match(flow, /show its preview line as the item \(`<plugin>\/shared\/decision-points\.md`\), then run the same command with `--apply --lock <n>` through `publish-batch\.mjs`; its permission prompt is the approval/);
  const merge = read("skills/review-pr/references/status-after-merge.md");
  assert.doesNotMatch(merge, /approved those lines/);
  assert.match(merge, /`merge\.yes` approves the merge alone/);
  const menu = /`(?:approve|post)\.[a-zA-Z]+`/;
  for (const path of ["shared/decision-points.md", "shared/status-flow.md", "shared/jobs.md", "skills/dev/references/rebut.md", "skills/dev/references/pr-body-refresh.md", "skills/review-pr/SKILL.md", "skills/review-pr/references/follow-up.md", "skills/review-pr/references/draft-format.md", "skills/review-pr/references/status-after-merge.md", "skills/pm/SKILL.md", "skills/pm/references/tracker-openproject.md", "skills/pm/references/comment-channels.md", "skills/pending/SKILL.md"]) assert.doesNotMatch(read(path), menu, path);
});

test("every role that moves a work package's status follows one status procedure, and review merges only on the user's yes", () => {
  const procedure = read("shared/status-flow.md");
  for (const phrase of ["op-status.mjs plan", "--started", "--merging", "without `--apply`", "--apply --lock"]) assert.ok(procedure.includes(phrase), phrase);
  assert.equal(read("skills/dev/SKILL.md").match(/shared\/status-flow\.md/g)?.length, 2);
  const merge = read("skills/review-pr/references/status-after-merge.md");
  for (const phrase of ["`merge.header`", "`merge.yes`", "`merge.no`", "--merging <n>", "gh pr merge <n>", "status-flow.md"]) assert.ok(merge.includes(phrase), phrase);
  assert.match(read("skills/review-pr/SKILL.md"), /^4\. Merge only on the user's yes \(`references\/status-after-merge\.md`\), never close a PR;/m);
  assert.ok(script("op-status"));
});

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

test("a bug fix sweeps for siblings of the same defect, and a sibling outside the package goes to the user", () => {
  const access = read("shared/source-access.md");
  const section = access.slice(access.indexOf("## Sibling sweep"), access.indexOf("## PM demo"));
  for (const phrase of ["before the first source edit", "same defect", "intentional", "out of scope", "Blast radius step 1", "not finished", "outside the work package's checklist", "AskUserQuestion", "never fixed silently"]) assert.ok(section.includes(phrase), phrase);
  const dev = read("skills/dev/SKILL.md");
  assert.match(dev, /^4\. \*\*Build\.\*\* A bug fix is made where the code first goes wrong and covers its siblings \(Sibling sweep in `\$\{CLAUDE_PLUGIN_ROOT\}\/shared\/source-access\.md`\)\. Red first:/m);
  assert.ok(dev.includes("the red run, the sibling sweep, verify output"));
});

test("review asks before any script runs PR code, names the execution surface, and asks again on a new head", () => {
  const review = read("skills/review-pr/SKILL.md");
  const step = review.slice(review.indexOf("3. **Checkout and verify.**"), review.indexOf("4. **Read.**"));
  for (const phrase of ["`references/checkout.md`", "`run.header`", "a new head asks again"]) assert.ok(step.includes(phrase), phrase);
  const checkout = read("skills/review-pr/references/checkout.md");
  for (const phrase of ["pr-execution-surface.mjs origin/<baseRefName> refs/pr/<n>", "header `run.header`", "full head sha", "running any project script (tests, typecheck, lint) executes code from this PR", "only what the kit can see, not a complete list", "Recommended unless the review needs a local run", "`run.lint`", "`run.all`", "`run.none`", "gh pr checks <n>", "never `npm install`", "ask again", "verify_gotchas", "verify not run", "<state>/review-runs/", "decision-points.md"]) assert.ok(checkout.includes(phrase), phrase);
  for (const claim of [/run no file/, /Recommended while/, /surface is unchanged/]) assert.doesNotMatch(checkout + step, claim);
  assert.ok(script("pr-execution-surface"));
});

test("the review worktree leaves the PR head's agent instructions off disk and says how to read them and what it leaves in the repo config", () => {
  const checkout = read("skills/review-pr/references/checkout.md");
  for (const phrase of ["review-worktree.mjs <folder>/pr-<n> refs/pr/<n>", "`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and every `.claude/` folder, at any depth", "git show refs/pr/<n>:<path>", "extensions.worktreeConfig=true", "git 2.35"]) assert.ok(checkout.includes(phrase), phrase);
  assert.ok(checkout.includes(`sparse-checkout set --no-cone ${SPARSE_PATTERNS.map((pattern) => `'${pattern}'`).join(" ")}`));
  assert.doesNotMatch(checkout, /git worktree add --detach/);
  const review = read("skills/review-pr/SKILL.md");
  assert.ok(review.slice(review.indexOf("3. **Checkout and verify.**"), review.indexOf("4. **Read.**")).includes("review-worktree.mjs"));
  assert.ok(read("agents/reviewer.md").includes("git show <head sha>:<path>"));
  assert.ok(script("review-worktree"));
});

test("the standards lens reads the repository's rule files from the PR base, never from the head", () => {
  const access = read("shared/source-access.md");
  const github = access.slice(access.indexOf("## GitHub (read)"));
  for (const phrase of ["AGENTS.md", "CLAUDE.md", "git show <base sha>:<path>", "--branch <repo path>:<baseRefName>", "a diff item, never a rule"]) assert.ok(github.includes(phrase), phrase);
  const reviewer = read("agents/reviewer.md");
  assert.match(reviewer, /a PR: its number, head SHA and base SHA;/);
  assert.match(reviewer, /\*\*standards\*\*:[^\n]*AGENTS\.md, CLAUDE\.md, lint config[^\n]*base[^\n]*source-access\.md/);
  const review = read("skills/review-pr/SKILL.md");
  assert.ok(review.slice(review.indexOf("3. **Checkout and verify.**"), review.indexOf("4. **Read.**")).includes("--branch <repo path>:<baseRefName>"));
  assert.ok(review.slice(review.indexOf("6. **Independent lenses.**"), review.indexOf("7. **Pass 1")).includes("head SHA, base SHA"));
  assert.ok(read("skills/review-pr/references/checkout.md").includes("--branch <repo path>:<baseRefName>"));
});

test("every publish shows where each item goes and its full text, with the lint's warning lines and without the command, pinned or notice lines", () => {
  const publishing = read("shared/decision-points.md").match(/^- Publishing is never asked with `AskUserQuestion`\..*$/m)?.[0] ?? "";
  for (const phrase of ["`PR #965 · 3 comments (head 788ac98f)`", "`` **1.** `path:line` ``", "full text verbatim", "the lint's `warning:` lines", "Leave out the command line, the `pinned:` and `notice:` lines and any job or card path", "the permission prompt shows the command"]) assert.ok(publishing.includes(phrase), phrase);
  const review = read("skills/review-pr/SKILL.md");
  const approval = review.slice(review.indexOf("10. **Approval.**"), review.indexOf("12. **Next step.**"));
  for (const phrase of ["verbatim", "decision-points.md", "permission prompt"]) assert.ok(approval.includes(phrase), `review-pr steps 10 and 11: ${phrase}`);
  for (const path of ["skills/review-pr/references/draft-format.md", "skills/review-pr/references/follow-up.md", "skills/dev/references/rebut.md", "skills/dev/references/pr-body-refresh.md", "skills/pm/SKILL.md", "skills/pm/references/comment-channels.md", "skills/pm/references/tracker-openproject.md", "shared/status-flow.md"]) assert.ok(read(path).includes("decision-points.md"), path);
  const old = /fenced block|`pinned:`, `warning:` and `notice:` lines|on a line of its own|quote both/;
  const dirs = ["skills", "shared"].map((dir) => new URL(`../${dir}/`, import.meta.url));
  for (const file of dirs.flatMap((dir) => readdirSync(dir, { recursive: true }).filter((name) => name.endsWith(".md")).map((name) => new URL(name, dir)))) assert.doesNotMatch(readFileSync(file, "utf8"), old, file.pathname);
});

test("every github-write command line in the skills that writes to a repository names --repo", async () => {
  const skills = new URL("../skills/", import.meta.url);
  let checked = 0;
  for (const path of readdirSync(skills, { recursive: true }).filter((name) => name.endsWith(".md"))) {
    for (const span of readFileSync(new URL(path, skills), "utf8").match(/github-write\.mjs (?:post|edit|reply|pr-body)\b[^`\n]*/g) ?? []) {
      if (!span.includes("<") || span.includes("--dry-run")) continue;
      checked += 1;
      assert.ok(span.includes("--repo"), `${path}: ${span}`);
    }
  }
  assert.ok(checked >= 4, String(checked));
});

test("a refused write is fixed by what its refusal names, and the kit's approval settings are never the remedy", () => {
  const rules = read("shared/decision-points.md");
  assert.match(rules, /^- When a kit write is refused, fix what its refusal names \(its last line names the check that refused: `refused by github-write`, `refused by pins`, `card refused by card-check`\), quote the text again and run the command again\. Never change the kit's approval settings \(`profile\.mjs publish-approval`\) to get past a refusal\.$/m);
});

test("no file in the plugin uses the retired publish menus or answer-mode tickets", () => {
  const retired = new RegExp(["post\\.as" + "Is", "approve\\.a" + "ll", "consume" + "Approval", "publish-approval-" + "ticket"].join("|"));
  const root = new URL("../", import.meta.url);
  const files = readdirSync(root, { recursive: true }).filter((path) => /\.(?:mjs|md|json|py)$/.test(path) && !path.includes("node_modules"));
  assert.ok(files.length > 100, String(files.length));
  assert.deepEqual(files.filter((path) => retired.test(readFileSync(new URL(path, root), "utf8"))), []);
});
