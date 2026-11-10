# 0018: Jobs are visible sessions opened by optional runtime adapters

Status: accepted (2026-11-09, user decisions; built and probed 2026-11-09 to 2026-11-10); amends ADR 0015

## Context
- ADR 0015 runs each job as `claude --agent tedy:<role> --bg`, started from the cockpit's own Bash call. On 2026-11-09 two of four jobs on a mapped project ended `lost` and nobody noticed. The transcripts and the user journal, read that day, show why:
  - The PM job's last event is a Bash call that edits a draft holding a publish command line. git-gate returned `ask` for it ("this publishes through a kit script in a form the permission rules do not match"), which is a false positive: the command edits a file and publishes nothing. The job waited 50 minutes on a prompt no window showed.
  - The review job's last event is a heredoc Bash call. No gate-log row exists for it, so what held it is not proven (a built-in prompt or a hook that did not finish). It waited 29 minutes.
  - Both transcripts were last written at 03:49:48Z. That is the second the user journal records T3 Code stopping the systemd scope of the cockpit thread that had started both jobs.
  - Mechanism (derived): a `--bg` session started from the cockpit's Bash stays in the cockpit's process scope, so stopping that scope kills every job in it.
- T3 Code, where the user works, does not list `--bg` sessions. Its own Claude threads do appear in `claude agents` (as `interactive`), but a `--bg` job shows only in the terminal agent view, so the user could not see progress, see that a job needed them, or step in.
- The user decided on 2026-11-09:
  - Drop `--bg`.
  - Jobs ask their questions with AskUserQuestion in their own window, while publish approval stays on inbox cards.
  - T3 Code and herdr are adapters used to their full extent but never required.
  - Worktrees come from T3 or herdr when one of them launches the job.
- On 2026-11-10 the user asked the kit to add the T3 provider instances itself instead of printing them to paste, which reverses the plan's "the kit never writes T3 config".

## Decision
- **A job is a session the user can watch and type into.** `job.mjs start` writes the job file and its launch record, then hands the launch to one adapter, picked in the order t3, herdr, print; `--via` forces one.
  - **t3:** the cockpit calls `t3_thread_launch` on the provider instance `tedy-<role>`.
  - **herdr:** `job.mjs` opens a tab and runs `herdr agent start <role>-<hash> --kind claude --pane <id> -- --agent tedy:<role> --settings <file> <prompt>`.
  - **print:** it prints one `cd '<cwd>' && claude --agent tedy:<role> --settings '<file>' '<prompt>'` line for any terminal.
  - The cockpit never runs that command in its own Bash.
