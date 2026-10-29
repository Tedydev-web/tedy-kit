# tedy-kit engine

A Claude Code plugin (`tedy`) for pull request review, development and project management that keeps every write behind a draft the user approves. It reconciles a scope across the PRD, the design, the backend, the contract and the frontend; drafts review comments, tracker items and Doc or Figma comments in the user's style and language; and adds hooks that stop the agent from publishing, pushing to an integration branch or crossing into another role's work without asking.

The plugin holds no personal or project data. Everything that belongs to one user (rules, writing samples, project maps, gate switches) lives in their profile directory, which the plugin reads.

## Requirements

- Claude Code with plugin support.
- Node.js 20 or later, `git`, and the GitHub CLI `gh` logged in.
- Optional, per channel: an OpenProject API token in `~/.config/op/config.json`, a Figma token in `~/.config/figma/token`, and an `rclone` remote named `gdrive` for Google Doc comments. Tokens are read at run time and never printed.

## Install

```text
/plugin marketplace add Tedydev-web/tedy-kit#v0.2.16
/plugin install tedy@tedy-kit
```

The `#v0.2.16` pins a release: the plugin changes only when you move the pin and run `claude plugin marketplace update tedy-kit`.

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

Run `/tedy:setup` in a project. On the first run it creates your profile: it asks where (default `~/.config/tedy`, or another folder it then sets as `TEDY_PROFILE_DIR` in `~/.claude/settings.json`), asks whether your team keeps code free of comments or opens pull requests only as drafts, writes a `config.json` with `roleGate`, `ghWrites` and `publishQuote` on plus the gate for each rule you keep, a starter `rules.md` and an empty `projects/` folder without overwriting anything, and asks before adding `@<profile>/rules.md` to `~/.claude/CLAUDE.md`, and backs that file up first. It then builds the project map. To create the profile by hand instead, run `node <plugin>/scripts/profile.mjs init`.

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
- The Drive `files.export` reference does not say how it treats tabs, and Google's own Workspace Developers post says it does not support per-tab export ([issue 379170478](https://issuetracker.google.com/379170478)). On a real 10-tab Doc on 2026-10-23, a line taken from each of the 9 later tabs was found in the `text/plain` export, so a `via drive-export` pin covered every tab there; that was one Doc, read once.
- The Drive `text/plain` export holds the comments: an `[a]`, `[b]`, … marker at each anchor and an `[a]<text>` line per comment or reply after the body (seen on a real Doc on 2026-10-23: 294 of its 296 such lines equal, whitespace folded, the text of a comment or reply the Drive comments API lists; 2 match none). A `via drive-export` pin takes the export first, then lists the comments through the same token, and drops only the lines that equal a listed comment or reply, then every `[x]` marker; every other line, the 2 unmatched ones included, stays in the hash. A body line that starts with `[a]` therefore stays hashed unless its text equals a comment's; then deleting that line, and only that, goes unseen. A comment deleted or edited between the export and the list call, and any edit to a comment, stays in the hash and refuses. Literal `[a]`-style text in the body is dropped with the markers. Whether an export of a Doc with no comments ends exactly where the body of the same Doc with comments ends was not checked live.
- Git pins name no file: a moved repo refuses only when a changed path appears in the text being posted, by its file name when that has a dot and by its full path otherwise. A claim that rests on code the text never names (a behaviour, a field) posts with a `notice:` when that code changed; read the notice. A changed file with a common name (`index.ts`) refuses a text that names any file of that name.
- Read pins close the gap between reading and linting only when `pin-sources` ran before the read: a lint without read pins pins at lint time and its `warning:` names what it pinned, and so does a branch only an `@branch` token names, or a Doc or frame the read pins lack. Those warnings belong in the approval preview. Read pins are tied to a path and never expire; a draft path reused days later diffs from the old read, which refuses or notes more, never less. A read pin newer than the draft refuses the lint, a cheap guard against pinning again without re-reading; it reads the file's modification time only.
- A Figma link with no `node-id`, and a `figma-comment` lint without `--node` (which prints a `warning:`), pin the whole file by its `lastModified`, which moves on any edit to the file. Whether a comment moves `lastModified` was not checked, because checking it needs a post; with node pins it would only print a notice.

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

