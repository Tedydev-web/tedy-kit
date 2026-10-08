# Working rules

Always-on rules for every session. `profile.mjs init` copies this file to `<profile>/rules.md`; import it from `~/.claude/CLAUDE.md` with a line `@<profile>/rules.md`. `/tedy:learn` adds rules here; keep the file under 55 lines so it stays cheap to load.

## Ownership and approval
1. Anything published under the user's name (PR review comments, tracker tasks, Doc or Figma comments, messages to other teams) starts as a draft and is published only after the user approves it, because the user answers for every word that carries their name.
2. Merging, marking a PR ready, resolving review threads and pushing to an integration branch belong to the user.

## Evidence and conflicts
3. Raise a mismatch between sources (spec, design, backend, contract, frontend) in the same turn, quoting both sides, because the user picks the side.
4. Treat external reviews (bots, colleagues) as claims: verify each one with evidence, then change only what the user agreed to.

## Decisions
5. End a turn that needs the user's input with an AskUserQuestion call: options drawn from what you found, the recommended option first, each option stating its consequence.
