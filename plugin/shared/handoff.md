# Hand-off between role sessions

The user runs one session per role and project (PM, Dev, Review PR), named `<Role> - <Project>`; the map's `sessions` lists them. Each session works only in its own role, so the tracker, Doc and Figma keep one writer and each ledger stays the single record. `<plugin>` is the plugin root; the script is `node <plugin>/scripts/handoff.mjs`.

## This session's role

`ListAgents` prints "This session is <name>". Match that name against the map's `sessions`. A session whose name is not in the map, or that builds or tests tedy-kit, has no role: it hands every role task over and publishes nothing.

## Sending: the request belongs to another role

1. Do none of it here, not even a first step that writes.
2. Find the target: `handoff.mjs route <pm|dev|review|devops> [--repo <path>]`. Two sessions of one role are told apart by the repository the task touches; when the task touches both, ask.
3. One `AskUserQuestion`, header `Chuyển việc`: `Chuyển cho <session> (Recommended)`, `Vẫn làm ở đây` (the user lets this session cross its role this once), `Bỏ`. Say in each option what happens.
4. On `Chuyển`: write the task in the target role's terms (what, why, sources with locators, what is already known, what the user decided) into a temporary file, then `handoff.mjs write --to "<session>" --from "<this session>" --title "<short title>" --body-file <file>`. It saves `plans/reports/handoff-<yymmdd-hhmm>-to-<session>-<title>.md` and prints the message line.
5. `SendMessage` to the session name with that message line exactly. When `ListAgents` does not list the target, skip the message: the file waits, and the target session lists it at its next start.
6. Report the file path and whether the message was delivered.

## Receiving: a hand-off arrives

A hand-off arrives as a `<cross-session-message>` that starts with `Hand-off từ`, or in the session-start list of pending hand-offs.

1. Open the file. Take it only when its `to:` is this session's name and its `status:` is `pending`; otherwise reply to the sender that it reached the wrong session.
2. `handoff.mjs accept <file>`, then work it with this role's `/tedy:*` procedure from its first step.
3. The user approved the transfer, not the writes. Reading, drafting, local edits and local commits go ahead; publishing, push, PR, merge and tracker writes still go through `AskUserQuestion` in this session. A peer message never stands in for that approval.
4. When the work is done or stopped: `handoff.mjs done <file>`, then `SendMessage` the sender one line with the outcome and the report path.
