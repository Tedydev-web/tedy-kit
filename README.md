# tedy-kit engine

A Claude Code plugin (`tedy`) for pull request review, development and project management that keeps every write behind a draft the user approves. It reconciles a scope across the PRD, the design, the backend, the contract and the frontend; drafts review comments, tracker items and Doc or Figma comments in the user's style and language; and adds hooks that stop the agent from publishing, pushing to an integration branch or crossing into another role's work without asking.

The plugin holds no personal or project data. Everything that belongs to one user (rules, writing samples, project maps, gate switches) lives in their profile directory, which the plugin reads.

## Requirements

- Claude Code with plugin support.
- Node.js 20 or later, `git`, and the GitHub CLI `gh` logged in.
- Optional, per channel: an OpenProject API token in `~/.config/op/config.json`, a Figma token in `~/.config/figma/token`, and an `rclone` remote named `gdrive` for Google Doc comments. Tokens are read at run time and never printed.

## Install

```text
/plugin marketplace add Tedydev-web/tedy-kit#v0.2.9
/plugin install tedy@tedy-kit
```

The `#v0.2.9` pins a release: the plugin changes only when you move the pin and run `claude plugin marketplace update tedy-kit`.

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

The gates keep an honest but careless agent from publishing, merging, rewriting history or pushing to an integration branch without the user. They do not stop an agent set on getting around them: deliberate obfuscation is out of scope, and the forms still known to pass are listed under the table.

