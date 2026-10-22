# Profile layout

The engine (this plugin) holds no personal or project data. Everything that belongs to one user lives in their profile directory: `TEDY_PROFILE_DIR` when set (put it in the `env` block of `~/.claude/settings.json` so hooks and Bash both see it), otherwise `~/.config/tedy`. `node <plugin>/scripts/profile.mjs init` creates a starting profile and never overwrites a file; `profile.mjs doctor` reports what the engine will read.

```
<profile>/
  config.json            gate switches and chat language; optional, defaults below
  rules.md               always-on rules, imported from ~/.claude/CLAUDE.md
  style/<name>.md        overrides plugin/shared/style/<name>.md
  projects/<name>.md     project maps (fields in plugin/shared/project-map-schema.md)
  projects/<name>/       notes too long for a map, such as review-calibration.md
  public-denylist.txt    terms public-scan.mjs must never find in a public repository
  release-tag            the tag a linked-worktree plugin install must sit on; profile.mjs doctor checks it
  reports/               /tedy:learn reports
  docs/                  your own guides, such as a user guide naming your projects and sessions
```

A file at `<profile>/style/<name>.md` overrides `plugin/shared/style/<name>.md`. Skills read style samples through `node <plugin>/scripts/profile.mjs path style/<name>.md`, which prints the profile copy when it exists and the engine copy otherwise.

Runtime state (gate log, edit log, draft snapshots, last check times) lives in `TEDY_STATE_DIR`, default `~/.local/state/tedy`, never in the profile, so a profile kept in git does not churn.

## config.json

| Key | Type | Default | Meaning |
|---|---|---|---|
| `gates.noComments` | boolean | `false` | Block edits that add code comments; report comments a push carries |
| `gates.draftPrOnly` | boolean | `false` | Refuse a pull request that is not a draft |
| `gates.roleGate` | boolean | `false` | Ask before a session writes for another role in the project map's `sessions` |
| `gates.publishQuote` | boolean | `false` | Refuse a `github-write.mjs` post, reply or edit until the exact body was quoted to the user after its last change |
| `gates.ghWrites` | boolean | `false` | Block direct `gh` writes (close, edit, comment, API POST) so everything published to GitHub goes through `github-write.mjs` after the user approves the draft |
| `gates.publishApproval` | `"ask"` or `"answer"` | `"ask"` | How a kit-script publish is approved after the skill's menu: `"ask"` keeps the `permissions.ask` prompt; `"answer"` lets git-gate allow it only after an approving AskUserQuestion answer whose preview holds the exact body or command. Switch with `profile.mjs publish-approval answer\|ask`, which also removes or restores the kit's ask rules in `~/.claude/settings.json` |
| `gates.pushExempt` | string[] | `[]` | Repositories whose pushes to an integration branch need no prompt; `~/` expands to the home directory |
| `language.chat` | string | `"en"` | Language of replies and question labels, and of the comment rules in a directory no project map covers |

Gates that protect every user stay on regardless of the config:
- a prompt before a push to an integration branch, before a push that rewrites history, and before `gh pr merge`, `gh pr ready` or the equivalent `gh api` calls;
- in a project whose map has a `tracker`, a refusal of `gh pr create` without `OP#<id>` in the body;
- a prompt before a `node <script>` publish that no `permissions.ask` rule covers, or in `"answer"` mode a refusal of one with no approving answer;
- the tracker token gate and the profile guard.

A profile directory that has `rules.md` but no `config.json` turns every personal gate on.

An unknown key or a value of the wrong type is an error that names the file and the field; the engine never falls back to defaults on a broken config.
