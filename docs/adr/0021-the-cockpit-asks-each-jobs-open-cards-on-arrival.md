# 0021: The cockpit asks each job's open cards on arrival, and a job stops only for what the user must decide

Status: accepted 2026-11-12 (user decisions); amends the questions part of [ADR 0019](0019-jobs-run-as-native-background-subagents.md); live check pending (Consequences)

## Context
- ADR 0019 made every job a background subagent. A job writes a `question` or `publish` card and ends its turn, and the user answers the cards by typing `/tedy:pending` in the cockpit. A research pass on 2026-11-11 found the problem is not the subagents but the second place the user must visit: Claude Code removes AskUserQuestion from every subagent, so the one session that holds the user has to ask for them. It also found that the job step turned every decision, the next-step menu included, into a question card.
- The user decided on 2026-11-12:
  - Design C: jobs stay background `tedy:<role>` subagents that cannot ask; the cockpit asks every open card of a job that is not running, through AskUserQuestion, with steps 2 and 3 of `plugin/skills/pending/SKILL.md` read by path; answers go back through `job.mjs resume` and SendMessage.
  - Deterministic triggers where Claude Code allows them: a hook on SessionStart and on UserPromptSubmit in the cockpit injects the open cards with the instruction to ask them now, reads only state and card files, and prints nothing when no card is open; the job's final reply names its card file; a timed-out or unanswered question leaves the card, and the next trigger asks it again.
  - Question volume: a job stops only for publishing under the user's name, a push or PR beyond its own task branch and draft PR, a merge, a scope cut, picking a side in a conflict between sources, or a destructive or irreversible step; it decides every local, reversible choice itself, the next-step menu included, and records each ruling with its reason in its outcome.
  - `pending.mjs list --job <file>` filters one job's cards; `/tedy:pending` becomes the manual and recovery view.
  - The answer-mode gap closes: an answer mints a ticket only for `post.asIs` and `approve.all` (`plugin/lib/publish-approval-ticket.mjs`), yet the merge step and the status procedure used the `merge.yes` or next-step answer as approval for `openproject.mjs set … --apply`.
- HumanLayer's 12-factor agents, factor 7 "Contact humans with tool calls" (humanlayer/12-factor-agents at d20c728, `content/factor-07-contact-humans-with-tools.md` lines 3 and 121), has the answer arrive later and resume the run ("Durable"). The kit has no card for that repository, and a card needs a study row in a screened sweep, so it is named here and not linked as prior art.

## Decision
- **The cockpit asks on arrival; the card is the record.** A card is askable when it is open (not refused, not started) and its job is not running: a publish card whose job file is not `running`, the predicate `card-check` and `card-start` enforce, and that the user has not held; a question card with no `answer:` whose job is not busy, where busy means the job file says `running` and `resume` would refuse because its agent runs, waits or may be starting in a live cockpit. A job that ended its turn without `job.mjs done` is therefore still asked.
- **Triggers.** `session-hooks.mjs pending-handoffs` (SessionStart, startup and resume) adds the askable cards of the cockpit's project, held publish cards included, to the session-start notice, with the instruction to ask them per `skills/pending/SKILL.md` steps 2 and 3 now. `session-hooks.mjs ask-cards` on UserPromptSubmit returns the same block as `additionalContext`, held cards left out, on every prompt and on the turn a job's completion starts, which the hooks reference counts as a UserPromptSubmit. The cockpit is the main thread that carries no `agent_id` and does not run as `claude --agent tedy:<role>`. The hook reads card files, job files and launch records only, never git, `gh`, claude or the network, prints nothing when no card is askable, lists at most ten per group and logs `ask-cards` `listed` to the gate log when it lists any. A job ends with `job.mjs done`, its outcome naming the card, and a final reply that names the card file, so the completion-notification turn asks it at once (`plugin/shared/jobs.md`, Cockpit 5 and Job 2).
- **Hold.** `approve.hold` notes the hold label on the publish card (`pending.mjs card-note`), so the per-prompt trigger stops asking it; the next session start asks it again. The user's decisions did not cover a held card; this was decided in the user's absence to keep "not yet" from being re-asked on every prompt.
- **Answered cards.** Once the answer has gone back through `resume`, or the job a card asked for has started, the cockpit archives the card with `pending.mjs done`, so `close` is not held by it and the record stays under `plans/archive/`.
- **`pending.mjs list --job <file>`** lists only that job's cards and its line under "Jobs", and skips the git and `gh` lookups.
- **Question volume.** A job records every local, reversible ruling, its next step included, with its reason in its `job.mjs done --outcome-file`, and writes a question card only for the items above. On the notification the cockpit tells the user what the job did and decided.
- **Standard version 4 narrows per-turn-hooks (ADR 0014, T2).** The rule forbade any kit hook on an event whose output enters the context on every prompt, because "Text added on every turn is paid on every turn"; the user's decision of 2026-11-12 asks for a UserPromptSubmit hook that prints nothing when no card is open. The rule now allows exactly one UserPromptSubmit group that runs only `session-hooks.mjs ask-cards`, and `hookEventErrors` fails any other per-turn registration. The user approved the hook, not this wording of the exception. Going back to the old rule removes only the UserPromptSubmit hook; the session-start trigger and the job's reply naming its card still bring the cards to the cockpit.
- **Approval by ticket labels only.** Every kit write a skill runs after a question is approved by an `approve.all` (or `post.asIs`) option whose `preview` holds that exact command, quoted per `plugin/shared/decision-points.md` (ADR 0020). `merge.yes` approves the merge alone; after `gh pr merge` succeeds, each status `set` is previewed again and asked as its own `approve.all` question. `approve.trim` and `post.trim` lead to a new dry run and a new question, never to the write.