| Gate | Default | What it does |
|---|---|---|
| Integration-branch push | always on | Asks before a push to `main`, `master`, `dev`, `develop`, `production` or `staging`, unless the repository is in `gates.pushExempt` |
| History rewrite | always on | Asks before a force push, a deleting refspec or `--mirror` |
| PR merge and ready | always on | Asks before `gh pr merge`, `gh pr ready` and the equivalent `gh api` calls, in any form the gate can read |
| Work package in the PR body | always on in a project whose map has a `tracker` | Refuses `gh pr create` whose body does not carry `OP#<id>` |
| Unchecked publish | always on in `gates.publishApproval: "ask"` | Asks before a `node <script>` publish that no `permissions.ask` rule covers, or whose draft the gate could not read |
| Unreadable command | always on | Refuses, without asking the user, a command the gate cannot read (a command word built at run time or holding glob characters, `eval`, a shell or interpreter reading code from stdin, a heredoc, a pipe, `-`, `/dev/stdin` or a process substitution, a shell given `-c`, a globbed script path, an interpreter script path held in a variable whose arguments carry a kit publish verb, `find -exec`, `script`, `busybox` or `flock -c` carrying git, gh, a shell or an interpreter, over 10,000 characters, or nested too deep), and tells the agent to rewrite it as plain commands or a script file in the system temp directory run with `python3` or `node`, keeping every push, merge and GitHub write a plain command of its own. The gate reads quoted and escaped words the way the shell does, looks through wrappers such as `env`, `sudo`, `setsid`, `flock`, `timeout`, `nohup`, `xargs` and `npx` and through absolute paths such as `/usr/bin/git`, checks each command after a `;`, `&&`, `||`, `|` or `&` and inside a `( … )` subshell, and judges it in the directory that `cd`, `pushd` and `popd` leave it in. It does not read script files, so a push or merge placed inside one is not checked |
| Context-mode shell | always on | Checks shell code sent through any MCP server's `ctx_execute`, `ctx_execute_file` or `ctx_batch_execute` exactly like a Bash command, so every row above, the profile guard, `gates.roleGate` and the post-push report apply: `code` with `language: "shell"`, and every command in a batch. Each command is judged where context-mode runs it: in an absolute `cwd` (which `ctx_execute_file` ignores, as context-mode does), otherwise in `CLAUDE_PROJECT_DIR`; a relative `cwd` is refused, because context-mode resolves it against its own install directory. Code in another language there is not read, like a `python3 <file>` script. A kit-script publish sent this way is refused and the agent told to run it as a plain Bash command, because the `permissions.ask` rules ask only on Bash. A call whose fields the gate cannot read is refused |
| Tracker token | always on | Refuses any tool call that reads the tracker token file or writes to the tracker host around `openproject.mjs` |
| Profile guard | always on | Asks before a write to the profile's `config.json` or `rules.md`, and before a checkout, reset or pull in the release worktree |
| `gates.noComments` | off | Blocks edits that add code comments and reports comments a push carries |
| `gates.draftPrOnly` | off | Refuses a pull request that is not a draft |
| `gates.ghWrites` | off | Refuses direct `gh` writes so that everything posted to GitHub goes through `github-write.mjs` after an approved draft |
| `gates.roleGate` | off | Asks before a session writes for another role listed in the project map's `sessions` |
| `gates.publishQuote` | off | Refuses a `github-write.mjs` post, reply or edit until the exact body was quoted to the user after its last change |
| `gates.publishApproval` | `"ask"` | `"answer"` lets each kit script write only with a one-use ticket from an approving AskUserQuestion answer, so Claude Code shows no second prompt; see [Approval prompts](#approval-prompts) |

A broken `config.json`, or a profile with `rules.md` and no `config.json`, turns every personal gate on and is reported at session start until `profile.mjs doctor` reports it ok. The five PreToolUse gates run with `onFailure: "block"`: a gate that cannot start, crashes or times out stops the tool call. A gate that catches its own error allows, except git-gate on a publish command and the profile guard, which ask; in `gates.publishApproval: "answer"` git-gate refuses such a publish instead.

Known limitations, by design or left out by the threat model:

- An interpreter one-liner (`node -e`, `python3 -c`) is read only for `gh`, so a push inside one passes.
- A script file is not read, and a renamed copy or a symlink of a kit script is not seen as a publish.
- `bash <script> < file`, `bash <script> -s` and `bash <script> -c <arg>` are refused, although the script, not stdin, holds the code.
- A directory change other than `cd`, `pushd` and `popd` (`git --git-dir=…`, `GIT_DIR=…`, `env -C …`) is not followed, and a branch name built by brace expansion or read from stdin (`git push origin {main,}`, `echo main | xargs git push origin`) is not seen.
- Runners such as `su -c`, `ssh`, `watch` and `parallel` are refused only when their text mentions `gh` or `github`; a git push through them passes.
- The gates match any MCP server's `ctx_execute`, `ctx_execute_file` and `ctx_batch_execute`; a future server with those names and another input shape would be refused as malformed.
- role-gate still counts a search whose text names a kit script and a write verb as that write.
- A function defined as `f () { … }`, with a space before `()`, is not refused the way `f() { … }` is.
- The profile guard reads a plain `git` command word only, not one behind a wrapper or an absolute path.
- Value-taking flags are known for the shells, python and node only; another interpreter's flag that takes a separate value can hide a `-` after it.
- `env -S` strings are not unwrapped.
- Whether Claude Code's own `permissions.ask` matching sees a quoted subcommand was not tested; the gate asks when the raw text matches no rule.
- With `gates.publishApproval: "answer"` the ticket check lives in the kit scripts. A write that does not go through them (`gh` directly with `gates.ghWrites` off, `curl` to a tracker or design API, a copied script with the check removed) meets no ticket check and, under `bypassPermissions`, no prompt either.
- A ticket, a PR body record or a sources record made by hand, with `cp`, `mv`, a script file or any other subprocess writing into the state folder, is out of the threat model: the deny rules the switch adds block only Claude's file tools, the file commands Claude Code recognises in Bash and redirect targets.
- Ticket matching normalises each line before comparing it: it drops leading `>` quote marks, folds runs of whitespace (CRLF included) into one space and skips blank lines, so a body that differs from the preview only in those still matches. It does not render Markdown: a body line inside an HTML comment (`<!-- … -->`) in the preview, which a rendered preview hides, still counts as shown, a short body line such as `OK` matches any preview line that is exactly `OK`, and a body that is blank imposes no line.
- Tickets are not tied to a session: an approval in one session can be used by an identical command in another within its 30 minutes.
- The ticket hook reads the answers from the `tool_response` Claude Code passes to PostToolUse, documented as the tool's own output and recorded in transcripts as `{questions, answers, annotations}`; a headless run has no AskUserQuestion, so this was not checked live.

## Approval prompts

Every publish starts with the skill's AskUserQuestion menu (`post.asIs` or `approve.all`). What happens after the user picks it depends on `gates.publishApproval`:

- `"ask"` (default): `permissions.ask` rules in `~/.claude/settings.json` that match the kit's publish scripts (`github-write.mjs`, `openproject.mjs … --apply`, `figma-comments.mjs`, `gdoc-comments.mjs`, `doc-comment-file.mjs post … --apply`) prompt a second time before each write, and git-gate asks when no such rule matches the command. Both prompts appear in an interactive session, including `bypassPermissions` mode and subagents. In a headless `claude -p` run nobody can answer, so the ask becomes a refusal.
- `"answer"`: no second prompt. When the user picks `post.asIs` or `approve.all` (labels in the chat language, with no note, on a single-select question whose text is unique, the preview the tool reports as shown equal to the option's, and not an AFK, follow-up or freeform answer), a PostToolUse hook on AskUserQuestion writes a ticket holding the chosen option's `preview` to `<state>/approvals/`. Each kit script, right before it writes, builds its command line from its own arguments (`github-write.mjs reply 1 2 --body-file b.md --repo o/r`) and uses the oldest unused ticket, at most 30 minutes old, whose preview has that command line on a line of its own (it may start with `node` and the script's full path) and holds every text the script is about to send on whole lines: the whole review draft file (PR, head, every `path:line` and comment) for `github-write.mjs post`, a body file, or the `approval lines:` block that the dry run of `openproject.mjs preview`, `openproject.mjs rollback` and `doc-comment-file.mjs post` prints (per draft whether it creates, updates or merges which work package and every field it sends, each `#id subject` a rollback touches, each comment's EPIC, tab, place and quote). A write that sends no text needs only its command line. A write whose target would otherwise come from the working directory or the project map names it on the command line: `--repo` for `github-write.mjs` post, edit, reply and pr-body, `--project` for `openproject.mjs apply` and `rollback --apply`, `--file` for `figma-comments.mjs`, `--doc` for `gdoc-comments.mjs` and for `doc-comment-file.mjs post --apply` (which must equal the map's PRD doc). Using a ticket renames it, so one ticket covers one command, once, even when two run at the same time. With no matching ticket the script writes nothing and says to ask again. A real `--dry-run` of `post` or `pr-body` needs no ticket. git-gate leaves these commands to the scripts: it neither allows nor asks.

Claude Code still prompts on a matching `permissions.ask` rule when a hook returns `allow` ([permissions: precedence among rules, hooks, and mods](https://code.claude.com/docs/en/permissions#precedence-among-rules-hooks-and-mods)), so `"answer"` also needs the kit's rules out of `settings.json`. One command switches both and is safe to repeat:

```bash
node <plugin>/scripts/profile.mjs publish-approval answer
node <plugin>/scripts/profile.mjs publish-approval ask
node <plugin>/scripts/profile.mjs publish-approval
```

The first removes exactly the 22 kit publish rules, adds `Edit(//<state>/approvals/**)`, `Edit(//<state>/pr-bodies/**)` and `Edit(//<state>/drafts/*.sources.json)` (the real absolute paths) to `permissions.deny` so an agent's file tools cannot write a ticket, a recorded `pr-body` output or a sources record, and sets the key; the second restores the rules and takes the deny rules back out; the third prints the mode, how many rules are present and whether all three deny rules are on. Each write first copies `settings.json` to `settings.json.tedy-backup-<time>` with the same file mode, and touches no other key; `Bash(gh pr merge*)` stays in both modes. A missing `config.json` is refused (run `profile.mjs init` first), and the profile guard asks before a session runs the switch. Running sessions pick up both files without a restart. The deny rules name the state folder from `TEDY_STATE_DIR` as the switch sees it, and the switch prints it, so run the switch from a Claude session or with the same variable exported. In the gate log, each approving answer leaves `"decision":"ticket"`; an answer that gave none leaves `"no-ticket"` with the response keys the hook saw.

Upgrading and rolling back: a plugin release from before `gates.publishApproval` rejects the key as unknown and so turns every personal gate on. Update the plugin in every running session (`/reload-plugins`) before running `publish-approval answer`. Before moving back to such a release, run `publish-approval ask` first: it restores the rules and removes the key from `config.json`, since `"ask"` is the default. `profile.mjs init` writes no `publishApproval` key for the same reason.

## Pinned sources

A draft is only as current as the sources it was read from. A clean lint records them in the kit's state directory: `draft-lint.mjs pr-comment` and `pr-reply` pin each sibling repo a backticked `path:line@branch` cite resolves to, the path read literally, as its local `origin/<branch>@<sha>` plus the cited paths; `figma-comment` pins the Figma file version, `doc-comment` and `doc-comment-file.mjs` the SHA-256 of the PRD Doc's text across its tabs, read through the Docs API without suggestions (a Doc whose text cannot be read gives no pin and refuses, so Doc comments need an own OAuth client), and `openproject.mjs preview` every Figma file and Doc the drafts link. Each pin prints a `pinned:` line for the approval preview. At publish, `github-write.mjs post`, `reply` and `edit`, the Figma and Doc writers and `openproject.mjs apply` refuse a body that was never linted or changed since, then re-fetch every pin, the way an HTTP `If-Match` precondition refuses a stale write ([RFC 9110 §13.1.1](https://www.rfc-editor.org/rfc/rfc9110#section-13.1.1)): unchanged posts; a repo that moved without touching a cited path posts with a `notice:` line; a cited path touched, a Figma node changed, or any change to the Doc's text refuses with `refused:`, naming the commits and files, so the agent re-reads, fixes the draft, lints and asks again. `doc-comment-file.mjs post --apply` only notes a changed Doc, because it re-finds every highlighted passage before anchoring.

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
| Gate log, edit log, draft snapshots, last reply check, approval tickets (`approvals/`) | `TEDY_STATE_DIR` or `~/.local/state/tedy` |
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
