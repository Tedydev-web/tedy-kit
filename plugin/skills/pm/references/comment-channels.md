# Comment channels

Every write below prints a `WRITE →` line, lints the body first, and reads the result back. In an interactive session it stops for the user's approval: with `gates.publishApproval: "ask"` a `permissions.ask` rule matches it, or git-gate asks when no rule does; with `"answer"` the script writes only with a ticket from an `approve.all` answer whose `preview` held the body on whole lines and the exact command line on a line of its own, one ticket per command, and refuses otherwise. In `"answer"` mode a write names its target on the command line, so the approval shows it: `--file <key>` for `figma-comments.mjs`, `--doc <id>` for `gdoc-comments.mjs` and for `doc-comment-file.mjs post … --apply` (the map's PRD doc). A headless `claude -p` run cannot be approved, so the write is refused. Bodies live in files so the draft the user approved is the text that is posted.

## Pinned sources

Before reading the PRD, Figma or code for a scope, `draft-lint.mjs pin-sources <ledger> --doc <id> --file <key> --node <node-id>,…` records the tip of every map repo, the Doc's text and each named frame's hash as they are at the start of the read (`--file` needs `--node`). Write each draft after that read: a read pin newer than the draft refuses its lint. Every lint below then takes `--pinned-at <ledger>`: it keeps the read pins of what it pins itself (every repo, plus the Doc and frames it targets or links), so a frame or Doc it cites that changed during the read fails the lint (`run draft-lint.mjs pin-sources <ledger> again, re-read what changed, …`), while a change to a frame or Doc it does not cite does not; a frame or Doc the read pins lack is pinned at lint with a `warning:`, and so is everything when there are no read pins.

Lint every body before its approval, naming the target as the write will:

- `draft-lint.mjs figma-comment <file> --file <key> --node <node-id>`: `--node` is the node the comment goes on, or the thread's node from `list` for a reply. It pins the hash of that node's live JSON and the file's `lastModified`. Without `--node` it pins the whole file, which any edit to it moves, and prints a `warning:`.
- `draft-lint.mjs doc-comment <file> --doc <id>`: pins the SHA-256 of the Doc's text, across all tabs and child tabs through the Docs API without suggestions (`via docs-text`, own OAuth client), else from the Drive `text/plain` export with its comment markers and the comment lines the Drive comments API lists removed (`via drive-export`); the recheck reads the same way. A Doc neither way can read gives no pin, so the lint fails and the write refuses.
- `doc-comment-file.mjs <items.json>` pins the PRD Doc the same way, and the links in every card's comment, when it writes the HTML file.

Every lint also pins the map's repos and the Figma and Doc links in its text; a published `/document/d/e/…/pub` link fails the lint. Each pin prints a `pinned:` line ending in `(read <time>)` or `(at lint)`; the `pinned:`, `warning:` and `notice:` lines all go into the approval `preview`, so the user sees what was pinned late. Every write below refuses a body with no sources record, an unreadable one, or one edited since its lint, and rechecks every pin before it spends the approval:

- Figma `post` and `reply`: the target node must be pinned (or the whole file). A changed or deleted node refuses; a moved `lastModified` with every pinned node unchanged posts with a `notice:`; a whole-file pin refuses on any change. A comment is not part of the node JSON, so a batch of replies does not refuse itself.
- Doc `reply`, `anchor` and `edit`: any change to the Doc's text refuses, because no anchor-level diff exists.
- `doc-comment-file.mjs post --apply`: any change to the Doc's text refuses, as for every Doc writer; run `doc-comment-file.mjs <items.json>` again, check the cards, and ask again. It marks each posted item in the items file, so a run that stopped partway needs `doc-comment-file.mjs <items.json>` again and a new approval for the rest.

On `refused`: re-read the node or the Doc, fix the draft, lint, and ask again.

## Figma

`node <plugin>/scripts/figma-comments.mjs` with the map's `figma.file`, passed as `--file <key>` on every write; token from `~/.config/figma/token`.

- `list [--since <ISO>]`: threads with replies, newest activity first in each thread.
- `post <node-id> --body-file <f> --file <key>`: pins the comment on the node at half its width and three quarters of its height.
- `reply <comment-id> --body-file <f> --file <key>`: only on a root comment; the API rejects replies to replies.
- `delete <comment-id> --file <key>`: only comments made by the token's own account, for reposting after a restyle. Answered threads are never reposted.
- There is no edit and no resolve endpoint; resolving stays with the user.
- HTTP 429 carries `Retry-After`; the client does not wait: the command refuses with that wait and nothing more is sent, so run it again later. A run reads `/nodes` once per file. Comments sit in rate-limit tier 2: 5 per minute on View or Collab seats, 25 to 100 per minute on Dev or Full seats.

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
2. `node <plugin>/scripts/doc-comment-file.mjs <items.json> --pinned-at <ledger>` from the project; a change since the read pin to the Doc, or to a frame a card links, fails it. It downloads the latest PRD tabs, and writes nothing unless every passage appears exactly once the way Ctrl+F finds it (case-insensitive, inside one paragraph) and every comment passes the Doc lint. On success it prints `plans/drafts/pm-comments-<yymmdd-hhmm>-<slug>.html`.
3. Run it again right before handing the file over whenever the PRD may have changed since, so the check matches the PRD the user will search.
4. `node <plugin>/scripts/doc-comment-file.mjs post <items.json> --html <that html>` prints the `approval lines:` block (each pending item's EPIC, tab and place, its `quote:` line and its comment), the WRITE line and the `warning:` lines step 2 recorded. Show the user the cards and ask for `approve.header`, the `approve.all` `preview` holding that block and those `warning:` lines verbatim and the same command with `--apply --doc <the map's prd.doc>` on a line of its own; on approval run that command. Each item is anchored, read back, recorded in the items file as `posted: { id, at }`, and its card in the HTML turns into a ticked box with the comment link. Recording a post changes the items file, so a batch stopped by an error needs step 2 again and a new approval; that run and the next `post` skip the items already posted.

Enabling `anchor` (rclone's shared client cannot call the Docs API and is being retired during 2026):

1. In Google Cloud Console, create a project, enable the Google Drive API and the Google Docs API.
2. Create an OAuth client of type Desktop app. Set the consent screen to Internal for a Workspace account, or publish it to Production; a Testing consent screen expires the refresh token after 7 days.
3. `rclone config update gdrive client_id=<id> client_secret=<secret>`, then `rclone config reconnect gdrive:` and sign in again.
