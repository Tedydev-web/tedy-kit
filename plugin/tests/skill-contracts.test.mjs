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
  const approve = pending.match(/^2\. \*\*Approve\.\*\*[\s\S]*?(?=^3\. )/m)?.[0] ?? "";
  for (const phrase of ["no `AskUserQuestion`", "verbatim", "fenced block", "pending.mjs card-start <card>", "permission prompt is the approval", "Stop at the first block that fails or is refused", "never run a later block", "which blocks already wrote"]) assert.ok(approve.includes(phrase), phrase);
  assert.doesNotMatch(approve, /--approved/);
});

test("the cockpit closes a finished job on its notification turn with close --if-finished, and a dev job with an open PR stays open for rework", () => {
  const jobs = read("shared/jobs.md");
  const cockpit = jobs.match(/^5\. Questions go through question cards.*$/m)?.[0] ?? "";
  assert.ok(cockpit.includes("job.mjs close <job file> --if-finished"), "Cockpit 5");
  const close = jobs.match(/^7\. Close: .*$/m)?.[0] ?? "";
  for (const phrase of ["close --if-finished", "no question or publish card names", "keeps a dev job open while its branch has an open PR", "merged or closed", "when the user asks", "every refusal of `close`"]) assert.ok(close.includes(phrase), phrase);
  const pending = read("skills/pending/SKILL.md");
  const closing = pending.match(/^   - Once no question or publish card names a job .*$/m)?.[0] ?? "";
  assert.ok(closing.includes("job.mjs close <job file> --if-finished"), closing);
  assert.doesNotMatch(pending, /as `done` or `stopped`, run `node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/job\.mjs close <job file>`/);
});

test("an answer is written onto its card only after resume sent it, a refused card is archived by the job that redoes it, and a job never runs untrusted code alone", () => {
  const pending = read("skills/pending/SKILL.md");
  const questions = pending.match(/^3\. \*\*Questions\.\*\*[\s\S]*?(?=^\d\. )/m)?.[0] ?? "";
  for (const phrase of ["one `job.mjs resume` per job", "Only after that call went out", "When `resume` prints `busy:`", "leave every card of that job as it is"]) assert.ok(questions.includes(phrase), phrase);
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
  const reword = pending.match(/^   - On a "No" at a block's prompt.*$/m)?.[0] ?? "";
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

test("the cockpit branches on resume's busy: or refused: prefix, settles a start-job card itself, and a plain close settles the job's questions", () => {
  const pending = read("skills/pending/SKILL.md");
  const round = pending.match(/^   - \*\*Round per job\.\*\*.*$/m)?.[0] ?? "";
  for (const phrase of ["When `resume` prints `busy:`, leave every card of that job as it is", "when it prints `refused:`, quote it and `card-note --refuse` each unanswered card of that job with the reason", "any other output leaves them (`shared/jobs.md`, Cockpit 6)", "\"Answered and delivered\" with `pending.mjs done`"]) assert.ok(round.includes(phrase), phrase);
  assert.doesNotMatch(round, /no launch record|lost its folder|is closed|permanent/);
  assert.match(pending, /a card asking to start another role's job is settled here: start it on yes, then on any answer `card-note` the label and `done` it; every other answer goes back/);
  const jobs = read("shared/jobs.md");
  const six = jobs.match(/^6\. Answers and rework go through SendMessage\.[\s\S]*?(?=^7\. )/m)?.[0] ?? "";
  assert.match(six, /prints one line on stderr that starts with `busy:` or `refused:`; branch on that prefix, never on the wording\./);
  assert.match(six, /Any other output that is not the JSON object leaves the cards as they are\./);
  assert.match(six, /An answered card is archived with `pending\.mjs done` and never refused, whatever the job's state later\./);
  assert.doesNotMatch(six, /in every case `close` refuses|A permanent refusal \(|starts:/);
  assert.match(jobs, /^5\. [^\n]*A `question` card that asks to start another role's job is the cockpit's own: on yes start that job with step 3, then on any answer `card-note` the label and `pending\.mjs done` it; that answer never goes into the writer's note\./m);
  assert.match(jobs, /^5\. [^\n]*once no question or publish card names the job/m);
  assert.match(jobs, /^4\. Work for another role becomes a `question` card \("start a <role> job for …\?"\) written with `pending\.mjs card question --job <this job file> …`; the cockpit starts it on yes\./m);
  assert.match(jobs, /^7\. Close: a `done` job that no question or publish card names \(a started or refused card counts, a notify card does not\)/m);
  assert.match(jobs, /^7\. Close: [^\n]*A `stopped` job that no question or publish card names/m);
  assert.match(jobs, /^7\. Close: [\s\S]*?A plain `close` archives each answered question card of the job as delivered and refuses and archives each other open question card with its reason, except a started card;/m);
  assert.doesNotMatch(`${jobs}\n${pending}`, /--starts|`starts:`/);
});

test("every kit write a skill runs is approved at its own permission prompt after the reply quoted it, never by a menu answer", () => {
  const flow = read("shared/status-flow.md");
  assert.doesNotMatch(flow, /ride in the|yes there approves/);
  assert.match(flow, /quote both in one fenced block of the reply, then run that command through `publish-batch\.mjs`; its permission prompt is the approval/);
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

test("every publish quotes the verbatim text in one fenced block of the reply before its command runs", () => {
  const review = read("skills/review-pr/SKILL.md");
  const approval = review.slice(review.indexOf("10. **Approval.**"), review.indexOf("12. **Next step.**"));
  for (const phrase of ["verbatim", "fenced block", "permission prompt"]) assert.ok(approval.includes(phrase), `review-pr steps 10 and 11: ${phrase}`);
  for (const path of ["skills/review-pr/references/draft-format.md", "skills/review-pr/references/follow-up.md", "skills/dev/references/rebut.md", "skills/pm/SKILL.md"]) assert.ok(read(path).includes("fenced block"), path);
  assert.match(read("shared/decision-points.md"), /^- Publishing is never asked with `AskUserQuestion`\./m);
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
