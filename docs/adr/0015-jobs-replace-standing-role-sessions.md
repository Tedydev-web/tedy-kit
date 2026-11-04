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
- ADR 0012 is amended for `jobs` maps: a status move goes through an inbox card that the cockpit applies; the job does not apply it.
- Each job starts with a fresh context and carries its record in files (job file, drafts, reports), so a job re-reads its own sources.
- A background session has no spend cap (`--max-budget-usd` works only with `--print`); the launcher and the probe bound it by stopping sessions.
- The lock covers kit writers on this machine only, not a teammate writing by hand or a second machine.
- Weakest link: no study measured job agents against standing role sessions for one person. The decision rests on what the industry builds, the failure reports of systems built on long-lived agent mailboxes, and the user's own friction figures.

## Measured
- Not yet. A live probe must confirm, on the installed Claude Code, that hooks see `agent_type` for a plugin agent, that a background session accepts `--session-id`, `--name` and `--settings` and passes the `env` block to hooks, that a background session still prompts on an ask rule and on a hook ask, that an allow rule removes routine prompts, that worktree isolation can be turned off, and how resume behaves. Until it runs, nothing that depends on these facts is built. Each run's cost and served model go here.
