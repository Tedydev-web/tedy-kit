# Project map schema

One file per project, `<profile>/projects/<name>.md` (profile layout: `plugin/shared/profile-layout.md`): a short note for people, then exactly one ```json block that `plugin/scripts/project-map.mjs` parses. `/tedy:setup` writes and updates maps; the user answers questions and never edits a map by hand.

A folder named like the map, `<profile>/projects/<name>/`, holds optional notes too long for the map: `review-calibration.md` is how the project's stack really works, read by `/tedy:review-pr` and the `reviewer` agent.

A map keeps only what cannot be looked up. Repository remotes, default branches, stacks and package scripts come from the repositories each run, because a copy here goes stale.

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Same as the file name without `.md` |
| `paths` | yes | Absolute workspace paths; a session whose cwd starts with one of them uses this map, longest prefix first |
| `repos[]` | yes | `{ path, role, branch?, readonly? }`. `path` is relative to `paths[0]`. `role` is free text: `FE`, `BE`, `contract` (smart contracts or shared schemas such as proto), `admin-FE`, `admin-BE` and `prototype` keep their place on the truth ladder (`reconcile-flow.md`); any other word, such as `engine`, `infra` or `docs`, is read as code with no rank of its own. `branch` is the integration branch when it is not `origin/HEAD`. `readonly: true` means read and propose, never edit |
| `language` | yes (`pr_review`) | `{ pr_review, pr_body, tracker, doc_figma }`, each `vi` or `en` |
| `prd` | no | The written spec. Google Doc: `{ doc, tabs: { "<epic nn>": { tab, title, uc } } }`, one tab per epic, `uc` the use case prefix such as `UC_SW`. Markdown in a repository: `{ files: ["<path relative to paths[0]>"] }`, where a directory stands for every `.md` file under it, so a project whose spec is its ADRs and architecture docs lists their folder. `false` records that the project has no written spec; no skill asks for one again |
| `figma` | no | `{ file, nodes: { "<epic nn>": [{ node, label }] } }`; `label` is the name visible on screen. `false` records that the project has no Figma; no skill asks for a node again |
| `demo` | no | `[{ url, covers }]`: PM demo pages used as a third reference |
| `verify_gotchas` | no | Traps the config does not reveal, one sentence each |
| `tracker` | no | `{ type, instance, project, rules: [], flow?, not_started?, merge_status?, open_status?, revert_status? }`. `flow` maps a work package type to `{ start, review, merged, revert, by_role? }`: the status when work begins, while a PR into the integration branch is open, once every linked PR merged, and after a revert; `by_role: { "<OP role of the author>": { merged, assign: "author" } }` overrides `merged` and hands the package back to its author, such as `{ "Tester": { "merged": "Fixed (Dev Done)", "assign": "author" } }`. `op-status.mjs` and `merged-sweep.mjs` read it (`plugin/shared/status-flow.md`); a map without `flow` falls back to the three fields below. `merge_status` maps a work package type to the status it takes once its PR is merged, such as `{ "Task": "Merged/Code Review", "Bug": "Fixed (Dev Done)" }`; `merged-sweep.mjs` reads it and only touches the user's own work packages. `open_status` (same shape) is proposed when the user's PR opens and the package is still in one of the `not_started` statuses; `revert_status` (same shape) when a merged PR titled `Revert …` links it |
| `truth_overrides` | no | Sentences that change the default truth order, each with its date and source |
| `team` | no | `{ "<area>": "<person>" }` assignment split |
| `open_questions[]` | no | `{ q, tried }`: what is unknown and what was already searched |
| `glossary` | no | `{ "<preferred term>": ["<term to avoid>", …] }`: one concept, one word in tracker tasks. `task-lint` and `openproject.mjs preview` warn on an avoided term in a subject or description, outside code spans, quoted copy and `{placeholders}` |

Each role skill runs inline in the session the user types into; no key changes that. A map an older kit wrote may still hold `sessions` or `jobs`: both are ignored, and `project-map.mjs doctor` names them in one `warn` line.

## Runtime state

Times that change on every run stay out of the map, so a profile kept in git does not churn. `node <plugin>/scripts/project-state.mjs get|set <field> [<value>]` keeps them in `$TEDY_STATE_DIR/projects/<name>.json` (default `~/.local/state/tedy`), finding the map from the working directory or `--map <name>`. `project-state.mjs migrate` copies them once from maps that still carry them.

| Field | Meaning |
|---|---|
| `last_reply_check` | ISO timestamp of the last reply sweep by `/tedy:pm` |
