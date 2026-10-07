# Comment channels

Every write below prints a `WRITE →` line, triggers the permission prompt, lints the body first, and reads the result back. Bodies live in files so the draft the user approved is the text that is posted.

## Figma

`node <plugin>/scripts/figma-comments.mjs` with the map's `figma.file`; token from `~/.config/figma/token`.

- `list [--since <ISO>]`: threads with replies, newest activity first in each thread.
- `post <node-id> --body-file <f>`: pins the comment on the node at half its width and three quarters of its height.
- `reply <comment-id> --body-file <f>`: only on a root comment; the API rejects replies to replies.
- `delete <comment-id>`: only comments made by the token's own account, for reposting after a restyle. Answered threads are never reposted.
- There is no edit and no resolve endpoint; resolving stays with the user.
- HTTP 429 carries `Retry-After`; the client waits it out up to three times. Comments sit in rate-limit tier 2: 5 per minute on View or Collab seats, 25 to 100 per minute on Dev or Full seats.

## Google Doc (PRD)

`node <plugin>/scripts/gdoc-comments.mjs` with the map's `prd.doc`; the token comes from the `gdrive` rclone remote.

- `list [--since <ISO>]`: comments with their replies and quoted text.
- `reply <comment-id> --body-file <f>`: a reply in that thread, only when it is on the thread's topic. A reply placed under an unrelated thread hides the question from the PM; on 2026-10-07 nine such replies had to be re-anchored.
- `anchor --tab <t.id> --quote "<exact text>" --body-file <f>`: a new question anchored on the passage it is about, through the Docs API. The quote must appear exactly once in the tab.

A new question is always anchored. Without the user's own OAuth client, `anchor` refuses, and the question goes into an HTML hand-off file instead: `plans/reports/pm-comments-<yymmdd-hhmm>-<slug>.html`, one item per question with the exact text to highlight (checked with `prd-section.mjs find` to appear exactly once in the current tab) and the comment text, so the user highlights and posts it.

When the PM answers in a thread but the PRD text still says the old thing, add a question asking the PM to write the decision into the PRD.

Enabling `anchor` (rclone's shared client cannot call the Docs API and is being retired during 2026):

1. In Google Cloud Console, create a project, enable the Google Drive API and the Google Docs API.
2. Create an OAuth client of type Desktop app. Set the consent screen to Internal for a Workspace account, or publish it to Production; a Testing consent screen expires the refresh token after 7 days.
3. `rclone config update gdrive client_id=<id> client_secret=<secret>`, then `rclone config reconnect gdrive:` and sign in again.
