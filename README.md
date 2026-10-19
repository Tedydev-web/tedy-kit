# tedy-kit engine

A Claude Code plugin (`tedy`) for pull request review, development and project management that keeps every write behind a draft the user approves. It reconciles a scope across the PRD, the design, the backend, the contract and the frontend; drafts review comments, tracker items and Doc or Figma comments in the user's style and language; and adds hooks that stop the agent from publishing, pushing to an integration branch or crossing into another role's work without asking.

The plugin holds no personal or project data. Everything that belongs to one user (rules, writing samples, project maps, gate switches) lives in their profile directory, which the plugin reads.

## Requirements

- Claude Code with plugin support.
- Node.js 20 or later, `git`, and the GitHub CLI `gh` logged in.
- Optional, per channel: an OpenProject API token in `~/.config/op/config.json`, a Figma token in `~/.config/figma/token`, and an `rclone` remote named `gdrive` for Google Doc comments. Tokens are read at run time and never printed.

## Install

```text
/plugin marketplace add Tedydev-web/tedy-kit#v0.2.4
/plugin install tedy@tedy-kit
```

The `#v0.2.4` pins a release: the plugin changes only when you move the pin and run `claude plugin marketplace update tedy-kit`.

### Local release worktree

A `directory` marketplace loads the plugin in place and ignores `version`, so the way to pin a local install is a git worktree checked out at a tag. Keep the development clone (here `~/Documents/workspace/tedy-kit`) for work, and point the marketplace at a release worktree:

```text
git -C ~/Documents/workspace/tedy-kit worktree add --detach ~/Documents/workspace/tedy-kit-release v0.1.0
claude plugin marketplace add ~/Documents/workspace/tedy-kit-release
claude plugin install tedy@tedy-kit
```

Write the tag to `<profile>/release-tag`; `profile.mjs doctor` fails when the worktree is dirty or sits at another tag. Changing an existing marketplace path needs `claude plugin uninstall`, `claude plugin marketplace remove`, then the two commands above; editing the path in settings does not move the install.

Release steps:
1. Change on a branch in the development clone, and test with `claude --plugin-dir <clone>/plugin`.
2. Merge to `main`, and tag `vX.Y.Z` with `plugin.json` `version` equal to the tag.
3. Smoke the tag in a temporary worktree, then push the branch and the tag.
4. Write the tag to `<profile>/release-tag` and commit it in the profile.
5. `git -C ~/Documents/workspace/tedy-kit-release checkout --detach <tag>`; the profile guard asks first.
6. Run `/reload-plugins` in each open session.

## Set up your profile

Run `/tedy:setup` in a project. On the first run it creates your profile: it asks where (default `~/.config/tedy`, or another folder it then sets as `TEDY_PROFILE_DIR` in `~/.claude/settings.json`), writes a default `config.json`, a starter `rules.md` and an empty `projects/` folder without overwriting anything, and asks before adding `@<profile>/rules.md` to `~/.claude/CLAUDE.md`, and backs that file up first. It then builds the project map. To create the profile by hand instead, run `node <plugin>/scripts/profile.mjs init`.

`profile.mjs doctor` shows what the plugin will read. The layout and every config key are in [`plugin/shared/profile-layout.md`](plugin/shared/profile-layout.md).

## Gates

| Gate | Default | What it does |
|---|---|---|
| Integration-branch push | always on | Asks before a push to `main`, `master`, `dev`, `develop`, `production` or `staging`, unless the repository is in `gates.pushExempt` |
| History rewrite | always on | Asks before a force push, a deleting refspec or `--mirror` |
| PR merge and ready | always on | Asks before `gh pr merge`, `gh pr ready` and the equivalent `gh api` calls, in any form the gate can read |
| Work package in the PR body | always on in a project whose map has a `tracker` | Refuses `gh pr create` whose body does not carry `OP#<id>` |
| Unchecked publish | always on | Asks before a `node <script>` publish that no `permissions.ask` rule covers, or whose draft the gate could not read |
| Unreadable command | always on | Refuses, without asking the user, a command the gate cannot read (a command word built at run time, `eval`, a shell reading code from stdin or `-c`, over 10,000 characters, or nested too deep), and tells the agent to rewrite it as plain commands or a script file in the system temp directory run with `python3` or `node`, keeping every push, merge and GitHub write a plain command of its own. The gate does not read script files, so a push or merge placed inside one is not checked |
| Tracker token | always on | Refuses any tool call that reads the tracker token file or writes to the tracker host around `openproject.mjs` |
| Profile guard | always on | Asks before a write to the profile's `config.json` or `rules.md`, and before a checkout, reset or pull in the release worktree |
| `gates.noComments` | off | Blocks edits that add code comments and reports comments a push carries |
| `gates.draftPrOnly` | off | Refuses a pull request that is not a draft |
| `gates.ghWrites` | off | Refuses direct `gh` writes so that everything posted to GitHub goes through `github-write.mjs` after an approved draft |
| `gates.roleGate` | off | Asks before a session writes for another role listed in the project map's `sessions` |
| `gates.publishQuote` | off | Refuses a `github-write.mjs` post, reply or edit until the exact body was quoted to the user after its last change |

A broken `config.json`, or a profile with `rules.md` and no `config.json`, turns every personal gate on and is reported at session start until `profile.mjs doctor` reports it ok. The five PreToolUse gates run with `onFailure: "block"`: a gate that cannot start, crashes or times out stops the tool call. A gate that catches its own error allows, except git-gate on a publish command and the profile guard, which ask.