## Enforcement
- `plugin/tests/pending-ask-cards.test.mjs`: "list --job prints only that job's line and cards, and nothing from another job, the drafts or git", "the ask list holds a question of a job whose agent ended its turn, even when its file still says running, and leaves out one whose agent still runs", "the ask list holds a publish card only once its job file is not running, and a held one only when asked to", "the ask list leaves out answered, refused, started and notice cards, and a card with no job counts as not running".
- `plugin/tests/cockpit-asks-cards.test.mjs`: "the cockpit's session start asks the open cards of jobs that are not running by the pending skill's steps 2 and 3, and logs that it listed them", "a session start with no card to ask prints no ask block, and a role session started as a tedy job never gets one", "each prompt in the cockpit, a job's report-back turn included, gets the askable cards as UserPromptSubmit context, and nothing when none is askable", "the per-prompt list leaves out a held publish card that the session start still asks, and lists at most ten cards per group".
- `plugin/tests/hooks.test.mjs`: "the ask-cards hook runs on every prompt in a plain command group, never blocking, with a short timeout".
- `plugin/tests/canon-checks.test.mjs`: "a kit hook on an event that adds text to every prompt or every subagent spawn fails, except the cockpit's one ask-cards prompt hook".
- `plugin/tests/role-gate.test.mjs`: "a job's role card names jobs.md and never a hand-off, and the cockpit card tells it to ask the jobs' open cards".
- `plugin/tests/skill-contracts.test.mjs`: "the cockpit asks each job's open cards by the pending skill's steps, a job stops only for what the user must decide, and /tedy:pending is the manual view", "every kit write a skill runs after a question is approved by an approve.all or post.asIs option, never by the merge or next-step answer", "a review job asks to run PR code on a question card that the cockpit asks with the run header, and the answer goes back through SendMessage".
- `plugin/tests/job.test.mjs`: "decision-points.md tells a job it never asks the user and writes a card instead, as jobs.md Job 2 says".
- Not machine-checked: that the model asks the listed cards in the turn they are injected, and that SubagentStop marks a job idle before the notification's UserPromptSubmit runs. The live check after release covers both.

## Prior art

- Claude Code hooks reference (Anthropic docs, studied 2026-11-12, via web)
  - https://code.claude.com/docs/en/hooks "`UserPromptSubmit` hooks don't fire only on prompts you type."
  - https://code.claude.com/docs/en/hooks "A background subagent reporting back to the session that started it"
  - https://code.claude.com/docs/en/hooks "Neither channel produces a visible transcript entry. Plain stdout and the `additionalContext` value are each injected as a system reminder that starts with the hook's name; Claude reads both."
  - Lesson: a UserPromptSubmit hook's `additionalContext` reaches the model on every prompt and also on the turn a background job's completion starts, and it leaves no transcript entry.
  - Taken: the per-prompt trigger, and the gate-log line as the only trace a live check can read.
- anthropics/claude-code issue 18721 (proprietary, studied 2026-11-12, via github)
  - card: claude-code-surfaces
  - https://github.com/anthropics/claude-code/issues/18721 "a question back to the main agent so the main agent can then prompt the user"
  - Lesson: a subagent cannot prompt the user, so its question has to travel back to the main session, which asks.
  - Taken: the job writes the card and stops; the cockpit asks.
- obra/superpowers (MIT, studied 2026-11-12, via github)
  - card: superpowers
  - https://github.com/obra/superpowers/blob/22f0b463e7a5e579904dd6211a520321035526f7/skills/subagent-driven-development/implementer-prompt.md#L87 "Report back with status BLOCKED or NEEDS_CONTEXT."
  - https://github.com/obra/superpowers/blob/22f0b463e7a5e579904dd6211a520321035526f7/skills/subagent-driven-development/SKILL.md#L22-L23 "Record every decision in the ledger as `Ruling: <what you decided> — <why> — <what it costs if wrong>`"
  - https://github.com/obra/superpowers/blob/22f0b463e7a5e579904dd6211a520321035526f7/skills/subagent-driven-development/SKILL.md#L27-L31 "Four things stop you, and only these: an irreversible or destructive operation; a security-sensitive action; a side effect outside this worktree that norms say you ask about first (a merge, a push to a shared branch, a publish); and a plan so broken that every path forward is a guess."
  - Lesson: a worker escalates through its report and does not wait on a human for a reversible ruling; it records the ruling and stops only for a short list.
  - Taken: the job's stop list and its rulings in the outcome.
- LangGraph interrupts (LangChain docs, studied 2026-11-12, via web)
  - https://docs.langchain.com/oss/python/langgraph/interrupts "waits indefinitely until you resume execution."
  - https://docs.langchain.com/oss/python/langgraph/interrupts "function pauses graph execution and returns a value to the caller."
  - Lesson: the pause is a checkpoint on disk and the caller resumes the run with the answer.
  - Taken: the card is the checkpoint, the cockpit is the caller and `job.mjs resume` with SendMessage is the resume.

no social prior art: 2026-11-12 reddit: "claude code background subagent ask question main session AskUserQuestion"; x: "claude code subagent cannot AskUserQuestion main agent asks user hook UserPromptSubmit"

position: approval-to-absent-user conforms

## Consequences
- The user answers a job's question in the cockpit seconds after the job stops, and never needs `/tedy:pending`; it stays as the manual and recovery view.
- A timed-out or unanswered question costs nothing but a re-ask: the card stays on disk, and a publish never runs on a timeout.
- Fewer questions: a job's reversible rulings arrive as a report on the notification, not as questions. A wrong ruling costs rework the user can see in the outcome.
- Weakest link: no live cockpit has run this yet. The live check after release must show a question card asked on the job's notification turn, the answer reaching the job through SendMessage, and the gate log's `ask-cards` lines.
