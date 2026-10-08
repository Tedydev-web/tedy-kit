# OpenProject

`node <plugin>/scripts/openproject.mjs` reads `~/.config/op/config.json` and the map's `tracker.project`; the token never leaves the process.

## Drafts file

A JSON array, one object per work package:

```json
[{
  "slug": "task-fe-vault-limit-popup",
  "type": "Task",
  "subject": "[FE] Vault limit pop-up on Free",
  "description": "## Goal\n…\n\n## Checklist\n- [ ] …\n\n## AC\n- [ ] …",
  "estimate": 1.5,
  "assignee": "Hieu Dat",
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
- `estimate` is in hours: the agent's own estimate halved. `startDate` and `dueDate` follow the assignee's queue at 8 hours a day; ask only for the start date of a new story.
- `status` is applied in its own PATCH after the main write. The API token moves a story only up to Ready for QA and a task to Merged, Code Review or Closed.

## Commands

| Command | Writes | What it does |
|---|---|---|
| `get <api path>` | no | Any GET, for example `/api/v3/work_packages/21298` |
| `preview <drafts.json>` | no | `task-lint` on every draft, then the `/form` endpoint validates each payload; prints create or update per slug, lint warnings, story warnings (a new story with a UI task and no wire task, or the reverse), glossary drift against the map's `glossary`, the closest existing work package of the same type for each create (`similar HIGH|MID #id score [status]`; HIGH from 0.85, MID from 0.60), what each merge adds, then a `readiness đủ|mỏng|thiếu nặng` line (descriptions without a BLOCK, estimates on new leaf tasks, blocking open questions; the same thresholds as `pg-project-management`'s `readiness`) and the `WRITE →` line. A HIGH row becomes a `merge` unless the ledger says why it is new work; a MID row is listed in the `Duyệt` menu for the user to pick merge, new with `relates`, or drop; a closed match gets a new work package with `relates`, never a merge |
| `set <id> [--status] [--assignee] [--priority] [--estimate]` | no | One-line preview of a quick change to one work package: before → after for each named field, the `/form` result, and its lock |
| `set <id> … --apply --lock <n>` | yes | Patches only the named fields; refuses when the work package moved past the previewed lock; reads it back |
| `rollback` | no | Lists the work packages the last `apply` created, with status and last update |
| `rollback --apply [--delete]` | yes | Closes them, or deletes them with `--delete`, children first; never touches anything that apply updated or merged; a deleted slug leaves the sidecar |
| `apply <drafts.json>` | yes | Refuses unless preview is clean; creates, updates or merges, adds relations and status, adds new slugs to the sidecar, reads every work package back and prints `verified N/N` |

Every command that writes triggers the permission prompt. The sidecar `~/.config/op/sync/<host>__<project>.map.json` is shared with `pg-project-management`: `apply` appends new slug keys and records `_last_apply` (`{ at, created }`) in the same format, so either tool's rollback undoes the latest batch; `_relations`, `_merged` and `_forced_pushes` are never touched.

A quick change ("close #21298", "move it to In progress", "give it to Phúc", "re-estimate to 2 h") goes through `set`, not a drafts file: preview, quote the line in the reply, `AskUserQuestion` `Duyệt`, then `--apply --lock <n>`. A wrong batch is undone with `rollback`: preview, `Duyệt` naming close or delete, then `--apply`; `--delete` refuses any work package changed after the apply, which can only be closed.
