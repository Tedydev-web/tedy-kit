# 0015: Short-lived job agents replace standing role sessions

Status: accepted (2026-11-04); not yet implemented, and the platform facts it rests on are not yet probed

## Context
- ADR 0003 gives each role (PM, Dev, review) its own long-running session, and the sessions pass work through hand-off files and cross-session messages. One month of the user's own transcripts on a mapped project (read 2026-11-03) shows what that costs:
  - The PM session became the hub: 149 of 216 hand-offs went to it, about 1,000 coordination tool calls a month.
  - 13 sends failed and 1 message expired; the user ran `/clear` 102 times.
  - The PRD and the Figma file were re-read in several sessions on 19 of 20 days, approvals were spread over several windows, and the dispatch session was abandoned after two days.
- The parts that work stay: the one-writer rule and the role gate asked 27 times in about 2,600 checks.
- Session display names are not a stable identity: they reverted or went missing in Claude Code issues #95807 (fixed 2026-10-21), #93619 and #97220 (open). Under `claude --agent <name>` the hook input carries `agent_type`.
- AskUserQuestion never times out in a background session or under Remote Control, so a rule that acts on a timeout never fires there (shared/decision-points.md).
- No vendor or local session manager found in the 2026-11-03 study runs standing role sessions that message each other. The common shape is one short-lived agent per job, writing alone and ending in a draft or a PR, with the human as orchestrator.

## Decision
- The user types every request into one cockpit session. Each job runs as its own background session, `claude --agent tedy:<role> --bg --name "<role> <project> <job>"`, for the roles `pm`, `dev`, `review` and `devops`, and ends in a draft, a draft PR or an inbox card. Code jobs work in their own worktree.
- The cockpit runs the approved writes, so publish prompts appear in one window and writes stay single-threaded.
- One writer per external record (tracker item, Doc, Figma file, PR review) is enforced on the write path: each publish script takes a per-record lock, re-checks its pins, and refuses a write when a different job wrote the same record after this draft's sources were pinned. Which session runs the script no longer matters.
- Everything that waits on the user is a typed card (`publish`, `question`, `notify`) in `plans/drafts`, listed by `/tedy:pending` and approved in one batch from the cockpit, one question per command. Nothing publishes on a timeout.
- A role is read from the hook input's `agent_type`, never from a session display name.
- Each job starts with its role's permission allowlist on the launch line (`--settings`), because plugin agents ignore `permissionMode` and a plugin `settings.json` cannot carry permissions. Rules run deny, then ask, then allow, so the allowlist cannot bypass a publish ask rule. Background worktree isolation is off for jobs, so drafts land where the cockpit reads them.
- A `jobs` field in the project map turns this on per project. The `sessions` field and hand-off files keep working until the user switches a project and confirms the switch; they are removed after that.

## Enforcement
- Lock and ledger refusals, each proved by a test with two real child processes and by per-writer tests for GitHub, Doc and Figma.
- Role-gate tests that read `agent_type` without a `claude agents` lookup.
- Inbox tests: a card block that is not exactly one kit publish command is refused, and an unanswered question publishes nothing.
- Argv tests for each role's allowlist in the job launcher.
- A live probe in `plugin/evals/probes/run-probes.sh` for the platform facts below, outside `npm test`.

## Prior art

- Claude Code hooks reference (Anthropic docs, studied 2026-11-04, via web)
  - https://code.claude.com/docs/en/hooks "The agent name, present when you start Claude Code with `claude --agent <name>`"
  - Lesson: the platform hands hooks a role name chosen at launch, which a display name never was.
  - Taken: the role comes from `agent_type`.
- Claude Code permissions docs (Anthropic docs, studied 2026-11-04, via web)
  - https://code.claude.com/docs/en/permissions "a matching ask rule prompts even when a more specific allow rule also matches the same call"
  - Lesson: an allowlist can remove routine prompts without weakening a publish ask rule.
  - Taken: per-role allowlists on the launch line, with the publish ask rules unchanged.
- Claude Code cross-session messaging docs (Anthropic docs, studied 2026-11-04, via web)
  - https://code.claude.com/docs/en/cross-session-messaging "a message from another session never counts as your consent"
  - Lesson: messages between sessions cannot carry an approval, so a hub of sessions still needs the user in every window.
  - Taken: approvals move to one inbox in the cockpit.
- Cognition, Multi-Agents: What's Actually Working (public post, studied 2026-11-04, via web)
  - https://cognition.com/blog/multi-agents-working "multi-agent systems work best today when writes stay single-threaded and the additional agents contribute intelligence rather than actions"
  - Lesson: parallel writers fragment decisions; helpers that advise do not.
  - Taken: the cockpit runs every approved write, and jobs only draft.
- LangChain, Introducing ambient agents (public post, studied 2026-11-04, via web)
  - https://blog.langchain.com/introducing-ambient-agents/ "The downside of Slack is that it's easy to lose track of all the notifications."
  - Lesson: an absent human needs typed requests (notify, question, review) in one inbox, not a stream of chat messages.
  - Taken: typed cards in `plans/drafts`, listed by `/tedy:pending`.
