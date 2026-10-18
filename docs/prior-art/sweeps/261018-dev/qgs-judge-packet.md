# QGS judge packet: product-is-the-mechanism repositories for test integrity

You are one of two independent judges building a quasi-gold standard (Zhang, Babar and Tell, IST 2011). The standard lists the repositories that a search for this stratum should find. Judge only from the candidate file and, when needed, the repository README. Never read `product-*.json`, `relevance-ranked-*.json`, `qgs-judge-*.jsonl` or any other report in this folder. The other judge works blind to you.

## Problems

- P1: A failing test is written and run before the implementation of a logic change or bug fix.
- P2: A test is never weakened, skipped or deleted to get green, and a run with zero tests is not green.

## Include (`yes`)

Include a repository only when all of these hold:

- it ships software that acts on its own, such as a hook program, CLI, plugin with hook or script code, library, MCP server or CI action, for an AI coding agent (Claude Code first, other harnesses count too);
- its own code enforces or checks P1 or P2. Examples: it blocks implementation edits until a failing test exists, it rejects edits that delete or skip tests, it fails a run that collected zero tests, or it verifies a red run before green.

## Exclude (`no`)

- Prompt-only material: skills, agents, commands, rules or CLAUDE.md text with no code that enforces anything.
- General test frameworks or test tools not built around an AI agent's behaviour.
- Lists, collections and marketplaces.
- Tools where testing is incidental to their purpose.

## Unsure

Use `unsure` only after you have read the README (`gh api -H "Accept: application/vnd.github.raw" repos/<repo>/readme`) and the README still does not settle it. Read the README for any line that does not settle the question by itself.

## Input and output

- Input: `the sweep folder: qgs-candidates.jsonl`. Each line has `id`, `repo`, `list`, `heading` and `line`.
- Output: `<out>.jsonl`, one object per candidate, `{"id": n, "repo": "...", "verdict": "yes|no|unsure", "readme": true|false, "why": "one short phrase"}`. Judge every candidate.
- Keep Bash commands simple: one `gh api` call per command, no heredocs, loops or `$(...)`. Write the output with the Write tool.
- End your reply with `Status: DONE | BLOCKED` and the counts of yes, no and unsure.
