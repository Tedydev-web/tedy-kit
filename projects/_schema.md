# Project map schema

One file per project, `projects/<name>.md`: a short note for people, then exactly one ```json block that `plugin/scripts/project-map.mjs` parses. `/tedy:setup` writes and updates maps; the user answers questions and never edits a map by hand.

A folder named like the map, `projects/<name>/`, holds optional notes too long for the map: `review-calibration.md` is how the project's stack really works, read by `/tedy:review-pr` and the `reviewer` agent.

A map keeps only what cannot be looked up. Repository remotes, default branches, stacks and package scripts come from the repositories each run, because a copy here goes stale.

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Same as the file name without `.md` |
| `paths` | yes | Absolute workspace paths; a session whose cwd starts with one of them uses this map, longest prefix first |
| `repos[]` | yes | `{ path, role, branch?, readonly? }`. `path` is relative to `paths[0]`. `role` is `FE`, `BE`, `contract`, `admin-FE`, `admin-BE` or `prototype`. `branch` is the integration branch when it is not `origin/HEAD`. `readonly: true` means read and propose, never edit |
| `language` | yes (`pr_review`) | `{ pr_review, pr_body, tracker, doc_figma }`, each `vi` or `en` |
| `prd` | no | Google Doc: `{ doc, tabs: { "<epic nn>": { tab, title, uc } } }`, one tab per epic, `uc` the use case prefix such as `UC_SW`. Markdown in a repository: `{ files: ["<path relative to paths[0]>"] }` |
| `figma` | no | `{ file, nodes: { "<epic nn>": [{ node, label }] } }`; `label` is the name visible on screen |
| `demo` | no | `[{ url, covers }]`: PM demo pages used as a third reference |
| `verify_gotchas` | no | Traps the config does not reveal, one sentence each |
| `tracker` | no | `{ type, instance, project, rules: [], merge_status? }`. `merge_status` maps a work package type to the status it takes once its PR is merged, such as `{ "Task": "Merged/Code Review", "Bug": "Fixed (Dev Done)" }`; `merged-sweep.mjs` reads it and only touches the user's own work packages |
| `truth_overrides` | no | Sentences that change the default truth order, each with its date and source |
| `team` | no | `{ "<area>": "<person>" }` assignment split |
| `learned_until` | no | Date up to which `/tedy:learn` has folded corrections in |
| `last_reply_check` | no | ISO timestamp of the last reply sweep |
| `open_questions[]` | no | `{ q, tried }`: what is unknown and what was already searched |
| `sessions[]` | no | `{ name, role, repos? }`: the user's session per role, `name` exactly as `ListAgents` prints it, `role` one of `pm`, `dev`, `review`, `devops`, `repos` the repositories it owns when one role has several sessions. Hand-offs route through it (`plugin/shared/handoff.md`), and `role-gate.mjs` asks the user before a session writes for another role: tracker, Doc and Figma belong to `pm`, posted PR review comments to `review`, product code and its commits to `dev` (`devops` may change code too) |
| `glossary` | no | `{ "<preferred term>": ["<term to avoid>", …] }`: one concept, one word in tracker tasks. `task-lint` and `openproject.mjs preview` warn on an avoided term in a subject or description, outside code spans, quoted copy and `{placeholders}` |