## Approval prompts

Publishing is approved in two layers. `permissions.ask` rules in `~/.claude/settings.json` that match the kit's publish scripts (`github-write.mjs`, `openproject.mjs … --apply`, `figma-comments.mjs`, `gdoc-comments.mjs`, `doc-comment-file.mjs post … --apply`) prompt before each write. git-gate asks too when no such rule matches the command. Both prompts appear in an interactive session, including `bypassPermissions` mode and subagents. In a headless `claude -p` run nobody can answer, so the ask becomes a refusal.

## Rescue

- Roll the plugin back from a plain shell: `git -C ~/Documents/workspace/tedy-kit-release checkout --detach <previous tag>`, then `/reload-plugins` in each running session.
- Turn the plugin off: `claude plugin disable tedy@tedy-kit`. A session that is already running keeps the hooks it loaded until it reloads or restarts.
- From inside a Claude session, approving the profile guard's prompt is the only way to change the profile's `config.json` or `rules.md`, or to move the release worktree. A plain shell is not gated.

## Commands

| Command | Does |
|---|---|
| `/tedy:setup [update]` | Builds or updates the project map in your profile through guided questions |
| `/tedy:reconcile <scope>` | Cross-checks PRD, design, backend, contract, frontend and demo for one scope; writes a mismatch table and a raise list |
| `/tedy:review-pr <PR>` | Reviews a teammate's PR against the PRD, the design and the backend, drafts one-sentence line comments, posts after approval |
| `/tedy:dev <task>` or `rebut <review>` | Builds one task (reconcile, branch, verify on the commit, independent review, draft PR) or checks an external review claim by claim before any edit |
| `/tedy:pm <scope>`, `replies` or `tasks <scope>` | Drafts tracker items and Doc or Figma comments from a gaps ledger, publishes after approval, checks replies |
| `/tedy:learn [project path]` | Turns repeated corrections into rules, style samples or map facts in your profile |
| `/tedy:pending [done <file> \| stub <action>]` | Lists what waits on you (hand-offs, drafts in `plans/drafts/`, unpushed branches, draft PRs) and archives a finished draft |

Menus and table words come in the profile's chat language (`language.chat`, English and Vietnamese today); comments follow the language each project map sets for PR reviews, the tracker, and Doc and Figma.

## Trackers

`openproject.mjs` is the only tracker adapter. The commands, files and guarantees an adapter must keep are in [`plugin/shared/tracker-contract.md`](plugin/shared/tracker-contract.md); `project-map.mjs doctor` reports a `tracker.type` with no adapter.

## Where data lives

| What | Where |
|---|---|
| Rules, style samples, project maps, gate switches | Your profile: `TEDY_PROFILE_DIR` or `~/.config/tedy` |
| Gate log, edit log, draft snapshots, last reply check | `TEDY_STATE_DIR` or `~/.local/state/tedy` |
| Release worktree the profile guard watches | `TEDY_RELEASE_DIR` or `~/Documents/workspace/tedy-kit-release` |
| `permissions.ask` rules git-gate checks a publish against | `TEDY_CLAUDE_SETTINGS` or `~/.claude/settings.json` |
| Tracker slug map | `~/.config/op/sync/` |

Uninstalling the plugin removes none of these.

## Development

```bash
claude --plugin-dir ./plugin
npm test
node plugin/scripts/public-scan.mjs tree . --denylist <your-profile>/public-denylist.txt
```

`plugin/gates/` holds the PreToolUse gates, `plugin/lib/` everything else, `plugin/tests/` the tests; each `plugin/scripts/<name>.mjs` is a two-line shim so older paths keep working. Terms are defined in [GLOSSARY.md](GLOSSARY.md), and decisions with their history in [docs/adr/](docs/adr/).

`--plugin-dir` replaces the installed `tedy` for that session only. `public-scan.mjs history <repo>` checks every object a push would publish for home paths, email addresses, secrets and the terms in your denylist. `public-scan.mjs file <path>` checks one file even inside an ignored folder, which `/tedy:learn` uses for the lessons that leave a project. `memory-stats.mjs`, run from a mapped project, counts the auto-memory files and sessions since the last `/tedy:learn`; the session-start notice uses the same counts to suggest a learn pass. After a Claude Code update, `bash plugin/evals/probes/run-probes.sh` re-checks the platform behaviour the hooks rely on, and `plugin/evals/pressure/run-pressure.sh` replays scenarios where the agent is pushed to skip an approval (`ARMS`, `PLUGIN_DIR` and `LABEL` select what runs).

Every ADR from 0009 on has a `## Prior art` section with pinned evidence, and every `feat`/`fix` commit since the latest tag carries an `ADR:` or `Prior-art:` trailer; `npm test` checks both, and [docs/prior-art/procedure.md](docs/prior-art/procedure.md) gives the study steps, the formats and the card template. `prior-art-verify.mjs <file>` checks the pinned lines and issue states against GitHub (network, outside `npm test`).

Authoring rules for skills:
- Each SKILL.md opens with a persona, the iron laws and a "not for this skill" section naming the sibling that owns that work.
- A skill is model-invocable only when the agent must reach it on its own; otherwise it sets `disable-model-invocation: true`.
- Every step ends on a checkable completion criterion. Rules are stated positively with a one-clause reason.
- Menu labels are keys of `plugin/lib/labels.mjs`, never literal text.
- A description stays under 1,024 characters and must parse as plain YAML: no ` #` and no `: ` inside it.

## License

No license has been chosen yet, so all rights are reserved.
