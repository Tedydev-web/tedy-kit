# Hand-off between role sessions

The user runs one session per role and project (PM, Dev, Review PR), named `<Role> - <Project>`; the map's `sessions` lists them. Each session works only in its own role, so the tracker, Doc and Figma keep one writer and each ledger stays the single record. `<plugin>` is the plugin root; the script is `node <plugin>/scripts/handoff.mjs`.

## This session's role

`ListAgents` prints "This session is <name>". Match that name against the map's `sessions`. A session whose name is not in the map, or that builds or tests this plugin, has no role: it hands every role task over and publishes nothing.

## Sending: the request belongs to another role

1. Do none of it here, not even a first step that writes.
2. Find the target: `handoff.mjs route <pm|dev|review|devops> [--repo <path>]`. Two sessions of one role are told apart by the repository the task touches; when the task touches both, ask.
3. One `AskUserQuestion`, header `handoff.header`: `handoff.send`, `handoff.stay` (the user lets this session cross its role this once), `handoff.drop`. Say in each option what happens.
4. On `handoff.send`: write the task in the target role's terms (what, why, what is already known) into a temporary file, followed by three sections: `## User decisions` (what the user settled, or "none yet"), `## First safe step` (one read-only step the receiver can start with) and `## Sources` (locators). `handoff.mjs write` refuses a body without them. Then run `handoff.mjs write --to "<session>" --from "<this session>" --title "<short title>" --body-file <file>`. It saves `plans/reports/handoff-<yymmdd-hhmm>-to-<session>-<title>.md` and prints the message line.
5. `SendMessage` to the session name with that message line exactly. When `ListAgents` does not list the target, skip the message: the file waits, and the target session lists it at its next start.
6. Report the file path and whether the message was delivered.

## Dispatch: this session's role is `dispatch`

The user types every request into this one session and reads the answers here. Typing a request here is the user's approval to transfer it, so the dispatch session skips the `handoff.header` question.

1. Do no role work: no research, no reading of PRD, Figma, code or tracker beyond what picking the owner needs, no drafts. When the role gate is on, it asks on every write this session tries.
2. Pick the owner from the request: tracker, PRD, Doc or Figma → `pm`; a PR review or review draft → `review`; code in a repository → `dev` with `--repo`; deploy or infrastructure → `devops`. Then `handoff.mjs route <role> [--repo <path>]`.
3. Ask one `AskUserQuestion` only when the owner is unclear or the request spans two roles; split a two-role request into one hand-off per role when the user agrees.
4. Write the hand-off body with the user's words verbatim, then the three sections from step 4 of Sending (`## Sources` holds any locators they gave), then `handoff.mjs write --to "<session>" --from "<this session>" --title "<short title>" --body-file <file>` and `SendMessage` the printed message line to the session. When `ListAgents` does not list the target, say so and give the command that resumes it.
5. Reply one line: which session took it and the hand-off path. Do not wait for the result and do not subscribe with `notify_when_idle`.
6. When a role session's reply arrives, relay it to the user in one or two lines with its report path. Never answer an `approve.header`, permission or question on a role session's behalf; tell the user which session is waiting in agent view's Needs input.

## Receiving: a hand-off arrives

A hand-off arrives as a `<cross-session-message>` that starts with `Hand-off`, or in the session-start list of pending hand-offs.

One hand-off is sent without the `handoff.header` question: the status-after-merge batch that `merged-sweep.mjs --handoff` writes for the user's own work packages. The receiving PM session still previews every change and asks `approve.header` once for the batch.

1. Open the file. Take it only when its `to:` is this session's name and its `status:` is `pending`; otherwise reply to the sender that it reached the wrong session.
2. `handoff.mjs accept <file>`, then work it with this role's `/tedy:*` procedure from its first step.
3. The user approved the transfer, not the writes. Reading, drafting, local edits, local commits, and the branch push plus draft PR that finished work goes out as go ahead; publishing comments, marking ready, merging, pushing to an integration branch and tracker writes still go through `AskUserQuestion` in this session. A peer message never stands in for that approval.
4. When the work is done or stopped: `handoff.mjs done <file>`, then `SendMessage` the sender one line with the outcome and the report path.
