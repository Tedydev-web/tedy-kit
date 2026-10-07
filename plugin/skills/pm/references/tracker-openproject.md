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
- `id` targets an existing work package the sidecar does not know yet, such as one the PM created by hand; `apply` adds its slug to the sidecar only after that update succeeds. Nothing else writes the sidecar, so it is never edited by hand or by a script outside `apply`.
- `parent`, `relates` and `blocks` take ids, or slugs of drafts earlier in the same file.
- `estimate` is in hours: the agent's own estimate halved. `startDate` and `dueDate` follow the assignee's queue at 8 hours a day; ask only for the start date of a new story.
- `status` is applied in its own PATCH after the main write. The API token moves a story only up to Ready for QA and a task to Merged, Code Review or Closed.

## Commands

| Command | Writes | What it does |
|---|---|---|
| `get <api path>` | no | Any GET, for example `/api/v3/work_packages/21298` |
| `preview <drafts.json>` | no | `task-lint` on every draft, then the `/form` endpoint validates each payload; prints create or update per slug, lint warnings, the closest existing work package of the same type (`similar #id score`, from 0.60) for each create, and the `WRITE →` line. A `similar` row is linked or updated instead, or the ledger says why it is new |
| `apply <drafts.json>` | yes | Refuses unless preview is clean; creates or updates, adds relations and status, adds new slugs to the sidecar, reads every work package back and prints `verified N/N` |

`apply` triggers the permission prompt. The sidecar `~/.config/op/sync/<host>__<project>.map.json` is shared with `pg-project-management`: `apply` only appends new slug keys in the same format and never touches `_relations`, `_merged`, `_last_apply` or `_forced_pushes`.

A wrong creation is undone by the user in OpenProject; the script deletes nothing.
