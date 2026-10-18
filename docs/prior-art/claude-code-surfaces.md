# Claude Code surfaces and models

Inventory of the Claude Code surfaces the kit can build on and of the current Claude models, so a Claude Code upgrade or a new model shows which kit lines it affects. Pages fetched 2026-10-18 (Asia/Saigon); every quoted line comes from the page linked in its row or paragraph, with markdown links reduced to their text.

## Generated (`python3 plugin/evals/probes/claude-code-inventory.py`, do not edit by hand)

Rerun after each Claude Code upgrade and diff this block. No count here is a gate.

- Claude Code: `2.1.302 (Claude Code)`
- Date: 2026-10-18 (Asia/Saigon)
- `https://code.claude.com/docs/llms.txt`: 275 doc links, 239 unique; sha256[:16] of the sorted unique list: `2e7feb769e350232`
- Hook events (`### ` headings under `## Hook events` of `https://code.claude.com/docs/en/hooks.md`): 33; lifecycle table 33, exit code 2 table 33

Evidence paths are relative to `plugin/`.

| surface | kind | kit uses | evidence |
| :- | :- | :- | :- |
| SessionStart | hook event | yes | hooks/hooks.json |
| Setup | hook event | no | hooks/hooks.json |
| InstructionsLoaded | hook event | no | hooks/hooks.json |
| UserPromptSubmit | hook event | no | hooks/hooks.json |
| UserPromptExpansion | hook event | no | hooks/hooks.json |
| MessageDisplay | hook event | no | hooks/hooks.json |
| PreToolUse | hook event | yes | hooks/hooks.json |
| PermissionRequest | hook event | no | hooks/hooks.json |
| PostToolUse | hook event | yes | hooks/hooks.json |
| PostToolUseFailure | hook event | no | hooks/hooks.json |
| PostToolBatch | hook event | no | hooks/hooks.json |
| PermissionDenied | hook event | no | hooks/hooks.json |
| Notification | hook event | no | hooks/hooks.json |
| SubagentStart | hook event | no | hooks/hooks.json |
| SubagentStop | hook event | no | hooks/hooks.json |
| TaskCreated | hook event | no | hooks/hooks.json |
| TaskCompleted | hook event | no | hooks/hooks.json |
| Stop | hook event | yes | hooks/hooks.json |
| StopFailure | hook event | no | hooks/hooks.json |
| TeammateIdle | hook event | no | hooks/hooks.json |
| ConfigChange | hook event | no | hooks/hooks.json |
| CwdChanged | hook event | no | hooks/hooks.json |
| DirectoryAdded | hook event | no | hooks/hooks.json |
| FileChanged | hook event | no | hooks/hooks.json |
| WorktreeCreate | hook event | no | hooks/hooks.json |
| WorktreeRemove | hook event | no | hooks/hooks.json |
| PreCompact | hook event | no | hooks/hooks.json |
| PostCompact | hook event | no | hooks/hooks.json |
| PreModelSwitch | hook event | no | hooks/hooks.json |
| PostModelSwitch | hook event | no | hooks/hooks.json |
| SessionEnd | hook event | no | hooks/hooks.json |
| Elicitation | hook event | no | hooks/hooks.json |
| ElicitationResult | hook event | no | hooks/hooks.json |
| plugin | manifest | yes | .claude-plugin/plugin.json |
| skill | component | yes (7) | skills/*/SKILL.md |
| subagent | component | yes (1) | agents/*.md |
| slash command | component | no | commands/*.md |
| output style | component | no | output-styles/*.md |
| statusline | component | no | settings subagentStatusLine |
| MCP server | component | no | .mcp.json or manifest mcpServers |
| hooks | component | yes | hooks/hooks.json |
| plugin eval | component | yes | evals/ |
| LSP server | component | no | .lsp.json |
| monitor | component | no | monitors/monitors.json |
| theme | component | no | themes/*.json |
| workflow | component | no | workflows/*.js |
| executable | component | no | bin/ |
| channel | component | no | manifest channels |
| mod | component | no | hooks.json modules |
| model / effort pin | model setting | no | model:/effort: frontmatter in skills, agents |

Kit uses 9 of 50 generated rows.

## Surfaces

Hand-kept. Hook rows: `purpose` is the cadence group, `limits` quotes the "Exit code 2 behavior per event" table, the verbatim line is the event's "When it fires" cell in the hooks reference. `kit uses` reads files under `plugin/` (the generated block) or the README where a surface sits outside the plugin.

| surface | purpose | limits | doc URL | verbatim line | kit uses |
| :- | :- | :- | :- | :- | :- |
| SessionStart | hook, session | can block: no; exit 2: Shows stderr to user only | https://code.claude.com/docs/en/hooks#sessionstart | "When a session begins or resumes" | yes |
| Setup | hook, session | can block: no; exit 2: Exit code and stderr are ignored | https://code.claude.com/docs/en/hooks#setup | "When you start Claude Code with `--init-only`, or with `--init` or `--maintenance` in `-p` mode" | no |
| InstructionsLoaded | hook, context | can block: no; exit 2: Exit code is ignored | https://code.claude.com/docs/en/hooks#instructionsloaded | "When a CLAUDE.md or `.claude/rules/*.md` file is loaded into context" | no |
| UserPromptSubmit | hook, turn | can block: yes; exit 2: Blocks the prompt, so it never reaches Claude | https://code.claude.com/docs/en/hooks#userpromptsubmit | "When a prompt is submitted, before Claude processes it" | no |
| UserPromptExpansion | hook, turn | can block: yes; exit 2: Blocks the expansion | https://code.claude.com/docs/en/hooks#userpromptexpansion | "When a user-typed command expands into a prompt, before it reaches Claude" | no |
| MessageDisplay | hook, turn | can block: no; exit 2: The original text is displayed | https://code.claude.com/docs/en/hooks#messagedisplay | "While assistant message text is displayed" | no |
| PreToolUse | hook, tool call | can block: yes; exit 2: Blocks the tool call | https://code.claude.com/docs/en/hooks#pretooluse | "Before a tool call executes" | yes |
| PermissionRequest | hook, permission | can block: no; exit 2: Exit code 2 isn't honored for this event and the permission flow proceeds unchanged | https://code.claude.com/docs/en/hooks#permissionrequest | "When a tool call needs a permission decision" | no |
| PostToolUse | hook, tool call | can block: no; exit 2: Shows stderr to Claude; the tool already ran | https://code.claude.com/docs/en/hooks#posttooluse | "After a tool call succeeds" | yes |
| PostToolUseFailure | hook, tool call | can block: no; exit 2: Shows stderr to Claude; the tool already failed | https://code.claude.com/docs/en/hooks#posttoolusefailure | "After a tool call fails" | no |
| PostToolBatch | hook, tool call | can block: yes; exit 2: Stops the agentic loop before the next model call | https://code.claude.com/docs/en/hooks#posttoolbatch | "After a full batch of parallel tool calls resolves, before the next model call" | no |
| PermissionDenied | hook, permission | can block: no; exit 2: Exit code and stderr are ignored because the denial already occurred | https://code.claude.com/docs/en/hooks#permissiondenied | "When auto mode denies a tool call, including denials without a classifier verdict" | no |
| Notification | hook, notification | can block: no; exit 2: Exit code and stderr are ignored | https://code.claude.com/docs/en/hooks#notification | "When Claude Code sends a notification" | no |
| SubagentStart | hook, subagent | can block: no; exit 2: Shows stderr to user only | https://code.claude.com/docs/en/hooks#subagentstart | "When a subagent is spawned" | no |
| SubagentStop | hook, subagent | can block: yes; exit 2: Prevents the subagent from stopping | https://code.claude.com/docs/en/hooks#subagentstop | "When a subagent finishes" | no |
| TaskCreated | hook, task | can block: yes; exit 2: Rolls back the task creation | https://code.claude.com/docs/en/hooks#taskcreated | "When a task is being created via `TaskCreate`" | no |
| TaskCompleted | hook, task | can block: yes; exit 2: Prevents the task from being marked as completed | https://code.claude.com/docs/en/hooks#taskcompleted | "When a task is being marked as completed" | no |
| Stop | hook, turn | can block: yes; exit 2: Prevents Claude from stopping, continues the conversation | https://code.claude.com/docs/en/hooks#stop | "When Claude finishes responding" | yes |
| StopFailure | hook, turn | can block: no; exit 2: Output and exit code are ignored, except `terminalSequence` | https://code.claude.com/docs/en/hooks#stopfailure | "When the turn ends due to an API error" | no |
| TeammateIdle | hook, agent team | can block: yes; exit 2: Prevents the teammate from going idle, so it continues working | https://code.claude.com/docs/en/hooks#teammateidle | "When an agent team teammate is about to go idle" | no |
| ConfigChange | hook, config | can block: yes; exit 2: Blocks the configuration change from taking effect (except `policy_settings`) | https://code.claude.com/docs/en/hooks#configchange | "When a configuration file changes during a session" | no |
| CwdChanged | hook, environment | can block: no; exit 2: Shows stderr to user only | https://code.claude.com/docs/en/hooks#cwdchanged | "When the working directory changes, for example when Claude executes a `cd` command" | no |
| DirectoryAdded | hook, environment | can block: no; exit 2: Stderr goes to the debug log; the directory is already added | https://code.claude.com/docs/en/hooks#directoryadded | "When a working directory is added mid-session via `/add-dir` or the SDK `register_repo_root` control request" | no |
| FileChanged | hook, environment | can block: no; exit 2: Shows stderr to user only | https://code.claude.com/docs/en/hooks#filechanged | "When a watched file changes on disk" | no |
| WorktreeCreate | hook, worktree | can block: yes; exit 2: Any non-zero exit code causes worktree creation to fail | https://code.claude.com/docs/en/hooks#worktreecreate | "When a worktree is being created via `--worktree`, `isolation: "worktree"`, or for a background session" | no |
| WorktreeRemove | hook, worktree | can block: yes; exit 2: Any non-zero exit code causes worktree removal to fail if the directory still exists afterward | https://code.claude.com/docs/en/hooks#worktreeremove | "When a worktree that a `WorktreeCreate` hook created is being removed" | no |
| PreCompact | hook, context | can block: yes; exit 2: Blocks compaction | https://code.claude.com/docs/en/hooks#precompact | "Before context compaction" | no |
| PostCompact | hook, context | can block: no; exit 2: Shows stderr to user only | https://code.claude.com/docs/en/hooks#postcompact | "After context compaction completes" | no |
| PreModelSwitch | hook, model | can block: yes; exit 2: Blocks the model switch and shows stderr to the user | https://code.claude.com/docs/en/hooks#premodelswitch | "Before Claude Code applies a model switch that you or a client requested" | no |
| PostModelSwitch | hook, model | can block: no; exit 2: Shows stderr to user only; the model already switched | https://code.claude.com/docs/en/hooks#postmodelswitch | "After the session's model changes, including changes Claude Code makes on its own, such as restoring the model when you resume a session" | no |
| SessionEnd | hook, session | can block: no; exit 2: Shows stderr to user only | https://code.claude.com/docs/en/hooks#sessionend | "When a session terminates" | no |
| Elicitation | hook, MCP | can block: yes; exit 2: Declines the request, and no dialog appears | https://code.claude.com/docs/en/hooks#elicitation | "When an MCP server requests user input during a tool call" | no |
| ElicitationResult | hook, MCP | can block: yes; exit 2: Blocks the response (action becomes decline) | https://code.claude.com/docs/en/hooks#elicitationresult | "After a user responds to an MCP elicitation, before the response is sent back to the server" | no |
| skill | reusable instructions Claude loads on match or by `/name` | "the combined `description` and `when_to_use` text is truncated at 1,536 characters in the skill listing to reduce context usage." | https://code.claude.com/docs/en/skills | "Unlike CLAUDE.md content, a skill's body loads only when it's used, so long reference material costs almost nothing until you need it." | yes (7) |
| subagent | delegated task in a separate context | "If you omit `Agent` from the `tools` list entirely, the agent can't spawn any subagents with the Agent tool." | https://code.claude.com/docs/en/sub-agents | "Each subagent runs in its own context window with a custom system prompt, specific tool access, and independent permissions." | yes (1) |
| slash command | user-run prompt by name | "Commands are the older format: a skill runs by name the same way and can also carry supporting files in its own directory, so write new ones as skills and keep `commands/` for files you already have." | https://code.claude.com/docs/en/plugins/components (limits), https://code.claude.com/docs/en/commands (verbatim) | "A command is only recognized at the start of your message." | no |
| output style | session-wide role, tone, format | "Default means no output style is selected." | https://code.claude.com/docs/en/output-styles | "An output style is a set of instructions that sets Claude's role, tone, and response format for every response in a session." | no |
| statusline | shell-script bar under the prompt | "Plugins can ship a default `subagentStatusLine` in their `settings.json`" (main `statusLine` is user settings) | https://code.claude.com/docs/en/statusline | "The status line is a customizable bar at the bottom of Claude Code that runs any shell script you configure." | no |
| MCP server | external tools and data | "Claude Code displays a warning when MCP tool output exceeds 10,000 tokens and limits output to 25,000 tokens by default." | https://code.claude.com/docs/en/mcp | "MCP servers give Claude Code access to your tools, databases, and APIs." | no |
| plugin | packaging unit for all components | "Only two keys take effect from a plugin, `agent` and `subagentStatusLine`; every other key is dropped." | https://code.claude.com/docs/en/plugins/components (limits), https://code.claude.com/docs/en/plugins/overview (verbatim) | "A Claude Code plugin is a directory of skills, agents, hooks, MCP servers, or other components that Claude Code installs and loads as one unit." | yes |
| plugin eval | scored test cases with a no-plugin baseline | "a suite makes roughly cases × runs agent runs with the plugin and the same number again for the no-plugin baseline" | https://code.claude.com/docs/en/plugin-evals | "Each case is a realistic prompt plus one or more graders." | yes (`evals/<case>/case.yaml`, `prompt.md`, `graders/`; `evals/pressure` and `evals/probes` are custom harnesses) |
| permission rule | allow / ask / deny per tool | "Rules are evaluated in order: deny, then ask, then allow." | https://code.claude.com/docs/en/permissions | "Claude Code supports fine-grained permissions so that you can specify exactly what the agent is allowed to do and what it can't." | no (a plugin cannot ship them, see plugin row; the kit gates with PreToolUse hooks) |
| sandbox | OS boundary around shell commands | "The sandbox covers shell commands only." | https://code.claude.com/docs/en/sandboxing | "The sandbox runs on macOS, Linux, and WSL2." | no |
| Agent SDK | Claude Code's agent loop as a library | "To drive the same agent loop from a language other than Python or TypeScript, run the CLI as a subprocess with the `-p` flag and `--output-format json`." | https://code.claude.com/docs/en/agent-sdk/overview | "Embed Claude Code's agent in your own Python or TypeScript application, in a process you operate" | no (no SDK import in the repo) |
| memory / CLAUDE.md | instructions loaded every session | "target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence." | https://code.claude.com/docs/en/memory | "Each Claude Code session begins with a fresh context window." | yes (`/tedy:setup` asks before adding `@<profile>/rules.md` to `~/.claude/CLAUDE.md`, README) |
| settings | JSON keys by scope | "Each source has a scope: the set of people and projects a setting saved in it applies to" | https://code.claude.com/docs/en/settings | "Settings are the JSON keys that change how Claude Code behaves: which model it starts with, what it can run without asking, which files it can't read, how it looks in your terminal, and what your organization enforces." | yes (optional `TEDY_PROFILE_DIR` in `~/.claude/settings.json`, README) |
| LSP server | diagnostics and code navigation | declared in `.lsp.json` at the plugin root | https://code.claude.com/docs/en/plugins/components | "An LSP server gives Claude diagnostics and code navigation for a language." | no |
| monitor | background command whose output reaches Claude | path `monitors/monitors.json` | https://code.claude.com/docs/en/plugins/components | "A monitor is a shell command that Claude Code starts in the background when the session starts and keeps running until it ends." | no |
| theme | interface colors | "Save each theme as `themes/<slug>.json`." | https://code.claude.com/docs/en/plugins/components | "A plugin can include color themes for the Claude Code interface." | no |
| workflow | script orchestrating subagents | "a `meta` block, then a script body that orchestrates several subagents" | https://code.claude.com/docs/en/plugins/components | "The `workflows/` folder holds workflow `.js` files" | no |
| executable | plugin CLI on the shell `PATH` | "Claude Code puts this folder on the `PATH` of the shell it runs commands in" | https://code.claude.com/docs/en/plugins/components | "`bin/` is how a plugin ships a command-line tool." | no |
| channel | outside system sends messages into a session | "In a plugin, a channel is one of the MCP servers plus a `channels` entry that binds to it" | https://code.claude.com/docs/en/plugins/components | "A channel lets an outside system such as a chat app send messages into a session." | no |
| mod | JS/TS handlers that change the interface and events | "Mods work in the Claude Code CLI, the Code tab of the Claude Desktop app, and the VS Code extension." | https://code.claude.com/docs/en/plugins/mods/overview | "A mod is a plugin that changes how Claude Code looks and behaves." | no |
| model | which model a session or subagent runs | "Aliases point to the recommended version for your provider and update over time." | https://code.claude.com/docs/en/model-config | "To pin to a specific version, use the full model name, for example `claude-opus-5-5`, or set the corresponding environment variable like `ANTHROPIC_DEFAULT_OPUS_MODEL`." | no (no `model:` in `plugin/agents` or skills) |
| effort | how much the model thinks per step | "If you set a level the active model does not support, Claude Code falls back to the highest supported level at or below the one you set." | https://code.claude.com/docs/en/model-config#adjust-effort-level | "The available effort levels depend on the model." | no (no `effort:` in `plugin/agents` or skills) |
| extended context | 1M-token window | "Opus 4.6 and Sonnet 4.6 reach 1M only through their `[1m]` variant, and access to that variant depends on your plan." | https://code.claude.com/docs/en/model-config#extended-context | "Fable 5.1, Fable 5, Sonnet 5 and later, Haiku 5.5, and Opus 4.7 and later run with the 1M window by default, with no `[1m]` suffix needed." | no |
| advisor | stronger model consulted mid-task | "The advisor tool is experimental and requires the Anthropic API." | https://code.claude.com/docs/en/advisor | "The advisor tool lets Claude consult a second, typically stronger model at key moments during a task, such as before committing to an approach, when stuck on a recurring error, or before declaring a task complete." | no |
| fast mode | faster Opus at higher price | "Fast mode is supported on Opus 5.5, Opus 5, and Opus 4.8." | https://code.claude.com/docs/en/fast-mode | "Fast mode is not a different model." | no |

LSP server, monitor, theme, workflow, executable, channel and mod are plugin components on the components page beyond the inventory's first list; they are kept so the table covers every component that page names.

## Models

Current lineup from https://platform.claude.com/docs/en/models/overview ("Compare models" table). API default effort is that table's row; the Claude Code default is from https://code.claude.com/docs/en/model-config#adjust-effort-level: "The model's default effort: `high` on every model that supports effort, except that Opus 5.5, Sonnet 5.5, and Haiku 5.5 default to `medium`". The two disagree for Sonnet 5.5 (API `high`, Claude Code `medium`).

| family | description (verbatim) | latency | price | default effort API / Claude Code | context | max output |
| :- | :- | :- | :- | :- | :- | :- |
| Claude Fable 5.1 (`claude-fable-5-1`) | "For demanding reasoning and long-horizon agentic work" | Slower | $10 / input MTok, $50 / output MTok | `high` / `high` | 1M tokens | 128K tokens |
| Claude Opus 5.5 (`claude-opus-5-5`) | "For long-running agentic coding and knowledge work" | Moderate | $4 / input MTok, $20 / output MTok | `medium` / `medium` | 1M tokens | 128K tokens |
| Claude Sonnet 5.5 (`claude-sonnet-5-5`) | "The best combination of speed and intelligence" | Fast | $2 / input MTok, $10 / output MTok | `high` / `medium` | 1M tokens | 128K tokens |
| Claude Haiku 5.5 (`claude-haiku-5-5`) | "For high-volume, latency-sensitive tasks such as classification, extraction, and routing" | Fastest | From $0.10 / input MTok, From $0.50 / output MTok | `medium` / `medium` | 1M tokens | 128K tokens |

Mythos 5.1 (`claude-mythos-5-1`), from the Fable 5.1 migration guide: "Or, for Claude Mythos 5.1, which offers the same capabilities to verified organizations" and "Claude Mythos 5.1 is available only to organizations verified through Anthropic's verification programs, such as the Cyber Verification Program."

### Deprecations

From the "Deprecation history" tables of https://platform.claude.com/docs/en/about-claude/model-deprecations. Its "Model status" table also lists `claude-mythos-preview` as Deprecated (June 9, 2026, retirement "To be announced") with no history row.

| retirement date | model | replacement |
| :- | :- | :- |
| November 30, 2026 | `claude-sonnet-4-5-20250929` | `claude-sonnet-5-5` |
| August 5, 2026 | `claude-opus-4-1-20250805` | `claude-opus-4-8` |
| June 15, 2026 | `claude-sonnet-4-20250514` | `claude-sonnet-5-5` |
| June 15, 2026 | `claude-opus-4-20250514` | `claude-opus-4-8` |
| April 20, 2026 | `claude-3-haiku-20240307` | `claude-haiku-4-5-20251001` |
| February 19, 2026 | `claude-3-5-haiku-20241022` | `claude-haiku-4-5-20251001` |
| February 19, 2026 | `claude-3-7-sonnet-20250219` | `claude-sonnet-5-5` |
| October 28, 2025 | `claude-3-5-sonnet-20240620` | `claude-sonnet-5-5` |
| October 28, 2025 | `claude-3-5-sonnet-20241022` | `claude-sonnet-5-5` |
| January 5, 2026 | `claude-3-opus-20240229` | `claude-opus-4-8` |
| July 21, 2025 | `claude-2.0` | `claude-opus-4-8` |
| July 21, 2025 | `claude-2.1` | `claude-opus-4-8` |
| July 21, 2025 | `claude-3-sonnet-20240229` | `claude-sonnet-5-5` |
| November 6, 2024 | `claude-1.0` | `claude-haiku-4-5-20251001` |
| November 6, 2024 | `claude-1.1` | `claude-haiku-4-5-20251001` |
| November 6, 2024 | `claude-1.2` | `claude-haiku-4-5-20251001` |
| November 6, 2024 | `claude-1.3` | `claude-haiku-4-5-20251001` |
| November 6, 2024 | `claude-instant-1.0` | `claude-haiku-4-5-20251001` |
| November 6, 2024 | `claude-instant-1.1` | `claude-haiku-4-5-20251001` |
| November 6, 2024 | `claude-instant-1.2` | `claude-haiku-4-5-20251001` |

### Migration checklists

Each guide covers Messages API code; Claude Code makes the API calls for the kit, so the API items matter to the kit only through Claude Code, and the behavior items are the ones that can change how a skill's text lands (DERIVED, not measured).

**Fable 5.1 and Mythos 5.1** — https://platform.claude.com/docs/en/models/fable-5-1/migration-guide

- [ ] Model name: "Update the model name from `claude-fable-5` to `claude-fable-5-1` (or `claude-mythos-5` to `claude-mythos-5-1`)."
- [ ] Price: "succeeds Claude Fable 5 at the same input and output prices, with cache reads at a quarter of the cost"
- [ ] Forced tools: "Replace forced `tool_choice` (`{type: "any"}` or `{type: "tool", ...}`). It returns a 400 error."
- [ ] Parallel calls: "Claude Fable 5.1 may issue one tool call per turn." / "Review agent loops for one-tool-call-per-turn behavior and add the batching instruction."
- [ ] Progress text: "Claude Fable 5.1 writes fewer status updates during long tool sequences than Claude Fable 5, and its agentic coding summaries are shorter."
- [ ] Low effort: "At `low` effort Claude Fable 5.1 answers from memory more often than Claude Fable 5 instead of calling a search or retrieval tool."
- [ ] Effort: "Re-evaluate `effort` with a fresh sweep, starting at `high`, and re-baseline cost and latency on your own workloads."

**Opus 5.5** — https://platform.claude.com/docs/en/models/opus-5-5/migration-guide

- [ ] Model name: "Update the model ID to `claude-opus-5-5`."
- [ ] Price: "Claude Opus 5.5 costs less than Claude Opus 5 ($4 / $20 USD per million input / output tokens, compared with $5 / $25"
- [ ] Effort: "Set `effort` explicitly: the default is `medium`, where Claude Opus 5's is `high`."
- [ ] Thinking: "Remove `thinking: {"type": "disabled"}` and `thinking: {"type": "enabled", ...}`; choose an effort level instead."
- [ ] Forced tools: "Replace `tool_choice` types `any` and `tool` with `auto` plus strict tool use or structured outputs, or with `auto` alone on Amazon Bedrock."
- [ ] Refusals: "Handle `stop_reason: "refusal"` and configure fallback."
- [ ] Cost: "Re-baseline cost and latency at your chosen effort level."

**Sonnet 5.5** — https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide

- [ ] Model name: "Change the model ID to `claude-sonnet-5-5`."
- [ ] Price: "Claude Sonnet 5.5 has the same prices as Claude Sonnet 5, except for prompt cache reads, which cost $0.10 USD per million tokens, half the Claude Sonnet 5 rate."
- [ ] Thinking: "On Claude Sonnet 5.5, a request with no `thinking` field runs with adaptive thinking, as does `thinking: {"type": "adaptive"}`."
- [ ] Forced tools: "Replace forced tool use with `auto` and strict tools, or with `auto` alone on Amazon Bedrock."
- [ ] Advisor: "With the advisor tool, a Claude Sonnet 5.5 executor needs one of these advisors: Claude Opus 5, Claude Opus 5.5, Claude Sonnet 5.5, Claude Fable 5, Claude Fable 5.1, Claude Mythos 5, or Claude Mythos 5.1."
- [ ] Effort: "Re-run your effort sweep, and re-baseline cost."

**Haiku 5.5** — https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide

- [ ] Model name: "Replace the model ID with the Claude Haiku 5.5 ID for your platform."
- [ ] Tokens: "the same text counts as more tokens and large images count as more visual tokens"
- [ ] Thinking: "If your requests send `thinking: {"type": "enabled", "budget_tokens": N}`, change `thinking` to `{"type": "adaptive"}`."
- [ ] Sampling: "Remove `temperature`, `top_p`, and `top_k` from your requests."
- [ ] Prefill: "If your requests end `messages` with an assistant turn for the model to continue, end them with a user turn instead."
- [ ] Refusals: "Claude Haiku 5.5 runs safety classifiers that can decline a request, and it has no server-side fallback"
