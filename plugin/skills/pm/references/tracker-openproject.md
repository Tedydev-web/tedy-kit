# OpenProject

This adapter implements the tracker contract in `<plugin>/shared/tracker-contract.md`: the commands, the drafts file, the sidecar and the guarantees every adapter shares. What follows is specific to OpenProject.

`node <plugin>/scripts/openproject.mjs` reads `~/.config/op/config.json` and the map's `tracker.project`; the token never leaves the process. Only the kit's scripts read that file, and every tracker write goes through `openproject.mjs`; when it lacks what the work needs, stop and tell the user instead of calling the API another way. A hook denies any tool call that names the token file or sends a write to the tracker host directly.

## Drafts file

A JSON array, one object per work package:

```json
[{
  "slug": "task-fe-vault-limit-popup",
  "type": "Task",
  "subject": "[FE] Vault limit pop-up on Free",
  "description": "## Goal\n…\n\n## Checklist\n- [ ] …\n\n## AC\n- [ ] …",
  "estimate": 1.5,
  "assignee": "Lâm Trần",
  "startDate": "2026-10-08",
  "dueDate": "2026-10-08",
  "parent": 21270,
  "relates": [21294],
  "blocks": [],
  "status": "In progress"
}]
```

- `slug` is stable across runs: `<type>-<area>-<screen-or-behaviour>`. A slug already in the sidecar map updates that work package instead of creating a twin.
- `merge` adopts an existing work package as the same work, the way `pg-project-management` merges: its subject, status, assignee, history and description stay; only checklist and AC lines it lacks are appended under `## Added <date>`, and the estimate is set only when it has none. A merge draft carries no `status`, and a closed work package is never a merge target. `apply` adds the slug to the sidecar.
- `id` targets an existing work package the sidecar does not know yet, such as one the PM created by hand; `apply` adds its slug to the sidecar only after that update succeeds. Nothing else writes the sidecar, so it is never edited by hand or by a script outside `apply`.
- `parent`, `relates` and `blocks` take ids, or slugs of drafts earlier in the same file.
- `fields` sets custom fields by their OpenProject name; option fields take the option name, or a list for a multi-select. A type can require custom fields, for example a Bug needing `"fields": {"Environment": "Dev", "Module": "<module>", "Expected Result": "…"}`; `preview` reports `Environment can't be blank` when one is missing, so add the fields it names instead of writing to the API another way.
- `estimate` is in hours: the agent's own estimate halved. `startDate` and `dueDate` follow the assignee's queue at 8 hours a day; ask only for the start date of a new story.
- `status` is applied in its own PATCH after the main write. The API token moves a story only up to Ready for QA and a task to Merged, Code Review or Closed.

## Commands

