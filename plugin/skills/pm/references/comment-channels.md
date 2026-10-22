# Comment channels

Every write below prints a `WRITE →` line, lints the body first, and reads the result back. In an interactive session it stops for the user's approval: with `gates.publishApproval: "ask"` a `permissions.ask` rule matches it, or git-gate asks when no rule does; with `"answer"` the script writes only with a ticket from an `approve.all` answer whose `preview` held the body on whole lines and the exact command line on a line of its own, one ticket per command, and refuses otherwise. In `"answer"` mode a write names its target on the command line, so the approval shows it: `--file <key>` for `figma-comments.mjs`, `--doc <id>` for `gdoc-comments.mjs` and for `doc-comment-file.mjs post … --apply` (the map's PRD doc). A headless `claude -p` run cannot be approved, so the write is refused. Bodies live in files so the draft the user approved is the text that is posted.

## Pinned sources

A clean `draft-lint.mjs figma-comment <file>` pins the map's Figma file at its current version; a clean `doc-comment <file>` pins the SHA-256 of the PRD Doc's text across all tabs, read through the Docs API without suggestions; comments and other metadata do not move it. A Doc the Docs API cannot read (no own OAuth client, or no access) gives no pin, so the lint fails and the write refuses. `doc-comment-file.mjs <items.json>` pins the Doc the same way when it writes the HTML file. Each prints a `pinned:` line; it goes into the approval `preview`. Every write below refuses a body with no pin or edited since its lint, and rechecks before writing:

- Figma `post` and `reply`: an unchanged version posts. A changed version compares the commented node (the reply's root node) at the pinned and the latest version: same subtree, `notice: …` and it posts; changed, gone, or no node to compare, `refused: …`.
- Doc `reply`, `anchor` and `edit`: any change to the Doc's text refuses, because no anchor-level diff exists.
- `doc-comment-file.mjs post --apply`: changed Doc text only prints a notice, because the same run re-finds every highlighted passage exactly once before anchoring.

On `refused`: re-read the node or the Doc, fix the draft, lint, and ask again.

## Figma

`node <plugin>/scripts/figma-comments.mjs` with the map's `figma.file`, passed as `--file <key>` on every write; token from `~/.config/figma/token`.

- `list [--since <ISO>]`: threads with replies, newest activity first in each thread.
- `post <node-id> --body-file <f> --file <key>`: pins the comment on the node at half its width and three quarters of its height.
- `reply <comment-id> --body-file <f> --file <key>`: only on a root comment; the API rejects replies to replies.
- `delete <comment-id> --file <key>`: only comments made by the token's own account, for reposting after a restyle. Answered threads are never reposted.
- There is no edit and no resolve endpoint; resolving stays with the user.
- HTTP 429 carries `Retry-After`; the client waits it out up to three times. Comments sit in rate-limit tier 2: 5 per minute on View or Collab seats, 25 to 100 per minute on Dev or Full seats.

## Google Doc (PRD)

`node <plugin>/scripts/gdoc-comments.mjs` with the map's `prd.doc`, passed as `--doc <id>` on every write; the token comes from the `gdrive` rclone remote.

- `list [--since <ISO>]`: comments with their replies and quoted text.
- `reply <comment-id> --body-file <f> --doc <id>`: a reply in that thread, only when it is on the thread's topic. A reply placed under an unrelated thread hides the question from the PM; on 2026-10-07 nine such replies had to be re-anchored.
- `anchor --tab <t.id> --quote "<exact text>" --body-file <f> --doc <id>`: a new question anchored on the passage it is about, through the Docs API. The quote must appear exactly once in the tab.
- `edit <comment-id> [--reply <reply-id>] --body-file <f> --doc <id>`: rewrites a comment or reply this account posted, then reads it back. Use it instead of stacking a second reply when the user's own reply needs a change; text by anyone else is refused.
- `delete <comment-id> [--reply <reply-id>] --doc <id>`: removes a comment or reply this account posted, for a reply placed in the wrong thread; a thread that holds someone else's reply is refused.
- `changed [--since <ISO>]`: the Doc's last edit time and editor; the revision list needs reader access to revisions, which a comment-only account lacks.
- `export [--out <f>]`: the whole PRD as plain text through the same token, with the 429 retry. Use it instead of a hand-built Drive export.

A new PRD question is never posted as a reply under another thread. It goes into an HTML file that stays as the record; the agent then posts it anchored on the highlighted passage once the user approves the batch, and ticks each card in the same file. Without an own OAuth client (below) the user posts from the file by hand: highlight the passage, then comment.

1. Write an items file: `{ "title": "<scope>", "items": [{ "group": "A|B", "epic": "<map prd.tabs key>", "where": "<UC and locator>", "quote": "<exact passage to highlight>", "comment": "<comment text>", "note": "<optional: status or affected task>" }] }`. Group A holds new questions. Group B holds a decision the PM gave in a comment that the PRD text does not yet say, or a passage where the PRD contradicts itself; its comment asks the PM to write the decision into the PRD. The comment is the business text the PM reads (the `doc-figma-comment.md` that `profile.mjs path` printed in step 1, "Who reads it"); `note` holds the technical reason for the user and is shown on the card, never posted. The script refuses build words such as BE, FE, API, contract or a version in the comment, more than three PRD places in one comment, and arrows.
2. `node <plugin>/scripts/doc-comment-file.mjs <items.json>` from the project. It downloads the latest PRD tabs, and writes nothing unless every passage appears exactly once the way Ctrl+F finds it (case-insensitive, inside one paragraph) and every comment passes the Doc lint. On success it prints `plans/drafts/pm-comments-<yymmdd-hhmm>-<slug>.html`.
3. Run it again right before handing the file over whenever the PRD may have changed since, so the check matches the PRD the user will search.
4. `node <plugin>/scripts/doc-comment-file.mjs post <items.json> --html <that html>` prints the `approval lines:` block (each pending item's EPIC, tab and place, its `quote:` line and its comment) and the WRITE line. Show the user the cards and ask for `approve.header`, the `approve.all` `preview` holding that block verbatim and the same command with `--apply --doc <the map's prd.doc>` on a line of its own; on approval run that command. Each item is anchored, read back, recorded in the items file as `posted: { id, at }`, and its card in the HTML turns into a ticked box with the comment link. A rerun skips posted items, so a batch stopped by an error resumes where it stopped.

Enabling `anchor` (rclone's shared client cannot call the Docs API and is being retired during 2026):

1. In Google Cloud Console, create a project, enable the Google Drive API and the Google Docs API.
2. Create an OAuth client of type Desktop app. Set the consent screen to Internal for a Workspace account, or publish it to Production; a Testing consent screen expires the refresh token after 7 days.
3. `rclone config update gdrive client_id=<id> client_secret=<secret>`, then `rclone config reconnect gdrive:` and sign in again.
