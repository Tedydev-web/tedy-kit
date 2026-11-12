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

test("a review job asks to run PR code on a question card that the cockpit asks with the run header, and the answer goes back through SendMessage", () => {
  const checkout = read("skills/review-pr/references/checkout.md");
  assert.doesNotMatch(checkout, /own window/);
  for (const phrase of ["`question` card", "full head sha", "`run.none`, `run.lint` and `run.all`", "header `run.header`", "Cockpit 5", "SendMessage", "verify not run: awaiting the run question"]) assert.ok(checkout.includes(phrase), phrase);
  const questions = read("skills/pending/SKILL.md").match(/^3\. \*\*Questions\.\*\*.*$/m)?.[0] ?? "";
  for (const phrase of ["`run.none`, `run.lint` and `run.all`", "header `run.header`", "head sha"]) assert.ok(questions.includes(phrase), phrase);
});

test("the cockpit asks each job's open cards by the pending skill's steps, a job stops only for what the user must decide, and /tedy:pending is the manual view", () => {
  const jobs = read("shared/jobs.md");
  const cockpit = jobs.match(/^5\. Questions go through question cards.*$/m)?.[0] ?? "";
  for (const phrase of ["<plugin>/skills/pending/SKILL.md", "step 2", "step 3", "pending.mjs list --job <job file>", "names the card file", "asked again at the next trigger", "decided itself", "manual and recovery view"]) assert.ok(cockpit.includes(phrase), phrase);
  assert.doesNotMatch(jobs, /Approve with `\/tedy:pending`/);
  assert.match(jobs, /^6\. Answers and rework go through SendMessage\.[\s\S]*?archive it \(`pending\.mjs done <card>`\) only after its call went out/m);
  const job = jobs.match(/^2\. A job cannot ask the user.*$/m)?.[0] ?? "";
  for (const phrase of ["local, reversible choice yourself", "the next-step menu included", "publishing under the user's name", "a push or PR beyond this job's own task branch and draft PR", "a merge", "a scope cut", "picking a side in a conflict between sources", "a destructive or irreversible step", "job.mjs done"]) assert.ok(job.includes(phrase), phrase);
  const points = read("shared/decision-points.md");
  assert.doesNotMatch(points, /Every question, including the next-step menu, becomes a `question` card/);
  assert.match(points, /A job asks no menu/);
  const pending = read("skills/pending/SKILL.md");
  assert.match(pending, /^description: Manual and recovery view of what waits on the user/m);
  assert.match(pending, /`approve\.hold` → `pending\.mjs card-note <card>/);
});

test("the cockpit closes a finished job on its notification turn with close --if-finished, and a dev job with an open PR stays open for rework", () => {
  const jobs = read("shared/jobs.md");
  const cockpit = jobs.match(/^5\. Questions go through question cards.*$/m)?.[0] ?? "";
  assert.ok(cockpit.includes("job.mjs close <job file> --if-finished"), "Cockpit 5");
  const close = jobs.match(/^7\. Close: .*$/m)?.[0] ?? "";
  for (const phrase of ["close --if-finished", "no card names", "keeps a dev job open while its branch has an open PR", "merged or closed", "when the user asks", "every refusal of `close`"]) assert.ok(close.includes(phrase), phrase);
  const pending = read("skills/pending/SKILL.md");
  const closing = pending.match(/^   - Once no card names a job .*$/m)?.[0] ?? "";
  assert.ok(closing.includes("job.mjs close <job file> --if-finished"), closing);
  assert.doesNotMatch(pending, /as `done` or `stopped`, run `node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/job\.mjs close <job file>`/);
});

test("an answer is written onto its card only after resume sent it, a refused card is archived by the job that redoes it, and a job never runs untrusted code alone", () => {
  const pending = read("skills/pending/SKILL.md");
  const questions = pending.match(/^3\. \*\*Questions\.\*\*[\s\S]*?(?=^\d\. )/m)?.[0] ?? "";
  for (const phrase of ["one `job.mjs resume` per job", "Only after that call went out", "When `resume` refuses", "leave every card of that job as it is"]) assert.ok(questions.includes(phrase), phrase);
  const jobs = read("shared/jobs.md");
  assert.match(jobs, /^6\. Answers and rework go through SendMessage\.[\s\S]*?only after its call went out/m);
  const job = jobs.match(/^2\. A job cannot ask the user.*$/m)?.[0] ?? "";
  assert.ok(job.includes("running a PR's code or other untrusted code"), job);
  const publish = jobs.match(/^3\. Every write that needs the user's approval.*$/m)?.[0] ?? "";
  assert.ok(publish.includes("then `pending.mjs done <refused card>`"), publish);
});

test("all answers of one round for a job go back in one note and one resume, and a reworded card is refused only after its note went out", () => {
  const pending = read("skills/pending/SKILL.md");
  const questions = pending.match(/^3\. \*\*Questions\.\*\*[\s\S]*?(?=^\d\. )/m)?.[0] ?? "";
  for (const phrase of ["one note file per job", "one `job.mjs resume` per job", "`card-note --refuse` each reworded card"]) assert.ok(questions.includes(phrase), phrase);
  const reword = pending.match(/^   - On `approve\.reword`.*$/m)?.[0] ?? "";
  assert.ok(reword.includes("comes only after that note went out"), reword);
  const jobs = read("shared/jobs.md");
  assert.match(jobs, /^6\. Answers and rework go through SendMessage\.[\s\S]*?Then put every answer and rework of that round for the job into one note file/m);
  const close = jobs.match(/^7\. Close: .*$/m)?.[0] ?? "";
  assert.ok(close.includes("gh pr list --head <branch> --state open"), close);
  assert.doesNotMatch(close, /named in its outcome/);
});

test("each job's round runs its approved cards before the one resume, and a refusal that only says the job is busy leaves the card open", () => {
  const pending = read("skills/pending/SKILL.md");
  const round = pending.match(/^   - \*\*Round per job\.\*\*.*$/m)?.[0] ?? "";
  const order = ["card-start", "one `job.mjs resume`", "card-note"].map((phrase) => round.indexOf(phrase));
  assert.ok(order.every((at) => at !== -1) && order[0] < order[1] && order[1] < order[2], round);
  assert.ok(round.includes("still running or another live cockpit runs it, leave the card open"), round);
  const jobs = read("shared/jobs.md");
  assert.match(jobs, /^6\. Answers and rework go through SendMessage\.[\s\S]*?run every approved card of the job first/m);
  assert.match(jobs, /When the SendMessage or Agent call fails after `resume`, the record stays running: TaskStop that agent by its id, or wait until the cockpit exits, then `resume` again\./);
  assert.doesNotMatch(jobs, /no open card/);
  assert.doesNotMatch(pending, /Both refuse and writes/);
});

test("a permanent resume refusal refuses the job's cards with its reason, a transient one leaves them open, and a plain close settles the job's questions", () => {
  const round = read("skills/pending/SKILL.md").match(/^   - \*\*Round per job\.\*\*.*$/m)?.[0] ?? "";
  for (const phrase of ["When `resume` refuses because the job is closed, has no launch record or has lost its folder", "`card-note --refuse` each card of that job with that reason", "still running, waiting or starting, or another live cockpit runs it, leave every card of that job as it is"]) assert.ok(round.includes(phrase), phrase);
  const jobs = read("shared/jobs.md");
  assert.match(jobs, /^6\. Answers and rework go through SendMessage\.[\s\S]*?A permanent refusal \(the job is closed, has no launch record or has lost its folder\) refuses its cards with the reason/m);
  assert.match(jobs, /^7\. Close: [\s\S]*?A plain `close` archives the job's open question cards with a refuse note/m);
});

test("every kit write a skill runs after a question is approved by an approve.all or post.asIs option, never by the merge or next-step answer", () => {
  const flow = read("shared/status-flow.md");
  assert.doesNotMatch(flow, /ride in the|yes there approves/);
  assert.match(flow, /`approve\.all`, whose `preview` holds the preview line and, on a line of its own, the same command with `--apply --lock <n>`/);
  const merge = read("skills/review-pr/references/status-after-merge.md");
  assert.doesNotMatch(merge, /approved those lines/);
  assert.match(merge, /`merge\.yes` approves the merge alone/);
  for (const path of ["skills/dev/references/rebut.md", "skills/review-pr/references/follow-up.md"]) assert.match(read(path), /`approve\.all`/, path);
  assert.match(read("skills/pm/SKILL.md"), /`approve\.trim` \([^)]*ask again\)/);
  assert.match(read("skills/pm/references/tracker-openproject.md"), /undone with `rollback`: preview, then `approve\.header` naming close or delete, whose `approve\.all` `preview`/);
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

test("every write command line in the skills names the target answer mode needs", async () => {
  const { readdirSync } = await import("node:fs");
  const skills = new URL("../skills/", import.meta.url);
  const files = readdirSync(skills, { recursive: true }).filter((path) => path.endsWith(".md"));
  const needs = [[/github-write\.mjs (?:post|edit|reply|pr-body)\b/, "--repo"], [/openproject\.mjs (?:apply\b|rollback\b(?=.*--apply))/, "--project"], [/figma-comments\.mjs (?:post|reply|delete)\b/, "--file"], [/gdoc-comments\.mjs (?:reply|anchor|edit|delete)\b/, "--doc"], [/doc-comment-file\.mjs post\b(?=.*--apply)/, "--doc"]];
  let checked = 0;
  for (const path of files) {
    for (const line of readFileSync(new URL(path, skills), "utf8").split("\n")) {
      for (const span of line.match(/(?:github-write|openproject|figma-comments|gdoc-comments|doc-comment-file)\.mjs [^`\n]*/g) ?? []) {
        if (!span.includes("<")) continue;
        for (const [pattern, flag] of needs) {
          if (!pattern.test(span)) continue;
          checked += 1;
          assert.ok(span.includes(flag), `${path}: ${span}`);
        }
      }
    }
  }
  assert.ok(checked >= 4, String(checked));
});
