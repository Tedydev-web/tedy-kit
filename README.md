# tedy-kit engine

A Claude Code plugin (`tedy`) for pull request review, development and project management that keeps every write behind a draft the user approves. It reconciles a scope across the PRD, the design, the backend, the contract and the frontend; drafts review comments, tracker items and Doc or Figma comments in the user's style and language; and adds hooks that stop the agent from publishing, pushing to an integration branch or crossing into another role's work without asking.

The plugin holds no personal or project data. Everything that belongs to one user (rules, writing samples, project maps, gate switches) lives in their profile directory, which the plugin reads.

## Requirements

- Claude Code with plugin support.
- Node.js 20 or later, `git`, and the GitHub CLI `gh` logged in.
- Optional, per channel: an OpenProject API token in `~/.config/op/config.json`, a Figma token in `~/.config/figma/token`, and an `rclone` remote named `gdrive` for Google Doc comments. Tokens are read at run time and never printed.

## Install

```text
/plugin marketplace add Tedydev-web/tedy-kit-engine#v0.1.0
/plugin install tedy@tedy-kit
```

The `#v0.1.0` pins a release: the plugin changes only when you move the pin and run `claude plugin marketplace update tedy-kit`.

## Set up your profile

Run `/tedy:setup` in a project. On the first run it creates your profile: it asks where (default `~/.config/tedy`, or another folder it then sets as `TEDY_PROFILE_DIR` in `~/.claude/settings.json`), writes a default `config.json`, a starter `rules.md` and an empty `projects/` folder without overwriting anything, and adds `@<profile>/rules.md` to `~/.claude/CLAUDE.md` after a backup. It then builds the project map. To create the profile by hand instead, run `node <plugin>/scripts/profile.mjs init`.

`profile.mjs doctor` shows what the plugin will read. The layout and every config key are in [`plugin/shared/profile-layout.md`](plugin/shared/profile-layout.md).

## Gates

| Gate | Default | What it does |
|---|---|---|
| Integration-branch push | always on | Asks before a push to `main`, `master`, `dev`, `develop`, `production` or `staging`, unless the repository is in `gates.pushExempt` |
| History rewrite | always on | Asks before a force push, a deleting refspec or `--mirror` |
| `gates.noComments` | off | Blocks edits that add code comments and reports comments a push carries |
| `gates.draftPrOnly` | off | Refuses a pull request that is not a draft |
| `gates.ghWrites` | off | Refuses direct `gh` writes so that everything posted to GitHub goes through `github-write.mjs` after an approved draft |
| `gates.roleGate` | off | Asks before a session writes for another role listed in the project map's `sessions` |

A broken `config.json` turns every personal gate on and is reported at session start until `profile.mjs doctor` reports it ok.

## Commands

| Command | Does |
|---|---|
| `/tedy:setup [update]` | Builds or updates the project map in your profile through guided questions |
| `/tedy:reconcile <scope>` | Cross-checks PRD, design, backend, contract, frontend and demo for one scope; writes a mismatch table and a raise list |
| `/tedy:review-pr <PR>` | Reviews a teammate's PR against the PRD, the design and the backend, drafts one-sentence line comments, posts after approval |
| `/tedy:dev <task>` or `rebut <review>` | Builds one task (reconcile, branch, verify on the commit, independent review, draft PR) or checks an external review claim by claim before any edit |
| `/tedy:pm <scope>`, `replies` or `tasks <scope>` | Drafts tracker items and Doc or Figma comments from a gaps ledger, publishes after approval, checks replies |
| `/tedy:learn [project path]` | Turns repeated corrections into rules, style samples or map facts in your profile |

Menus and table words come in the profile's chat language (`language.chat`, English and Vietnamese today); comments follow the language each project map sets for PR reviews, the tracker, and Doc and Figma.

## Trackers

`openproject.mjs` is the only tracker adapter. The commands, files and guarantees an adapter must keep are in [`plugin/shared/tracker-contract.md`](plugin/shared/tracker-contract.md); `project-map.mjs doctor` reports a `tracker.type` with no adapter.

## Where data lives

| What | Where |
|---|---|
| Rules, style samples, project maps, gate switches | Your profile: `TEDY_PROFILE_DIR` or `~/.config/tedy` |
| Gate log, edit log, draft snapshots, last reply check | `TEDY_STATE_DIR` or `~/.local/state/tedy` |
| Tracker slug map | `~/.config/op/sync/` |

Uninstalling the plugin removes none of these.

## Development

```bash
claude --plugin-dir ./plugin
node --test plugin/scripts/*.test.mjs
node plugin/scripts/public-scan.mjs tree . --denylist <your-profile>/public-denylist.txt
```

`--plugin-dir` replaces the installed `tedy` for that session only. `public-scan.mjs history <repo>` checks every object a push would publish for home paths, email addresses, secrets and the terms in your denylist. After a Claude Code update, `bash evals/probes/run-probes.sh` re-checks the platform behaviour the hooks rely on, and `evals/pressure/run-pressure.sh` replays scenarios where the agent is pushed to skip an approval (`ARMS`, `PLUGIN_DIR` and `LABEL` select what runs).

Authoring rules for skills:
- Each SKILL.md opens with a persona, the iron laws and a "not for this skill" section naming the sibling that owns that work.
- A skill is model-invocable only when the agent must reach it on its own; otherwise it sets `disable-model-invocation: true`.
- Every step ends on a checkable completion criterion. Rules are stated positively with a one-clause reason.
- Menu labels are keys of `plugin/scripts/labels.mjs`, never literal text.
- A description stays under 1,024 characters and must parse as plain YAML: no ` #` and no `: ` inside it.

## License

No license has been chosen yet, so all rights are reserved.
