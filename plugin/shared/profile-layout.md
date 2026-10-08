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
  reports/               /tedy:learn reports
```

A file at `<profile>/style/<name>.md` overrides `plugin/shared/style/<name>.md`. Skills read style samples through `node <plugin>/scripts/profile.mjs path style/<name>.md`, which prints the profile copy when it exists and the engine copy otherwise.

Runtime state (gate log, edit log, draft snapshots, last check times) lives in `TEDY_STATE_DIR`, default `~/.local/state/tedy`, never in the profile, so a profile kept in git does not churn.

## config.json

| Key | Type | Default | Meaning |
|---|---|---|---|
| `gates.noComments` | boolean | `false` | Block edits that add code comments; report comments a push carries |
| `gates.draftPrOnly` | boolean | `false` | Refuse a pull request that is not a draft |
| `gates.roleGate` | boolean | `false` | Ask before a session writes for another role in the project map's `sessions` |
| `gates.ghWrites` | boolean | `false` | Block direct `gh` writes (merge, close, edit, comment, API POST) so everything published to GitHub goes through `github-write.mjs` after the user approves the draft |
| `gates.pushExempt` | string[] | `[]` | Repositories whose pushes to an integration branch need no prompt; `~/` expands to the home directory |
| `language.chat` | string | `"en"` | Language of replies and question labels |

Gates that protect every user stay on regardless of the config: a prompt before a push to an integration branch, and before a push that rewrites history.

An unknown key or a value of the wrong type is an error that names the file and the field; the engine never falls back to defaults on a broken config.