- Jules, Reviewing plans and giving feedback (Google docs, studied 2026-11-04, via web)
  - https://jules.google/docs/review-plan/ "If you navigate away, Jules will eventually auto-approve the plan, which is set on a timer."
  - Lesson: an approval on a timer acts without the person.
  - Not taken: nothing in the kit acts on a timeout, because published text goes out under the user's name.
- Boris Cherny on parallel sessions (public post, studied 2026-11-04, via x)
  - https://x.com/bcherny/status/2017742743125299476 "Spin up 3–5 git worktrees at once, each running its own Claude session in parallel."
  - Lesson: the Claude Code team runs parallel work as separate sessions in separate worktrees, not as roles talking to each other.
  - Taken: each code job works in its own worktree.

## Consequences
- ADR 0003's role-per-session rule is superseded in a map with `jobs`, and removed in full when the legacy `sessions` path is removed.
- ADR 0007 rejected a role persona through `claude --agent` because an agent body replaces the default Claude Code system prompt. The job agents have front matter and no body, which is expected to keep the default prompt and the skills list; the probe must confirm it, and if a body turns out to be required, 0007's rejection stands and jobs stop for the user.
- ADR 0012 is amended for `jobs` maps: a status move goes through an inbox card that the cockpit applies; the job does not apply it.
- Each job starts with a fresh context and carries its record in files (job file, drafts, reports), so a job re-reads its own sources.
- A background session has no spend cap (`--max-budget-usd` works only with `--print`); the launcher and the probe bound it by stopping sessions.
- The lock covers kit writers on this machine only, not a teammate writing by hand or a second machine.
- Weakest link: no study measured job agents against standing role sessions for one person. The decision rests on what the industry builds, the failure reports of systems built on long-lived agent mailboxes, and the user's own friction figures.

## Measured
Probe run 2026-11-06 on Claude Code 2.1.318 with `plugin/evals/probes/run-probes.sh` blocks [9] to [13b] and a body-less probe agent. Served model `claude-sonnet-5-5` (the Explore subagent in [9] ran on `claude-opus-4-8` through the user's alias remap). Spend about USD 6.4: the `-p` runs measured USD 2.03, and the background sessions are estimated at USD 4.4 from their transcript usage, priced at the rate of the [12] parent run.
- [9] Hooks see a plugin agent's scoped name: PreToolUse and SessionStart input carry `agent_type: probe:zz-job-probe`, so tedy jobs read `tedy:<role>`. A subagent's input carries its own `agent_type` (`Explore`), an `agent_id` and the parent's `session_id`. A body-less agent still lists the model-invocable skills.
- [10] A body-less plugin agent resolves under `--agent`; one `-p` call cost USD 0.225 to 0.437.
- [11] `--bg` does not honour `--session-id`: the session gets its own id, and the launch prints `backgrounded · <short id> · <name>`, where the short id is the first 8 characters of the `sessionId` in `claude agents --json`. `--name` shows. The `--settings` `env` block reaches hooks. `agent_type` holds under `--bg`, `permission_mode` is the user's default mode, a slash command as the first prompt starts a `disable-model-invocation` skill, the Stop hook carries `agent_type` with entrypoint `cli`, and the transcript has `usage` lines.
- [11b] and [11d] Under the user's default `bypassPermissions`, a background session waits on a permission prompt for a `permissions.ask` rule and for a hook `ask`: Q1's default holds.
- [11c] With `--permission-mode default`, a `--settings` allow rule lets `git status` run without a prompt, and a hook `ask` still prompts over a matching allow rule (`Bash(echo *)`), so the dev and devops allowlists may keep `git push` and `gh pr create` behind git-gate's asks.
- [11e] `worktree.bgIsolation: "none"` through `--settings` is honoured: the file landed in the working folder and no background worktree was made, and `git worktree add` ran under `Bash(git *)`. The commit in that worktree prompted, but the agent wrote it as `cd ../wt && git add && git commit`, which `Bash(git *)` does not match, so whether a job commits in its own worktree without asking is not settled. Without the setting the session called EnterWorktree and wrote inside `.claude/worktrees/<name>`.
- [12] A Bash call inside a `-p` session started a background session that outlived its parent, with `agent_type` and the mark kept, so the launcher can run from a session's own Bash call.
- [13] `--resume <short id> --bg` does not take the short id: it opens the session picker and the new row stays blocked. With the full `sessionId` it resumes a stopped session under a new session id and keeps `agent_type` without `--agent`.
- [13b] Resuming a running session by its full id starts a copy with a new id, and the original keeps waiting, so `resume` must stop the job first.
- For the launcher: a job's id cannot be chosen up front. It is read back from the launch line and `claude agents --json`, or from the `env` mark the job's hooks log, and it changes on every resume.