- **Each role has one settings file**, `<state>/jobs/settings/<role>.json`. It holds the role's allowlist, the ask rules and the `TEDY_*` env, and the same file serves T3 Launch arguments, herdr agent args and a terminal.
- **The kit writes job status itself.**
  - Hooks bind a `tedy:<role>` session to its job file by reading the kit's own launch form at the start of the first user prompt in its transcript: `/tedy:<skill> job <file>` (in the transcript wrapped as `<command-message>…<command-args>job <file>`, observed in the print, herdr and T3 probe transcripts) or `Job file <file>` for devops. No other path in the prompt counts. The resume prompt starts with the same form for its own job and puts the note after it, so a note naming another job binds the session to its own job. They never bind one to a job file whose status is `closed`; the status is read under the record lock, so a record `close` kept for its worktree is not bound again by the closed job's still-running session.
  - They record the claude pid with its start time, and they record each state: `running`, `waiting: permission`, `waiting: input`, `waiting: question`, `idle`.
  - `job.mjs list` reads only these records, and shows `lost (last seen <time>)` once the pid is gone.
  - Every change to a launch record, from a hook or from `job.mjs`, reads and writes it under the kit's record lock in the same state dir, and a hook writes only while the record still holds its session. A hook that read the record before `close` deleted it, or before `resume` unbound it, writes nothing back. No lock is held across a herdr call, git or the wait for a signalled process.
  - `stop` signals no process; it only writes the job's stopped status, so a job reports only itself. Only `close`, which is on no role's allowlist, ends a session, and it signals only the recorded pid while that pid is a claude process (its `comm` or the first word of its command line is `claude`, the same test the hooks use to find the session's pid) whose start time matches. `close` refuses to run in a job's session: before it writes anything it walks up from its caller to the nearest claude process (`claudeProcess`) and compares that pid and start time with every launch record; when one matches, it stops for any job, its own included, and tells the job to ask the user to close it from the cockpit. Each T3 thread, herdr pane and terminal job runs its own claude process (observed 2026-11-10: every T3 thread is a separate `claude` child of `t3 serve`), so the cockpit's caller never matches a job's record. On top of that the role gate asks before a literal `job.mjs close` from a session whose `agent_type` is `tedy:<role>`, or from its subagents, of another job or its own, and names the job file. It checks this before the role gate switch and the map lookup, so the ask holds with the switch off and outside a mapped folder. The cockpit, which has no `agent_type`, is not asked.
  - No `claude agents`, `claude stop` or `claude rm` call is left.
- **A dev job with `--repo` gets its worktree from the adapter that launched it:**
  - T3 `workspaceStrategy`
  - `herdr worktree create`
  - otherwise a core `git worktree add`, which `close` and `prune` remove on merge, after idle days or on close, never with uncommitted or unpushed work, and never while it holds an ignored file other than a whole top-level ignored folder with a regenerable name (`node_modules`, `dist`, `build`, `out`, `.next`, `.nuxt`, `.turbo`, `.cache`, `coverage`, `.parcel-cache`, `.vite`, `target`): git must report the folder itself as ignored (`git status --porcelain --ignored=matching`, entry `!! <name>/` with no other slash), so an ignored file inside a tracked `build/` or in a nested `scripts/build/` or `src/out/` keeps the tree. `--ignored=matching` rather than the default `--ignored` mode, because the default reports a folder that holds only ignored files as `!! <name>/` even when no pattern ignores the folder. This matters because `git worktree remove` deletes ignored files, such as a local-only test the user's global gitignore keeps out of commits. Those paths are printed with the reason.
  - `start` records the worktree, its owner, the branch and the base in the kit-owned launch record, and `close` and `prune` read them only from there, never from the job file header a job session can edit. They remove a tree only while `git worktree list --porcelain` of the recorded repository lists it on the recorded branch (Consequences: launch records are checked, not sealed). A tree `close` keeps keeps a record without its session keys until `prune` removes the tree. A job started before this has no such fields, so its core worktree is left for the user to remove.
  - Neither removes a worktree the command runs inside, so the session running the command keeps its folder. A later `prune` can still remove the tree of a closed job whose own session still runs (Consequences).
- **`close` closes the herdr pane the kit opened for a job**, once its session has ended, and only when `herdr pane get` reports exactly the job's recorded session in it; never a pane the command runs in, one that runs another session, or one that reports none.
- **`job.mjs t3-instance --all --write` (or `<role> --write`) adds the T3 instances.**
  - It backs up `~/.t3/userdata/settings.json` beside itself first, then upserts `providerInstances["tedy-<role>"]` with driver `claudeAgent` and Launch arguments `--agent tedy:<role> --settings <file>`, keeping every other key. An existing `tedy-<role>` entry gets only its `driver`, `enabled` and `config.launchArgs` set, and keeps the fields the user added (`displayName`, `environment`, other `config` keys). The temporary file is created with the settings file's mode before the text is written. A symlinked settings file is followed to its real path, and the backup and the write go there, so the link stays a link. Accepted: a change T3 writes between the kit's re-read and its rename is lost; the window is the length of one write.
  - It refuses a file that is missing, is not JSON or has no `providerInstances` object.
  - The cockpit and `/tedy:setup` run it only after one AskUserQuestion that names the file, because the file is outside the profile. The role gate asks before a job session runs a literal `job.mjs t3-instance … --write`, by the same check as its close ask. Accepted: a job's `job.mjs start` and `resume` are not asked; "a job never starts a job" stays a rule in `jobs.md`, not a gate.

## Enforcement
- `plugin/tests/job.test.mjs`:
  - "start writes the running job file and its launch record, then prints one cd-and-claude command for the user and never runs claude"
  - "the job code never runs claude: no fleet list, background launch, claude stop or claude rm is left in it"
  - the list, stop, close and resume cases, including "close that may not signal the recorded process says why and leaves the job not closed with its record", "close refuses when it runs in a bound job's session, for another job or its own, whatever shell form runs it, before it writes anything", "a resume note that names another job of the same role binds the resumed session to its own job" and "resume passes the role's settings file, written afresh, never a settings path the launch record holds or an edited settings file"
  - "a hook that read a job's record before close deleted it, or before resume unbound it, does not write the old session back".
- `plugin/tests/role-gate.test.mjs`:
  - "a job asks before job.mjs close of another job or of itself and names the job file, and the cockpit is not asked"
  - "every command form the gate normalizes asks for a job's close, and the reason names the absolute job file"
  - "the gate entry asks a job before job.mjs close with the role gate off and no map covering the folder, and lets the cockpit close"
  - "with the role gate off a job's subagent is asked before job.mjs close once the job's main thread has run a tool"
  - "a job asks before job.mjs t3-instance --write, not before it prints the instances, and the cockpit is not asked".
- `plugin/tests/record-lock.test.mjs`: "withLockSync waits for a held lock, refuses after its wait with the holder named, and releases the lock when its function returns or throws".
- `plugin/tests/job-session-hooks.test.mjs`: binding from the transcript, "binding reads only the kit's launch form at the start of the first user prompt, never another job path the prompt or a later prompt names", no rebinding, "a job file whose status is closed binds no session, even when its record has none, and the session does not bind a later job file it names", the state each hook writes, the pid walk, and the start-time check in `alive`.
- `plugin/tests/job-adapters.test.mjs`:
  - adapter choice and `--via` refusals; the herdr tab, agent, fallback and list cases
  - "close ends the job's session first, then closes the herdr pane the kit opened for it; stop and a job with no kit pane make no herdr call", and the case that leaves a pane open
  - the `t3-instance --write` cases (upsert, idempotence, a merge into an existing `tedy-<role>` entry that keeps the file's mode, drift refusal on a temp settings file, and "t3-instance --write through a symlinked settings file writes the file the link points to and keeps the link")
  - the docs check.
- `plugin/tests/job-worktrees.test.mjs`: the worktree owner for each adapter, prune and close, plus:
  - ignored files outside regenerable folders keep a tree, whatever `status.showUntrackedFiles` says;
  - "an ignored file counts as regenerable only inside a whole top-level ignored folder with a regenerable name, so a tracked build folder, a nested build or out folder, or a regenerable name holding only ignored files keeps the tree", and "close keeps a core worktree whose ignored file sits in a tracked build folder";
  - a live recorded session keeps a tree;
  - a closing command inside the tree keeps it;
  - "close and prune remove a core worktree only when it is a registered worktree of the recorded repository on the recorded branch";
  - an edited job file header changes nothing close or prune removes.
- `plugin/tests/job-probes.test.mjs`: the eval probes keep no background launch.
- `plugin/tests/git-gate-script-names-in-data.test.mjs`: "a sed -i edit of a draft holding a publish line asks, and so does a sed whose later operand becomes a script".
- `plugin/tests/canon-checks.test.mjs`: "a kit hook on an event that adds text to every prompt or every subagent spawn fails" keeps UserPromptSubmit out of hooks.json.
- Isolation: every job test puts a fake `herdr` first on PATH, and `test-isolation.mjs` points `TEDY_T3_SETTINGS` at a scratch file.

## Prior art

- Claude Code subagents docs (Anthropic docs, studied 2026-11-10, via web)
  - https://code.claude.com/docs/en/sub-agents "Background subagents surface every permission prompt in your main session."
  - Lesson: a native subagent cannot be the job, because its prompts land in the cockpit and it cannot ask the user itself.
  - Not taken: subagents as jobs; they stay for read-only helpers such as the reviewer lenses.
- Claude Code agent teams docs (Anthropic docs, studied 2026-11-10, via web)
  - https://code.claude.com/docs/en/agent-teams "with the `-p` flag, including Agent SDK sessions, Claude doesn't spawn teammates"
  - Lesson: T3 runs Claude through the Agent SDK, so agent teams cannot form inside T3.
  - Not taken: agent teams as jobs.
- Claude Code hooks reference (Anthropic docs, studied 2026-11-10, via web)
  - https://code.claude.com/docs/en/hooks "Present when the session uses `--agent` or the hook fires inside a subagent"
  - Lesson: `agent_type` reaches hooks from the launch flag whatever opens the session, so one launch line serves T3, herdr and a terminal.
  - Taken: role identity stays `agent_type`, as ADR 0015 decided.
- T3 Code provider settings (installed binary, studied 2026-11-10, via local)
  - `strings t3` (T3 Code 0.1.8-nightly.20261109.4392) "Additional CLI arguments passed on session start."
  - Lesson: a T3 Claude provider instance carries Launch arguments, so `--agent` and `--settings` can ride on it. Before the probe below this was read from the code, not run. T3 issue 18638 reported `--settings` launch arguments ignored in older builds.
  - Taken: one T3 instance per role, written by the kit on the user's yes.
- NanoClaw architecture (project docs, studied 2026-11-10, via web)
  - https://docs.nanoclaw.dev/concepts/architecture.md "kills a container whose heartbeat is older than max(30 minutes, its declared Bash timeout)"
  - Lesson: a runtime that owns its workers detects a dead one from a heartbeat, rather than waiting for someone to notice.
  - Taken: hooks write `last_event_at` and the claude pid, and `list` reports `lost (last seen <time>)`. Not taken: killing or retrying a job on a timer.
- Claude Code orchestration tools compared (secondary source: a comparison post, not the tools' own docs, studied 2026-11-10, via web)
  - https://munderdiffl.in/blog/claude-code-orchestration-tools-compared/ "Session managers and worktree apps score high on control and simplicity"
  - Lesson: the common shape across Claude Squad, Conductor and the like is one agent per task in its own worktree, with the human attaching to type. Each of them is a second window next to T3.
  - Not taken: adopting one of them; T3 and herdr already show and attach the job.
- A practitioner on parallel agents in tmux (public post, found by the 2026-11-10 search and not quoted in the research report, studied 2026-11-10, via x)
  - https://x.com/shortcutFoo/status/2119511192720867763 "Three Claude agents in tmux, all waiting on you."
  - Lesson: practitioners run each agent in a pane they can see and step through when it waits.
  - Taken: the herdr adapter opens each job in its own tab and pane.

position: role-coordination conforms

## Consequences
- **Supersedes ADR 0015's launch.** These no longer apply: `--bg`, `--name`, the fleet lookups, `claude stop` and `claude rm` by short id, `bgIsolation`, and the probe blocks that measured them (removed from `plugin/evals/probes/job-probes.mjs`).
- **Kept from ADR 0015:**
  - the cockpit and the one inbox of typed cards
  - publish approval on cards, with nothing published on a timeout
  - the per-record locks and pins
  - the job file format
  - the role read from `agent_type`.
- **Jobs may now ask questions.** ADR 0015's "never call AskUserQuestion" for jobs is reversed: a job asks in its own window. ADR 0015's note that AskUserQuestion never times out in a background session no longer applies to jobs.
- **ADR 0014's ban on a kit UserPromptSubmit hook stands**, so binding reads the transcript head on the session's first hook event instead of a prompt hook.
  - After a typed prompt, a job shows `running` only from its first tool result.
  - A denied permission prompt leaves `waiting: permission` until the next Stop.
  - A closed job's session that still runs is not bound again once its record has lost the session, because `bind` refuses a job file whose status is `closed`. While a record still holds the session, though, its hooks keep writing `state` and `last_event_at` to it whatever the job file says (review, 2026-11-10); that is how `prune` sees such a session alive and keeps its tree until the session ends. Since `close` refuses to run in a bound job's session, `close` itself no longer leaves a live session in a record (its own-session branch in `endSession` stays as a guard but the CLI no longer reaches it); a record still holds one when a job marked its own file closed. When `close` had no recorded pid, nothing shows the session is alive, and `prune` may remove a tree that session still runs in.
- **Every session pays for the status hook.** The PostToolUse hook has no matcher, so each tool call in every session, the cockpit and ordinary sessions included, starts a node process that scans the launch records: about 40 ms per call (38 ms with no records, 42 ms with 200, measured by the review on 2026-11-10). Records are deleted only by `close`, so jobs left `done` but never closed keep growing the scan. Accepted for now.
- **A job's `close` is a hook ask, not an ask rule.** `close` is on no allowlist, so before this only `default` mode asked, and a job under `bypassPermissions` could close and signal another job unasked: every PreToolUse Bash gate allowed it (probe, 2026-11-10). Hook asks show under `bypassPermissions` (in T3 they appear as approval cards), so the role gate asks. The gate matches only a literal `job.mjs close`; a variable or `$(…)` as the subcommand, a symlink, `xargs`, a script file or interpreter code passes it (review, 2026-11-10). So `close` also refuses itself in a job's session, which every one of those forms reaches, because each runs inside the job's claude process tree. Accepted ceiling: a process the job detaches from that tree, a session before its first hook binds it, a launch record the job rewrote first (the `Edit(/<state>/**)` ask rule covers only the Edit tool), and a plain `kill` of another session's pid are not stopped.
- **Nothing depends on T3 or herdr.** With neither on the machine the print adapter does everything, and the suite passes with herdr off PATH.
- **The kit now writes one file outside its profile and state:** T3's settings. It does so only on the user's yes, with a backup beside the file, and it refuses a file shape it does not know. When T3 changes that schema the write fails loudly, and the printed Launch arguments still work.
- **herdr pane check:** the kit closes a pane only when herdr reports the job's own session in it, so a launch record pointed at another pane closes nothing. If real herdr stops reporting `agent_session` once claude has exited, every kit pane is kept with "close it by hand"; that is not yet checked live.
- **Launch records are checked, not sealed.** A job under `bypassPermissions` can rewrite its launch record with a shell command; only the Edit tool meets the `Edit(/<state>/**)` ask rule. So the kit checks what it acts on: `alive` and every signal need a claude process with the recorded start time; `resume` writes the role's settings file again and passes that path, never `record.settings`; a core worktree is removed only while `git worktree list --porcelain` of `record.repo` lists it on `record.branch`; a herdr pane is closed only on an exact session match. Accepted ceiling: a record rewritten to another live claude session's pid and start time still makes the cockpit's `close` signal that session, a record pointed at another registered worktree of the same repository on its own branch still lets `close` remove that tree when it is clean and pushed, and a job can also `kill` a pid itself.
- **Worktrees:** T3 deletes its worktrees after 10 days or on merge, so a dev job in a T3 or herdr worktree pushes its branch at its first commit.
- **Open:**
  - The cause of the review job's 29-minute wait is not known.
- **The git-gate false positive behind the PM job's wait stays.** A rule that read a text-only `sed -i` edit of a draft as data was built and then reverted (2026-11-10): a later operand that bash turns into `-e` (`$E`, a brace expansion, a glob) makes sed run the next operand as a script, so a quote-split publish passed the gate and no ask rule matched it. A job's ask now shows in its own window, so the false positive costs one visible approval. Jobs edit drafts and job files with the Edit or Write tool instead (`jobs.md`, Job 1).
- **Not yet exercised live:**
  - a role-gate ask through an allowlist under T3
  - herdr notifications on `waiting`
  - a real dev job in a T3 or herdr worktree
  - `herdr pane close` on a real pane. The tests' fake replies `{"type":"ok"}`; if the real reply carries no `result`, the kit prints "close pane … by hand" after a close that worked. Whether closing the root pane of a `herdr worktree create` workspace touches the worktree is also unchecked (herdr has a separate `worktree remove`).
  - `t3-instance --write` against a running T3. The instance shape matches the 0.1.8 nightly's `ProviderInstanceConfig`, where `displayName` and `environment` are optional, and the user's file already holds instances without `environment`.

## Probe evidence
OBSERVED, from probe runs on 2026-11-09 and 2026-11-10. The kit was frozen at one commit in a detached worktree, with an isolated profile, state dir and repository. Each adapter ran one `tedy:pm` job, which ran `echo probe-ok`, asked one AskUserQuestion (a/b) and recorded the answer with `job.mjs done`.

| Adapter | Run | Identity | Binding, pid, state | Question | Cost |
|---|---|---|---|---|---|
| print (`claude -p`, Sonnet 5.5, 2026-11-09) | 6 turns, stopped itself | `--agent tedy:pm`; session-role file `pm` | bound, pid recorded, `idle` | `-p` has no AskUserQuestion; the job said so and stopped | USD 0.51 (measured) |
| herdr (own pane, Opus 5.5, 2026-11-09) | done | footer `tedy:pm`; session-role file `pm` | bound, pid; `job.mjs list` showed `waiting: question` while herdr showed `blocked` | answered `a` in the pane | USD 0.59 (statusline) |
| t3 (instance `tedy-pm` through `t3_thread_launch`, Sonnet 5.5, 2026-11-10) | done in 34 s | transcript `agent-setting: tedy:pm`; session-role file `pm`, written by the kit hook, so hooks saw `agent_type: tedy:pm` | bound, pid, `idle` | T3 `user_input` request pending 19 s, answered `a` in the T3 UI | not measured (Sonnet, about 10 tool calls) |

- `--agent` and `--settings` in a T3 instance's `config.launchArgs` reach Claude through T3's Agent SDK path.
- T3 loaded an instance added to its settings file without a restart: the instance appeared in `orchestrator_capabilities`. The schema read from the 0.1.8 nightly is `{ driver, displayName, enabled, environment, config: { launchArgs } }`.
- Folder trust is per folder: the herdr job stopped at the trust dialog of the new probe folder.
- After `close`, the herdr pane stayed open on an idle shell. That observation is why `close` now closes it.
