# 0023: Roles run inline, and the job and card layer is removed

Status: accepted 2026-11-13 (user decision); supersedes the job parts of [ADR 0015](0015-jobs-replace-standing-role-sessions.md), [ADR 0018](0018-jobs-are-visible-sessions-opened-by-optional-runtime-adapters.md), [ADR 0019](0019-jobs-run-as-native-background-subagents.md) and [ADR 0021](0021-the-cockpit-asks-each-jobs-open-cards-on-arrival.md); archives the position lint of [ADR 0017](0017-position-pages-over-the-knowledge-base.md); amends the approval quote of [ADR 0022](0022-one-approval-per-publish-at-the-command-prompt.md). Tag `archive/jobs-v0.4.2` holds the removed code: `git checkout archive/jobs-v0.4.2 -- <path>` brings one file back.

## Context
- The live review of PR #965 on 2026-11-13 showed an approval block that opened with the long command line and the job path and ended with 6 `pinned:` lines and a `notice:` line. The comments the user had to read sat in the middle.
- That post also skipped `publish-batch.mjs --shows`, because a job's publish card holds the plain writer command, so the prompt showed only `node …/github-write.mjs post …`.
- The inventory audit of 2026-11-13 (`audit-261113-0909-kit-inventory-keep-archive-delete.md`, in the user's workspace `plans/reports/`, not in this repository) counted 25 job spawns since 2026-10-29 against 235 inline runs of review-pr, pm and dev in the same period. The job, cockpit, card and pending files were 40 files and about 6,900 lines, 10% of the kit, and the three files with the most churn were job files.
- A subagent cannot ask the user: Claude Code removes `AskUserQuestion` from every subagent. So every decision a job met became a card, the cockpit asked it, and the answer went back through `job.mjs resume` and SendMessage. An inline skill asks directly.
- `/tedy:learn`, its memory counts and edit-rate metrics, and the position lint over the knowledge base had no use the user relied on; the user included them in the removal.

## Decision
- **Readable approval block.** Before a publish, the reply shows, for each item, one line naming where it goes (such as `PR #965 · 3 comments (head 788ac98f)`), then its full text verbatim (a review comment as `` **1.** `path:line` `` followed by its sentence and its PRD quote), then the lint's `warning:` lines, if any. It leaves out the command line, the `pinned:` and `notice:` lines and any job or card path; the permission prompt shows the command. The publish-quote gate is unchanged: its normaliser strips `> ` prefixes and folds whitespace, so a markdown layout still counts as shown. Every kit write still goes out as one `publish-batch.mjs <batch.json> --shows "<summary>"` run per turn (ADR 0022).
- **Roles run inline.** `/tedy:pm`, `/tedy:dev` and `/tedy:review-pr` run in the session the user types into. Work for another role is named in the reply, and the skill asks the user with AskUserQuestion whether to run that skill now.
- **The job and card layer is removed.** Gone: `job.mjs`, `job-files.mjs`, `job-worktrees.mjs`, `job-session-hooks.mjs` and `pending-cards.mjs` with their script shims and tests; the role gate (`role-gate.mjs`), its hook entry and tests; the four job agents (`dev`, `pm`, `review`, `devops`); `shared/jobs.md`; and the hook entries for job sessions (PostToolUse, Notification, SubagentStop) and for asking cards on each prompt (UserPromptSubmit). The `tedy:reviewer` agent and every publish gate stay.
  - `pending.mjs` keeps `list`, `done` and `stub`: drafts in `plans/drafts/` waiting on the user, unpushed branches and draft PRs, with no card verbs, inboxes or job listings.
  - `session-hooks.mjs` keeps the Stop decision nudge, the compact reminder and the SessionStart notice of waiting drafts.
  - The writers lose `--job` and the write ledger's job conflict check; the record locks stay.
  - `merged-sweep.mjs` prints the status changes as a ready `batch.json` for `publish-batch.mjs` and the `--summary` command to run, instead of writing a publish card.
  - The review's run-PR-code question is a direct AskUserQuestion with header `run.header` and options `run.none`, `run.lint` and `run.all`; the PostToolUse `review-run-approval` hook records an approving answer for its head sha, as before.
  - A profile `config.json` that still holds `gates.roleGate` loads, and the key is ignored. A project map that still holds `jobs` or `sessions` loads, and `project-map.mjs doctor` names those keys as ignored.
- **Learn and the position lint are removed.** Gone: `skills/learn`, `memory-stats.mjs`, `edit-rate.mjs`, `edit-log.mjs` and `positions.mjs` with their shims and tests, the edit-log calls in the five writers and the learn nudge at session start. The frozen draft original stays, because `github-write.mjs post` and `draft-lint.mjs carry` read it. The position pages under `docs/prior-art` stay as reading docs, and an ADR's `position:` line is still checked against them.

## Prior art

- Claude Code subagents docs (Anthropic docs, studied 2026-11-13, via web)
  - https://code.claude.com/docs/en/sub-agents "The first filter removes these tools, even when listed in the `tools` field:"
  - Lesson: `AskUserQuestion` is on that list, so a role run as a subagent turns every question into a relay through the main session.
  - Taken: the roles run inline in the session the user types into, where they ask directly; the `tedy:reviewer` lenses, which never ask, stay subagents.
- elvis, On Skills vs. Subagents (public post on X, studied 2026-11-13, via x)
  - https://x.com/omarsar0/status/1981798842866557281 "Subagents are useful for handing off subtasks (i.e., separation of concerns) from"
  - Lesson: a subagent fits a subtask handed off from the main task; a role's whole run, which asks the user and publishes under their name, is the main task.
  - Taken: subagents only for the read-only review lenses.
- Kit inventory audit (the user's workspace report, studied 2026-11-13, via local)
  - ~/Documents/workspace/plans/reports/audit-261113-0909-kit-inventory-keep-archive-delete.md:9 "Trong cùng thời gian, skill review-pr, pm và dev chạy 252 lần: 235 lần inline, 17 lần bên trong job."
  - Lesson: the real work already ran inline; the job layer carried 7% of the role runs and 10% of the kit's lines.
  - Taken: remove the job layer and keep the inline path.

position: role-coordination deviates: the page ranks one short-lived agent per job, asked from a cockpit, as adopt; the kit now runs each role inline in the user's session, because the jobs were rarely used, until the private page is updated

## Consequences
- The user answers each question where the role runs, and a publish is shown and approved in the same session; nothing waits on a card.
- Two roles no longer run in parallel. A second request waits for the first, or runs in another session the user opens.
- A dev task no longer gets its own worktree from the kit; `/tedy:dev` branches in the repository as its skill says.
- Without the role gate, nothing asks before a session writes for another role; the skills' "name it and ask" line and the publish gates are the guard.
- Without the write ledger's job check, two sessions commenting on one Doc or PR are not stopped by it; the record lock still stops two writes to one record at the same time.
- Removed files in the archive tag are not maintained; restoring one needs the modules it imported.
