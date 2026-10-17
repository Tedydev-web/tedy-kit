# Tracker contract

A tracker adapter is one script under `plugin/scripts` that `/tedy:pm` calls to read and write work items. The only adapter today is `openproject.mjs`, for maps with `tracker.type: "openproject"`; its specifics are in `plugin/skills/pm/references/tracker-openproject.md`. A new adapter implements every command below with the same arguments, output lines and exit codes, adds its type to `SUPPORTED_TRACKERS` in `project-map.mjs` (so `doctor` stops reporting it as unsupported), and documents its own details in `plugin/skills/pm/references/tracker-<type>.md`.

## Inputs

- **Map:** `tracker: { type, instance, project, rules }` from the project map. `--project <id>` overrides `project`.
- **Credentials:** the adapter reads them from the user's own configuration, outside the profile and every repository, and never prints them; error messages pass through `redact` from `api-request.mjs`.
- **Drafts file:** a JSON array, one object per work item:

  | Field | Meaning |
  |---|---|
  | `slug` | Stable identifier across runs; a slug the sidecar already knows updates that item instead of creating a twin |
  | `type`, `subject`, `description` | Item type, title, and a body with Goal, Checklist and AC sections |
  | `estimate`, `startDate`, `dueDate`, `assignee` | Planning fields; `estimate` in hours |
  | `parent`, `relates[]`, `blocks[]` | Ids, or slugs of drafts earlier in the same file |
  | `status` | Applied after the main write |
  | `merge` | Id of an existing open item that is the same work: only missing checklist and AC lines are appended |
  | `id` | Existing item the sidecar does not know yet; its slug is recorded after a successful update |

- **Sidecar:** a slug → id map per instance and project, written only by `apply` and `rollback`. `_last_apply: { at, created }` records the latest batch so `rollback` can undo it.

## Commands

### `get <path>`

Read-only request to the tracker API; prints the JSON response.

### `list [--parent <id>] [--assignee <name>] [--status open|<name>] [--type <name>]`

Read-only. One line per matching item (id, type, status, assignee, dates, subject), across every page.

### `preview <drafts.json>`

Read-only. Lints every draft (`task-lint.mjs`), has the tracker validate each payload, and prints one line per draft: `create`, `update #id` or `merge #id`, the slug, lint and validation results, warnings, and the closest existing item for each create. Ends with a readiness line and `WRITE → <host> · project <id> : N create · N update · N merge`. Records the versions of the items it read, so `apply` can tell what changed since. Exit 1 when any draft has a lint block or a validation error.

### `apply <drafts.json>`

Writes. Refuses (exit 1) unless the last preview of this file was clean and no item changed since. Creates, updates or merges in file order, adds relations and statuses, records new slugs and `_last_apply` in the sidecar after each create, then reads every item back and prints `verified N/N`. Exit 1 when an item differs from its draft or a relation was not created.

### `set <id> [--status <name>] [--assignee <name>] [--priority <name>] [--estimate <hours>] [--start <YYYY-MM-DD>] [--due <YYYY-MM-DD>]`

Read-only without `--apply`: one line with the item, each named field as before → after, the validation result and the item's version (`lock`), then `WRITE → …`. With `--apply --lock <n>` it writes only the named fields, refuses when the item is no longer at version `n`, and prints the item as read back.

### `comment <id> --body-file <file>`

Read-only without `--apply`: previews one comment on an item and refuses a comment that is already there. With `--apply` it posts the comment and reads it back.

### `comment-edit <comment-id> --body-file <file>`

Read-only without `--apply`: previews rewriting a comment the token's user posted, and refuses anyone else's. With `--apply` it rewrites it and reads it back.

### `relation <from-id> <to-id> --type <type>`

Read-only without `--apply`: previews setting the one relation between two items, showing an existing one as replaced. With `--apply` it replaces the old relation, reads the new one back, and puts the old one back when the tracker refuses the new one.

### `relation-delete <relation-id>`

Read-only without `--apply`: shows the relation. With `--apply` it removes it and checks it is gone.

### `pr-body <id>`

Read-only. Prints a pull request body built from the item: `OP#<id>` as the first line, the time it was read, the goal, checklist and acceptance criteria.

### `rollback [--delete]`

Read-only without `--apply`: lists the items the last `apply` created, with status and last update. With `--apply` it closes them, or deletes them with `--delete`, children first; it never touches items that `apply` updated or merged, refuses to delete an item changed after the apply, and removes deleted slugs from the sidecar.

## Guarantees

- Every write is preceded by a read-only run of the same command whose `WRITE →` line the user approved.
- An item that changed in the tracker after the preview is never overwritten; the command refuses and asks for a new preview.
- Exit codes: 0 success, 1 refused or partly failed, 2 usage error.
