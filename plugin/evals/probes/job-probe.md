# Job probe: a cockpit runs a pm job and a dev job

Run this by hand after a Claude Code update, and before a release that changes how jobs run. It checks the platform facts the job hooks and the role gate rely on ([ADR 0019](../../../docs/adr/0019-jobs-run-as-native-background-subagents.md)): a background `tedy:<role>` subagent spawned from the spec `job.mjs start` prints, its binding and state, SendMessage to its agent id, `close`, and the role gate's verdicts on its calls.

It is a manual procedure, not a script. A job is a background subagent whose completion reaches the cockpit as a notification in a later turn, and the probe needs several cockpit turns (spawn, list while it runs, list after, SendMessage, close). A print-mode run ends with its one turn, and on Claude Code 2.1.292 a print-mode session could exit before its background subagents finished, so a scripted cockpit was not trusted to measure this. No headless run of it was tried.

Cost on 2026-11-11: about USD 0.5 on `claude-sonnet-5-5`, about 180k subagent tokens.

## Set up an isolated world

The probe uses its own state dir, profile dir and a single-repo map with `"jobs":true`, so no real project, job record or gate log is touched. `K` is the `plugin` folder of the kit checkout under test.

~~~sh
K=/path/to/tedy-kit/plugin
W=$(mktemp -d /tmp/tedy-job-probe-XXXX)
git init -q --bare -b main "$W/origin.git"
git clone -q "$W/origin.git" "$W/proj"
printf 'start\n' > "$W/proj/notes.txt"
git -C "$W/proj" add notes.txt
git -C "$W/proj" commit -q -m init
git -C "$W/proj" push -q origin HEAD:main
git -C "$W/proj" remote set-head origin main
mkdir -p "$W/profile/projects" "$W/state"
printf '{"gates":{"roleGate":true}}\n' > "$W/profile/config.json"
printf '# probe\n\n```json\n{"name":"probe","paths":["%s"],"repos":[{"path":".","role":"probe","branch":"main"}],"jobs":true,"language":{"pr_review":"en"}}\n```\n' "$W/proj" > "$W/profile/projects/probe.md"
cd "$W/proj" && TEDY_STATE_DIR="$W/state" TEDY_PROFILE_DIR="$W/profile" claude --plugin-dir "$K" --model claude-sonnet-5-5
~~~

A T3 thread works as the cockpit too, when its provider launches `claude` with the same `--plugin-dir` and environment.

## Steps in the cockpit

Type each request; the cockpit follows `jobs.md`. Note what each step shows.

1. "Start a pm job: list the files in this repository into plans/reports/probe-files.md." Expect `job.mjs start pm` to print an Agent spec and the cockpit to spawn it in the background.
2. "Start a dev job for repository .: add the line hello to notes.txt, commit it and push the task branch." Expect `job.mjs start dev --repo .` to make the core worktree under `$W/.worktrees` and the cockpit to spawn the job.
3. About 10 seconds later: "Run job.mjs list." Expect each job as `not started` until its agent's first tool event, then `running`.
4. Once both completion notifications arrived: "Run job.mjs list." Expect both `done`.
5. "Send the pm job's agent a SendMessage, to the agent id its Agent call returned, that says: reply PONG." Expect `{"success":true,"message":"Resuming agent …","resumedAgentId":…}` and the reply PONG.
6. "Close both jobs with job.mjs close." Expect the dev close to print `removed <worktree> (the job is closed)`, and `job.mjs list` then `No jobs are open.`

## Checks after the run

- The pm job invoked the Skill tool with `tedy:pm`; the dev job read the dev `SKILL.md` by path, worked in the core worktree, committed, pushed its branch and ran `job.mjs done`. Read them in the agent transcripts under `~/.claude/projects/<the dashed $W/proj path>/<session id>/subagents/`.
- `$W/state/gate-log.jsonl` holds a `role-gate` line with `"decision":"allow"`, `"agent_type":"tedy:dev"`, `"role":"dev"` and `"kind":"code"` for the dev job's commit or push.
- Its `push-report` line names the `cwd` the hook saw. On 2026-11-11 that was the cockpit's folder, not the worktree, while the agent ran `git -C <worktree> push`.
- `$W/state/jobs/*.json` holds one closed tombstone per job: `state` `closed`, the role, the job file and the agents.

Record what you saw, with the Claude Code version, the date and the cost, under "Probe evidence" in ADR 0019, and move each fact it settles out of that ADR's "Not yet exercised live" list.

## Not covered yet

Add a step when one of these matters:

- run the cockpit in `default` mode and check that a job's permission prompt shows as `waiting: permission` in `job.mjs list` (the Notification hook's `agent_id`);
- TaskStop a running job by its agent id, then check `stopped` and whether SubagentStop follows;
- a job's Monitor command, its hook input and whether the post-push report sees a push run through it;
- a job agent that dies without SubagentStop.

## Clean up

Close any job still open, quit the cockpit, then remove `$W` and the transcripts folder `~/.claude/projects/<the dashed $W/proj path>`.
