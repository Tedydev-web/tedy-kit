# Comment channels

Every write below prints a `WRITE →` line, lints the body first, and reads the result back. In an interactive session it stops for the user's approval: with `gates.publishApproval: "ask"` a `permissions.ask` rule matches it, or git-gate asks when no rule does; with `"answer"` git-gate runs it only after `approve.all` was picked on a `preview` holding the body verbatim, and refuses it otherwise. A headless `claude -p` run cannot be approved, so the write is refused. Bodies live in files so the draft the user approved is the text that is posted.

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
- `edit <comment-id> [--reply <reply-id>] --body-file <f>`: rewrites a comment or reply this account posted, then reads it back. Use it instead of stacking a second reply when the user's own reply needs a change; text by anyone else is refused.
- `delete <comment-id> [--reply <reply-id>]`: removes a comment or reply this account posted, for a reply placed in the wrong thread; a thread that holds someone else's reply is refused.
- `changed [--since <ISO>]`: the Doc's last edit time and editor; the revision list needs reader access to revisions, which a comment-only account lacks.
- `export [--out <f>]`: the whole PRD as plain text through the same token, with the 429 retry. Use it instead of a hand-built Drive export.

A new PRD question is never posted as a reply under another thread. It goes into an HTML file that stays as the record; the agent then posts it anchored on the highlighted passage once the user approves the batch, and ticks each card in the same file. Without an own OAuth client (below) the user posts from the file by hand: highlight the passage, then comment.

1. Write an items file: `{ "title": "<scope>", "items": [{ "group": "A|B", "epic": "<map prd.tabs key>", "where": "<UC and locator>", "quote": "<exact passage to highlight>", "comment": "<comment text>", "note": "<optional: status or affected task>" }] }`. Group A holds new questions. Group B holds a decision the PM gave in a comment that the PRD text does not yet say, or a passage where the PRD contradicts itself; its comment asks the PM to write the decision into the PRD. The comment is the business text the PM reads (the `doc-figma-comment.md` that `profile.mjs path` printed in step 1, "Who reads it"); `note` holds the technical reason for the user and is shown on the card, never posted. The script refuses build words such as BE, FE, API, contract or a version in the comment, more than three PRD places in one comment, and arrows.
2. `node <plugin>/scripts/doc-comment-file.mjs <items.json>` from the project. It downloads the latest PRD tabs, and writes nothing unless every passage appears exactly once the way Ctrl+F finds it (case-insensitive, inside one paragraph) and every comment passes the Doc lint. On success it prints `plans/drafts/pm-comments-<yymmdd-hhmm>-<slug>.html`.
3. Run it again right before handing the file over whenever the PRD may have changed since, so the check matches the PRD the user will search.
4. Show the user the cards and ask for `approve.header`. Then `node <plugin>/scripts/doc-comment-file.mjs post <items.json> --html <that html>` prints the same list and the WRITE line; add `--apply` to post. Each item is anchored, read back, recorded in the items file as `posted: { id, at }`, and its card in the HTML turns into a ticked box with the comment link. A rerun skips posted items, so a batch stopped by an error resumes where it stopped.

Enabling `anchor` (rclone's shared client cannot call the Docs API and is being retired during 2026):

1. In Google Cloud Console, create a project, enable the Google Drive API and the Google Docs API.
2. Create an OAuth client of type Desktop app. Set the consent screen to Internal for a Workspace account, or publish it to Production; a Testing consent screen expires the refresh token after 7 days.
3. `rclone config update gdrive client_id=<id> client_secret=<secret>`, then `rclone config reconnect gdrive:` and sign in again.
