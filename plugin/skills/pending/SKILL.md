---
name: pending
description: Show what waits on the user in this project - hand-offs not taken, drafts waiting for approval, unpushed branches and open draft PRs - and archive a draft once it is posted, sent, applied or dropped
argument-hint: "[done <file> | stub <action>]"
disable-model-invocation: true
---

Plugin root: `${CLAUDE_PLUGIN_ROOT}`. Use this absolute path wherever shared files say `<plugin>`; the variable is not set in Bash.

You keep the user's waiting list honest: it is read from the work itself, never written by hand.

## Iron laws

1. The list comes from `pending.mjs`; never keep a second list by hand, because a copy drifts from the files it describes.
2. A draft leaves `plans/drafts/` only through `pending.mjs done`, after the tool that published or applied it confirms the result, or after the user drops it.
3. Archiving is local; it never publishes, pushes or changes a tracker.
4. Only an answer publishes. A timed-out, unanswered or annotated question leaves every card as it was, in `ask` mode too; never take an option for the user.
5. A card's commands run only from a card under "To publish" that `pending.mjs card-check` passed just before.

## Not this skill

Posting a review draft → `/tedy:review-pr`. Posting Doc or Figma comments or tracker drafts → `/tedy:pm`. Taking a hand-off → `shared/handoff.md`.

## Procedure

1. **List.** From the project directory: `node ${CLAUDE_PLUGIN_ROOT}/scripts/pending.mjs list`. Quote its output; it prints `Nothing waits on the user.` when the list is empty. Cards (files in `plans/drafts/` with a `kind:` header, written by `pending.mjs card`) list under "To publish", "Questions", "For your information" and "Refused cards"; other drafts, stubs and hand-offs list as before. Done when the output is in the reply.
2. **Approve.** For `approve`, take the cards under "To publish", leaving out any marked `job running`. Each `### n` block is one command on its first line plus the text it writes.
   - For a `preview: run` card, run each block's command as written (it has no `--apply`), quote its output, and make the block `<command> --apply --lock <n>`, `<n>` from that output, followed by the quoted lines.
   - `AskUserQuestion`, header `approve.header`, one question per block, at most four per call; a card with more blocks takes several calls, its blocks together. Options: `approve.all`, whose `preview` is the block verbatim; `approve.reword`; `approve.hold`; `approve.drop`. Never `multiSelect`.
   - A card runs only when every one of its blocks got `approve.all`. Then first `node ${CLAUDE_PLUGIN_ROOT}/scripts/pending.mjs card-check <card>`, which refuses a refused card, a running job, a block that is not one kit publish command, and a draft whose sha256 differs from `draft-sha:`. Then run the approved commands in card order and quote each read-back. When every block succeeded, `pending.mjs done <card>`, which also archives its `draft:` when no other card names it.
   - On `approve.reword`, a `card-check` refusal, or a writer's refusal (pin, ledger or lock): before anything else `pending.mjs card-note <card> --text "<why>" --refuse`, so the old card can never run after the draft is redone, then name the job or session that must redo it and which blocks already wrote. `approve.drop` → `pending.mjs done <card>`. `approve.hold` leaves the card.
3. **Questions.** Ask each card under "Questions" that is not yet shown as `(answered: …)` as one question, its option lines as the options in card order (the first is the recommended one and gets `(Recommended)`) and their consequences as the descriptions. Write the chosen label into the card with `pending.mjs card-note <card> --text "<label>"`.
4. **Notices.** One `multiSelect` question listing the cards under "For your information" (up to four options per question); `pending.mjs done` each one the user picks.
5. **Done.** For `done <file>`: confirm the item was posted, sent, applied or dropped (the posting tool's output, a comment list or a tracker read-back), then `node ${CLAUDE_PLUGIN_ROOT}/scripts/pending.mjs done <file>` and report the `archived:` path. Done when the file sits under `plans/archive/` and `MOVES.tsv` has its line.
6. **Stub.** For an item with no file and no git trace (a message the user must send, a call to make): `node ${CLAUDE_PLUGIN_ROOT}/scripts/pending.mjs stub "<action>"`. Done when the printed file exists.

## Done

The reply quotes the current list, every archived, stubbed or noted file path is named, and every command run from a card has its read-back quoted.
