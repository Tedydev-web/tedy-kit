# Jobs (map has `jobs: true`)

In a map with `jobs: true`, the session the user types into is the cockpit, and each role request runs as a short-lived background session, a job, started by `node <plugin>/scripts/job.mjs`. `<plugin>` is the plugin root. A job file is `plans/jobs/<yymmdd-hhmm>-<role>-<slug>.md` under the map's `paths[0]`, in the hand-off format: `to: tedy:<role>`, `from: cockpit`, `status`, `created`, `title`, `cwd`, `session_id`, then the request and its sections.

## Which session this is

A session whose first prompt names a job file is that job (its hook input carries `agent_type: tedy:<role>`). In a `jobs` map any other session is the cockpit, except a session the map still lists in `sessions`, which keeps its legacy role until the switch.

## Cockpit

1. Do no role work: read only what picking the owner needs. Tracker, PRD, Doc or Figma → `pm`; a PR review → `review`; code in a repository → `dev` with `--repo <path>`; deploy or infrastructure → `devops`. Read-only questions the cockpit may answer itself.
2. Typing a request is the user's approval to start its job. Ask one `AskUserQuestion` only when the owner is unclear or the request spans two roles, and split such a request into one job per role.
3. Write the user's words verbatim into a temporary file, followed by `## User decisions` (what the user settled, or "none yet"), `## First safe step` (one read-only step) and `## Sources` (locators). Then `node <plugin>/scripts/job.mjs start <pm|dev|review|devops> --title "<short title>" --body-file <file> [--repo <path>]`. Reply with one line: the job name and its file. `--dry-run` prints the `cd … && claude …` line instead, for a launch the user runs by hand.
4. When `start` fails with `Workspace not trusted`, the job is stopped; tell the user to open `claude` once in that folder and accept the trust dialog, then start it again.
5. Approve with `/tedy:pending`: it lists the cards and the jobs that are not closed. A card of a running job is not offered. A `question` card that asks to start another role's job is started here on yes.
6. Rework: on `approve.reword`, a refused card, or a question answer the job needs, write the note to a file and run `job.mjs resume <job file> --note-file <file>`. It stops the job's session, waits for the stop, and resumes it with its context.
7. Close: once a job is `done` or `stopped` and no open card names it, `job.mjs close <job file>` stops and removes its session. A runaway job: `job.mjs close <job file> --reason "<why>"`. `job.mjs list` shows every open job with its age, and a running job whose session is gone as `lost`.
8. Never answer a job's permission prompt; agent view's Needs input shows those to the user.

## Job

1. Read the job file the prompt names, then follow the role skill (`/tedy:pm`, `/tedy:dev`, `/tedy:review-pr`; devops has none) on the request in it. A `## Note` at its end is the latest rework request. Keep the files it writes for itself (card bodies, the outcome) under the project's `plans/`, which its allowlist lets it write without a prompt.
2. Never call `AskUserQuestion`: nobody watches a background session, so a question waits forever. A decision, the next-step menu included, becomes a `question` card: `node <plugin>/scripts/pending.mjs card question --title "<t>" --body-file <f> --job <this job file>`.
3. Every write that needs the user's approval becomes a `publish` card holding the exact command, with `--job <this job file>`, and its text (`pending.mjs card publish …`); the job never runs that write. In a review job, status after merge is `merged-sweep.mjs --inbox --job <this job file>`.
4. Work for another role becomes a `question` card ("start a <role> job for …?"); the cockpit starts it on yes. A job never starts a job.
5. Local work goes ahead without a card: the worktree, commits, pushing the task branch and the draft PR with `OP#`. A dev job commits and pushes its task branch itself and never asks before committing. Run git in the job's worktree as `git -C <worktree> <subcommand>`, never `cd <worktree> && git …`, so the job's allowlist covers it.
6. End every path with `node <plugin>/scripts/job.mjs done <this job file> --outcome-file <f>`, the outcome naming the drafts, cards, PR URLs and report path, or with `job.mjs stop <this job file> --reason "<why>"`. Never run `claude stop` or `claude rm`.

## Permissions

`job.mjs` starts each job with its role's allowlist through `--settings`, plus `worktree.bgIsolation: "none"` so its edits land in the working copy the cockpit reads. Every role may read the plugin, the project and the profile, write under `plans/`, run the kit's read scripts, `pending.mjs card publish|question|notify`, `job.mjs done|stop`, and the read-only git and `gh pr` commands. Dev and devops jobs may also edit, run `npm test` and the `npm run` scripts `typecheck`, `lint`, `lint:check`, `format:check`, `check`, `test`, `test:unit` and `test:cov`, make and remove worktrees, commit, push with `git push -u origin <branch>` and open a draft PR. Review jobs may also run `npm test` and add a worktree. Publish scripts, deploys, `job.mjs start` and `pending.mjs done` are not on any list, and the kit's publish ask rules and its gates' asks prompt over every allow rule. Under `bypassPermissions` the list changes nothing. A background job has no spend cap.
