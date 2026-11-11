---
name: pending
description: Show what waits on the user (inbox cards, jobs, drafts, unpushed branches, draft PRs), approve cards in one batch, archive a finished draft
argument-hint: "[approve | done <file> | stub <action>]"
disable-model-invocation: true
---

Plugin root: `${CLAUDE_PLUGIN_ROOT}`. Use this absolute path wherever shared files say `<plugin>`; the variable is not set in Bash.

You keep the user's waiting list honest: it is read from the work itself, never written by hand.

## Iron laws

1. The list comes from `pending.mjs`; never keep a second list by hand, because a copy drifts from the files it describes.
2. A draft leaves `plans/drafts/` only through `pending.mjs done`, after the tool that published or applied it confirms the result, or after the user drops it.
3. Archiving is local; it never publishes, pushes or changes a tracker.
4. Only an answer publishes. A timed-out, unanswered or annotated question leaves every card as it was, in `ask` mode too; never take an option for the user.
5. A card's commands run only from a card under "To publish" that `pending.mjs card-start` accepted just before; a card under "Started, not closed" is never run again.

## Not this skill

Posting a review draft → `/tedy:review-pr`. Posting Doc or Figma comments or tracker drafts → `/tedy:pm`. Taking a hand-off → `shared/handoff.md`.

## Procedure

1. **List.** From the project directory: `node ${CLAUDE_PLUGIN_ROOT}/scripts/pending.mjs list`. Quote its output; it prints `Nothing waits on the user.` when the list is empty. Cards (files in `plans/drafts/` with a `kind:` header, written by `pending.mjs card`) list under "To publish", "Questions", "For your information", "Started, not closed" and "Refused cards"; other drafts, stubs and hand-offs list as before. Done when the output is in the reply.
2. **Approve.** For `approve`, take the cards under "To publish", leaving out any marked `job running`. Each `### n` block is one command on its first line plus the text it writes.
   - For a `preview: run` card, first `node ${CLAUDE_PLUGIN_ROOT}/scripts/pending.mjs card-check <card>`, and only when it passes run each block's command as written (it has no `--apply`), quote its output, and make the block `<command> --apply`, plus `--lock <n>` when the output prints one (`set` does; `comment`, `relation` and `doc-comment-file post` do not), followed by the quoted lines.
   - `AskUserQuestion`, header `approve.header`, one question per block, at most four per call, each question naming the card title and the block number so no two questions in a call share text (a repeated text gets no approval); a card with more blocks takes several calls, its blocks together. Options: `approve.all`, whose `preview` is the block verbatim; `approve.reword`; `approve.hold`; `approve.drop`. Never `multiSelect`.
   - A card runs only when every one of its blocks got `approve.all`. Then first `node ${CLAUDE_PLUGIN_ROOT}/scripts/pending.mjs card-start <card> --approved <every block number that got approve.all, comma-separated>`. It runs every `card-check` check (a refused or started card, a running job, a block that is not one kit publish command, a draft whose sha256 differs from `draft-sha:`), refuses unless the list holds every block of the card, and marks the card `status: started`, so it is never offered or run again. Then run the approved commands in card order and quote each read-back. When every block succeeded, `pending.mjs done <card>`, which also archives its `draft:` when no other card names it. A card under "Started, not closed" stays there until its read-backs are checked and it is closed with `done` or `card-note --refuse`.
   - On `approve.reword`, a `card-check` or `card-start` refusal, or a writer's refusal (pin, ledger or lock): before anything else `pending.mjs card-note <card> --text "<why>" --refuse`, so the old card can never run after the draft is redone, then name the job or session that must redo it and which blocks already wrote. `approve.drop` → `pending.mjs done <card>`. `approve.hold` leaves the card.
   - Once no open card names a job listed under "Jobs" as `done` or `stopped`, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/job.mjs close <job file>`, which refuses and writes nothing while the job's agent is still running, waiting or not yet started in a live cockpit session, or when its bound agent's record holds no cockpit pid, because any job can mark another job `done` or `stopped`. When it refuses, quote the refusal, tell the user why the job stays open, and do not close it. When it closes a job an older kit started, quote its line that the job's session is the user's to end.
3. **Questions.** Ask each card under "Questions" that is not yet shown as `(answered: …)` as one question, its option lines as the options in card order (the first is the recommended one and gets `(Recommended)`) and their consequences as the descriptions. Write the chosen label into the card with `pending.mjs card-note <card> --text "<label>"`. A card whose options are the `run.none`, `run.lint` and `run.all` labels is a review job's run question: ask it with header `run.header` and its question text as written, naming the one head sha, so the hook records an approving answer for that sha. When the card names a job, follow `${CLAUDE_PLUGIN_ROOT}/shared/jobs.md` Cockpit 5 and 6: a card asking to start another role's job starts it on yes; any other answer goes back to the job with `job.mjs resume` and the SendMessage or Agent call it prints.
4. **Notices.** One `multiSelect` question listing the cards under "For your information" (up to four options per question); `pending.mjs done` each one the user picks.
5. **Done.** For `done <file>`: confirm the item was posted, sent, applied or dropped (the posting tool's output, a comment list or a tracker read-back), then `node ${CLAUDE_PLUGIN_ROOT}/scripts/pending.mjs done <file>` and report the `archived:` path. Done when the file sits under `plans/archive/` and `MOVES.tsv` has its line.
6. **Stub.** For an item with no file and no git trace (a message the user must send, a call to make): `node ${CLAUDE_PLUGIN_ROOT}/scripts/pending.mjs stub "<action>"`. Done when the printed file exists.

## Done

The reply quotes the current list, every archived, stubbed or noted file path is named, and every command run from a card has its read-back quoted.
