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

## Not this skill

Posting a review draft → `/tedy:review-pr`. Posting Doc or Figma comments or tracker drafts → `/tedy:pm`. Taking a hand-off → `shared/handoff.md`.

## Procedure

1. **List.** From the project directory: `node ${CLAUDE_PLUGIN_ROOT}/scripts/pending.mjs list`. Quote its output; it prints `Nothing waits on the user.` when the list is empty. Done when the output is in the reply.
2. **Done.** For `done <file>`: confirm the item was posted, sent, applied or dropped (the posting tool's output, a comment list or a tracker read-back), then `node ${CLAUDE_PLUGIN_ROOT}/scripts/pending.mjs done <file>` and report the `archived:` path. Done when the file sits under `plans/archive/` and `MOVES.tsv` has its line.
3. **Stub.** For an item with no file and no git trace (a message the user must send, a call to make): `node ${CLAUDE_PLUGIN_ROOT}/scripts/pending.mjs stub "<action>"`. Done when the printed file exists.

## Done

The reply quotes the current list, and every archived or stubbed file path is named.