| Command | Writes | What it does |
|---|---|---|
| `get <id> [--relations] [--activities]` | no | One work package by id, with its relations or activities when asked |
| `get <api path>` | no | Any other GET, for example `/api/v3/statuses` |
| `list [--parent <id>] [--assignee <name>] [--status open\|<name>] [--type <name>]` | no | One line per matching work package (id, type, status, assignee, dates, subject), every page; use it instead of hand-built `filters=` |
| `preview <drafts.json>` | no | `task-lint` on every draft, then the `/form` endpoint validates each payload; prints create or update per slug, lint warnings, story warnings (a new story with a UI task and no wire task, or the reverse), glossary drift against the map's `glossary`, the closest existing work package of the same type for each create (`similar HIGH|MID #id score [status]`; HIGH from 0.85, MID from 0.60), what each merge adds, then a `readiness <verdict>` line (`readiness.ready`, `readiness.thin` or `readiness.missing`, worded in the chat language) (descriptions without a BLOCK, estimates on new leaf tasks, blocking open questions; the same thresholds as `pg-project-management`'s `readiness`), the `WRITE →` line, and a `pinned:` line for each Figma file (`figma.com/design/<key>`, with any `node-id`) and Google Doc (`docs.google.com/document/d/<id>`) the drafts link. A HIGH row becomes a `merge` unless the ledger says why it is new work; a MID row is listed in the `approve.header` menu for the user to pick merge, new with `relates`, or drop; a closed match gets a new work package with `relates`, never a merge |
| `set <id> [--status] [--assignee] [--priority] [--estimate] [--start] [--due]` | no | One-line preview of a quick change to one work package: before → after for each named field, the `/form` result, and its lock |
| `set <id> … --apply --lock <n>` | yes | Patches only the named fields; refuses when the work package moved past the previewed lock; reads it back |
| `rollback` | no | Lists the work packages the last `apply` created, with status and last update |
| `rollback --project <id> --apply [--delete]` | yes | Closes them, or deletes them with `--delete`, children first; never touches anything that apply updated or merged; a deleted slug leaves the sidecar |
| `apply <drafts.json> --project <id>` | yes | Refuses unless preview is clean, and when a pinned Figma file or Google Doc changed since the preview: a changed or deleted linked node refuses, a file change elsewhere passes with a notice, a file linked with no node refuses on any change, any Doc text change refuses; creates, updates or merges, adds relations and status, adds new slugs to the sidecar, reads every work package back and prints `verified N/N` |
| `comment <id> --body-file <file>` | no | Preview of one comment on a work package; refuses a comment that is already there; pins every Figma file and Google Doc the body links and prints a `pinned:` line each for the approval `preview` |
| `comment <id> --body-file <file> --apply` | yes | Refuses without that preview, when the body changed since, or when a pinned link changed as `apply` does; posts the comment and reads it back |
| `comment-edit <activity-id> --body-file <file>` | no | Preview of rewriting a comment the token's user posted (activity id from `get <id> --activities`); refuses anyone else's; pins the body's links like `comment` |
| `comment-edit <activity-id> --body-file <file> --apply` | yes | Refuses like `comment --apply`; rewrites it and reads it back |
| `relation <from-id> <to-id> --type <type>` | no | Preview of setting the one relation between two work packages (`relates`, `blocks`, `precedes`, `follows`, `duplicates`, `includes`, `requires`); OpenProject allows only one relation per pair, so an existing one is shown as replaced |
| `relation <from-id> <to-id> --type <type> --apply` | yes | Deletes the pair's old relation, creates the new one and reads it back; if the create is refused (HTTP 422 circular dependency) it recreates the old relation and prints both work packages' relations so the loop can be found |
| `relation-delete <relation-id> [--apply]` | with `--apply` | Removes one relation (id from `get <id> --relations`) and checks it is gone |

Every command that writes stops for the user's approval in an interactive session, through a `permissions.ask` rule or git-gate; a headless run refuses it. With `gates.publishApproval: "answer"` there is no prompt: the script writes only with a ticket from an `approve.all` answer whose `preview` held the exact command line on a line of its own and the text it writes on whole lines (a comment's body, or the `approval lines:` block that `preview <drafts.json>` or `rollback` without `--apply` printed: one `task <slug>` block per draft with its `action create`, `action update #<id>` or `action merge #<id>` line and every field it sends, or one `#<id> <subject>` line per work package it touches), and refuses otherwise. One ticket covers one command, so each write in a batch gets its own question, and `apply` and `rollback --apply` name `--project <id>` on the command line. The sidecar `~/.config/op/sync/<host>__<project>.map.json` is shared with `pg-project-management`: `apply` appends new slug keys and records `_last_apply` (`{ at, created }`) in the same format, so either tool's rollback undoes the latest batch; `_relations`, `_merged` and `_forced_pushes` are never touched.

A quick change ("close #21298", "move it to In progress", "give it to Lâm", "re-estimate to 2 h") goes through `set`, not a drafts file: preview, quote the line in the reply, `AskUserQuestion` `approve.header`, then `--apply --lock <n>`. A wrong batch is undone with `rollback`: preview, `approve.header` naming close or delete, then `--apply`; `--delete` refuses any work package changed after the apply, which can only be closed.
