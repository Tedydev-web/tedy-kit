# Project map schema

One file per project, `projects/<name>.md`: a short note for people, then exactly one ```json block that `plugin/scripts/project-map.mjs` parses. `/tedy:setup` writes and updates maps; the user answers questions and never edits a map by hand.

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
| `tracker` | no | `{ type, instance, project, rules: [] }` |
| `truth_overrides` | no | Sentences that change the default truth order, each with its date and source |
| `team` | no | `{ "<area>": "<person>" }` assignment split |
| `learned_until` | no | Date up to which `/tedy:learn` has folded corrections in |
| `last_reply_check` | no | ISO timestamp of the last reply sweep |
| `open_questions[]` | no | `{ q, tried }`: what is unknown and what was already searched |