The first removes exactly the 22 kit publish rules, adds `Edit(//<state>/approvals/**)`, `Edit(//<state>/pr-bodies/**)` and `Edit(//<state>/drafts/**)` (the real absolute paths) to `permissions.deny` so an agent's file tools cannot write a ticket, a recorded `pr-body` output, a sources record, a frozen original or a preview's locks, and sets the key; the second restores the rules and takes the deny rules back out; the third prints the mode, how many rules are present and whether all three deny rules are on. Each write first copies `settings.json` to `settings.json.tedy-backup-<time>` with the same file mode, and touches no other key; `Bash(gh pr merge*)` stays in both modes. A missing `config.json` is refused (run `profile.mjs init` first), and the profile guard asks before a session runs the switch. Running sessions pick up both files without a restart. The deny rules name the state folder from `TEDY_STATE_DIR` as the switch sees it, and the switch prints it, so run the switch from a Claude session or with the same variable exported. In the gate log, each approving answer leaves `"decision":"ticket"`; an answer that gave none leaves `"no-ticket"` with the response keys the hook saw.

Upgrading and rolling back: a plugin release from before `gates.publishApproval` rejects the key as unknown and so turns every personal gate on. Update the plugin in every running session (`/reload-plugins`) before running `publish-approval answer`. Before moving back to such a release, run `publish-approval ask` first: it restores the rules and removes the key from `config.json`, since `"ask"` is the default. `profile.mjs init` writes no `publishApproval` key for the same reason. A setup switched to `answer` by a release that added fewer deny rules is refused at every write until `publish-approval answer` runs again: in answer mode a kit script spends no ticket while `settings.json` lacks any of the three deny rules, and says so.

## Pinned sources

A draft is only as current as the sources it was read from. The kit records them in its state directory, without reading cites out of the text, at two moments:

- Before the read, `draft-lint.mjs pin-sources <draft or ledger> [--pr <n> --repo <owner/repo>] [--branch <repo>:<branch>]… [--doc <id>] [--file <key> --node <node-id>,…]` records read pins for that path: every repo in the project map at the tip one `git ls-remote --heads origin` per repo returns (all repos are asked at the same time; an origin that cannot be reached fails the run and names the repo), each `--branch` a draft will cite outside the map's branch, with `--pr` the PR head at `refs/pull/<n>/head` of the repository it runs in (which covers a PR from a fork), and the Doc text and node hashes below. The kit treats each clone's `origin` as its upstream: the tips, the PR head and the `owner/repo` a PR pin records all come from `origin`, and a `--repo` that is not the checkout's `origin` fails. The branch is the map's `branch`, or `origin/HEAD` when it has none, the way `project-map.mjs doctor` reads it; a repo with neither fails, and so does a run from a folder no project map covers. It fetches when the commit is missing, then always moves `refs/remotes/origin/<branch>` (or `refs/pr/<n>`) to the pinned sha, so the read sees what was pinned; every later lint moves them again to the tip it pins, so read with `git show <sha>:<path>` using the sha the `pinned:` line prints in full. Every git call the pins make runs with `GIT_TERMINAL_PROMPT=0`, and `ls-remote` and `fetch` run ssh with `-o BatchMode=yes` added to the user's own ssh command (`GIT_SSH_COMMAND`, else the clone's `core.sshCommand`, else `ssh`), so an origin that asks for a password, a passphrase or a host key fails instead of waiting for an answer nobody gives. A `GIT_SSH` program with neither of those set is left to git as it is, without `BatchMode`, so whether it can prompt is up to that program. A new `pin-sources` for a draft path is a new read, so it also drops that draft's frozen original; the next clean lint freezes the redraft, which is how a review whose PR head moved is redrafted on the same path.
- At the lint, every lint below (with `--pinned-at <path>` when the read pins were taken for another path, such as a pm ledger) keeps the read pins and rechecks them with the publish rules as of the lint: a change that would refuse the publish fails the lint and asks for `pin-sources` again and a re-read, one that would pass prints a `notice:`. A git read pin is compared with the tip the lint just took, so origin is asked once per ref. Figma frames the read pins already cover are the exception: every Figma read is a Tier 1 call (20 a month on a View or Collab seat), so the lint keeps those read pins as they are without asking Figma, and the post or reply rechecks them with the one `/nodes` call it makes; a Doc the read pins hold is not read again for a fresh pin either, only for its recheck. Only the read pins of what that lint pins itself are kept, every git pin plus the Docs and Figma nodes it targets or its text links, so a designer's edit to node A does not stop a post on node B and a Doc change does not stop a Figma post that does not cite it. What the read pins lack is pinned at lint with a `warning:`.
- Every lint pins every repo in the project map, FE and BE alike, plus any branch a `path:line@branch` cite in its text names (an `@mention`, a mail address or a decorator is not a branch), and the Figma files and Docs its text links. `draft-lint.mjs pr-comment` also pins the head of the PR its header names, and `pr-reply` the head of `--pr <n>`; both take `--repo <owner/repo>` like `pin-sources`, and `--pr` without `--repo` fails. With a PR head pinned, the reviewed repo does not pin its own integration branch (the map's `branch`, else `origin/HEAD`) unless `pin-sources --branch <its map path>:<branch>` names it: the comments name the files the PR touches, which are the files other PRs keep merging into that branch, and the PR head pin already covers the code under review. A `path:line@<branch>` cite of any other branch, such as `@feature/x`, pins that branch in the reviewed repo too, and in every other repo that has it. A cite whose branch no repo pins prints a `warning: the cite @<branch> pins nothing: …` that names the reason and the `--branch` to add; like every `warning:` line it goes into the approval.
- `figma-comment <file> --file <key> --node <node-id>` pins the SHA-256 of the canonical (sorted-key) JSON of each node from one `GET /v1/files/<key>/nodes?ids=…`, no `version` parameter, plus the `lastModified` that call returns; Figma links add their nodes (`node-id=12-34`, `12:34`, `12%3A34`, `&amp;node-id=`, instance ids; `design`, `file`, `proto`, `board`, `slides`, `make`, `site` and `embed?url=` links; a `…/branch/<branch>/…` link pins the branch file). A run asks `/nodes` once per file for both the pin and the comment's position. A Figma 429 refuses at once with its `Retry-After`, without waiting.
- `doc-comment <file> --doc <id>` and `doc-comment-file.mjs` pin the Doc: through the Docs API, the SHA-256 of the canonical JSON of every tab and child tab read without suggestions, its body, headers, footers, footnotes, chips, rich links, images and formatting, leaving out only `revisionId`, named ranges, comment anchors, suggestion fields and an image's `contentUri`, a link that lives 30 minutes (`via docs-text`, own OAuth client), so a formatting change refuses too; else the SHA-256 of the Drive `text/plain` export without the comment section at its end (`via drive-export`): after the last blank line that is followed by a `[a]`-style label, each entry whose text is a comment or reply the Drive comments API lists and whose label also marks the body is taken out, with the body markers of those labels and no other bracketed text, and an entry whose label marks the body but whose text the API shows differently keeps its text under the label `[?]`, and so does each body marker of its label that is attached to the text before it, the way the export writes markers (a bracketed letter after a space is body text and stays), so a reply that re-letters the entries after it does not move the pin. A Docs API 403 falls back to the export, except a quota 403; any other Docs API error gives no pin. Doc links (`docs.google.com/document/d/<id>`, `/a/<domain>/…`, `/u/<n>/…`) add their Doc; a Drive link (`drive.google.com/open?id=<id>`, `docs.google.com/open?id=<id>`, `drive.google.com/file/d/<id>`, `docs.google.com/spreadsheets/d/<id>`, `docs.google.com/presentation/d/<id>`) is looked up with `files.get`, a shortcut followed to its target, and pins a Google Doc the same way, any other file (a PDF, an image, a video, a Sheet, a Slides deck) by its `md5Checksum`, or its `modifiedTime` when Drive keeps no checksum (for Sheets and Slides a comment may move `modifiedTime` too and refuse the next post; unverified); a Drive folder link (`drive/folders/<id>`, or an `open?id=` that is a folder) fails the lint, since nothing pins what is inside it; a published `/document/d/e/<id>/pub` link fails the lint. `doc-comment-file.mjs` pins the links in every card's comment too, and pins the Doc before it reads the tabs; with a read pin of the Doc it keeps that pin instead of reading the Doc again.
- `openproject.mjs preview` and the preview runs of `comment` and `comment-edit` (without `--apply`) count as lints here and take `--pinned-at <ledger>` the same way; a preview that fails on a read pin writes no locks, snapshot or record.

Each pin prints a `pinned:` line for the approval preview, ending in `(read <time>)` for a read pin or `(at lint)`. The sources record also keeps every `warning:` line the lint printed and the file its read pins came from; in answer mode a writer passes those warnings to the approval check with the text it writes, so a preview without them matches no approval, and a refusal that asks for a new lint names `--pinned-at <that file>`. At publish, `github-write.mjs post`, `reply` and `edit`, the Figma and Doc writers, `doc-comment-file.mjs post --apply` and `openproject.mjs apply`, `comment --apply` and `comment-edit --apply` refuse a body with no sources record, one that cannot be read, one written for another file, or one edited since, then recheck every pin before the approval is spent, the way an HTTP `If-Match` precondition refuses a stale write ([RFC 9110 §13.1.1](https://www.rfc-editor.org/rfc/rfc9110#section-13.1.1)):

- A repo whose tip did not move passes. One that moved is diffed with `git diff --name-status --no-renames <pin> <tip>`, so a rename lists its old and new name; when any changed path appears anywhere in the text being posted (by its file name as a whole word, in any case, when that has a dot or a capital such as `Dockerfile`, else by its full path, or under a cited folder ending in `/`, also written `/…` from the repo root, `../<repo>/…`, `<repo>/…`, as the clone's absolute path or as a GitHub `/tree/<ref>/…` link, where every split after `/tree/` is tried because a ref may hold a slash and trailing punctuation is cut; inside code spans and fences, in a GitHub blob URL, percent-encoded or not, through markdown escapes and `_emphasis_`), it refuses with the files and the commits; otherwise it posts and prints a `notice:` line.
- A PR head that moved refuses, whatever the text names, for `post`, `reply` and `edit` alike. All three also refuse unless the record holds a PR pin for exactly that `--repo` and PR (the draft's PR for `post`; `edit` reads it from the comment's `pull_request_url`) and `gh pr view` shows that PR at exactly the pinned head. Origins are asked once per repo, all repos at the same time.
- A Drive file pinned by checksum or modified time refuses on any change.
- A Figma node whose JSON hash changed or that is gone refuses; a moved `lastModified` with every pinned node unchanged posts with a notice; a file linked with no node refuses on any `lastModified` change, even when the read pins hold only some of its nodes.
- Any change to a Doc's pin refuses, `doc-comment-file.mjs post --apply` included.
- A deleted branch, a pinned commit missing from the clone, a `git`, `rclone` or API error, or a call that takes over 60 s (a stalled response body, token refresh or PRD tab export included) refuses.

A refusal leaves the approval ticket unused. A notice goes to the terminal only, after the approval is spent, so the text written is the text approved.

Three gaps remain. A `path:line@<branch>` cite of the reviewed repo's own integration branch pins nothing in that repo, so a merge into it that changes the cited line still posts; the lint warns only when no other repo pins that branch either. A finding that cites such a line needs `pin-sources --pr <n> --repo <owner/repo> --branch .:<branch>` (with the reviewed repo's map path in place of `.`) before the read. After `pin-sources`, only the draft's modification time shows it was rewritten after the new read, so a redraft that moves its header to the new head sha and keeps the old body unchanged still lints and posts. And a Doc image replaced in place ("Replace image") that keeps its object id, size and crop is not seen, because its `contentUri` is left out of the pin; whether Docs keeps those fields on a replace is unverified.

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

`--plugin-dir` replaces the installed `tedy` for that session only. `public-scan.mjs history <repo>` checks every object a push would publish for home paths, email addresses, secrets and the terms in your denylist. `public-scan.mjs file <path>` checks one file even inside an ignored folder, which `/tedy:learn` uses for the lessons that leave a project. `memory-stats.mjs`, run from a mapped project, counts the auto-memory files and sessions since the last `/tedy:learn`; the session-start notice uses the same counts to suggest a learn pass. After a Claude Code update, `bash plugin/evals/probes/run-probes.sh` re-checks the platform behaviour the hooks rely on, and `plugin/evals/pressure/run-pressure.sh` replays scenarios where the agent is pushed to skip an approval (`MODEL`, a full model id, is required; `SCENARIOS`, `ARMS`, `RUNS`, `PLUGIN_DIR` and `LABEL` select what runs). `node plugin/evals/pressure/rebaseline.mjs <results folder> --write` folds a run into `plugin/evals/pressure/baseline.json`, refuses a lower pass rate unless the model changed and `--accept-model-change` is given, and prints the ablation verdict for each model-gap rule of the standard; it proposes, the user removes.

Every ADR from 0009 on has a `## Prior art` section with pinned evidence, and every `feat`/`fix` commit since the latest tag carries an `ADR:` or `Prior-art:` trailer; `npm test` checks both, and [docs/prior-art/procedure.md](docs/prior-art/procedure.md) gives the study steps, the formats and the card template. `prior-art-verify.mjs <file>` checks the pinned lines and issue states against GitHub (network, outside `npm test`). Per ADR 0011, `npm test` also fails a release tag whose `plugin.json` names another version, a dead relative link, repository path or line number in the published docs, and any kit file that still names a file the kit retired. The kit's development standard is the ledger [docs/canon/standard.json](docs/canon/standard.json): each rule names the test that enforces it by file and exact title, or is marked for review with the reason no machine can check it, and `npm test` fails a rule whose test is gone or renamed. [docs/canon/conformance.json](docs/canon/conformance.json) records the standard version each skill, ADR, card and sweep record conforms to: register a new one at the current version, and add a waiver only with a new standard version.

Authoring rules for skills:
- Each SKILL.md opens with a persona, the iron laws and a "not for this skill" section naming the sibling that owns that work.
- A skill is model-invocable only when the agent must reach it on its own; otherwise it sets `disable-model-invocation: true`.
- Every step ends on a checkable completion criterion. Rules are stated positively with a one-clause reason.
- Menu labels are keys of `plugin/lib/labels.mjs`, never literal text.
- A description stays under 1,024 characters and must parse as plain YAML: no ` #` and no `: ` inside it.

## License

No license has been chosen yet, so all rights are reserved.
