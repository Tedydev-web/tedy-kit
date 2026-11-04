# 0016: Publish approval by a one-use answer ticket stays opt-in, because it is weaker than an ask rule

Status: accepted (built 2026-10-22 in ceec792, recorded 2026-11-04)

## Context
- In the default mode, `gates.publishApproval: "ask"`, a publish is approved twice: the user picks an option in the skill's AskUserQuestion menu, then a `permissions.ask` rule on the kit's publish script prompts again before the write.
- Commit ceec792 added `gates.publishApproval: "answer"` to remove the second prompt. A PostToolUse hook on AskUserQuestion writes a one-use ticket holding the chosen option's preview, and each kit publish script writes only when a ticket matches the exact text it publishes. `profile.mjs publish-approval answer|ask` removes or restores the 22 kit publish ask rules in `~/.claude/settings.json`.
- No ADR recorded the mode. A 2026-11-04 audit of the kit against its knowledge base found the gap, together with the mode's limits, which the README already states:
  - the ticket check lives in the kit scripts, so a write that does not go through them (`gh` directly with `gates.ghWrites` off, `curl` to a tracker or design API, a copied script with the check removed) meets no ticket check and, under `bypassPermissions`, no prompt either;
  - the ticket hook reads the answer from AskUserQuestion's `tool_response`, which a headless run cannot produce, so it was not checked live.

## Decision
- `"ask"` stays the default. An explicit ask rule is the one approval stop that no permission mode auto-approves, `bypassPermissions` included.
- `"answer"` stays available as an opt-in for a user who accepts the narrower guarantee in return for one prompt instead of two. Its guarantee covers only writes made through the kit's publish scripts.
- A change that widens what answer mode lets through, or makes it the default, needs a new ADR and a live check of the ticket hook in an interactive session.

## Prior art

- Claude Code permission modes docs (Anthropic docs, studied 2026-11-04, via web)
  - https://code.claude.com/docs/en/permission-modes "Claude Code doesn’t auto-approve the following in any mode, including `bypassPermissions`"
  - Lesson: the first item on that list is "Tools matched by an explicit ask rule"; a hook decision or a script-side check is not on it.
  - Taken: ask rules stay the default stop; answer mode is documented as weaker.
- GitHub Copilot cloud agent, risks and mitigations (GitHub docs, studied 2026-11-04, via web)
  - https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations "Draft pull requests created by Copilot cloud agent must be reviewed and merged by a human."
  - Lesson: a production agent keeps the human's approval in a control the agent cannot satisfy itself.
  - Not taken: a server-side control; the kit's writes use the user's own credentials, so the strongest local stop is the ask rule.

no social prior art: 2026-11-04 x: "claude code approval ticket bypassPermissions publish"; youtube: "claude code approve before publish permission ask rule hook"

position: approval-to-absent-user conforms

## Consequences
- The default mode keeps two prompts per publish; the knowledge base's approval position ranks that as the stronger shape.
- A user who switches to answer mode must keep `gates.ghWrites` on and avoid `bypassPermissions` if writes outside the kit scripts are possible.
- Weakest link: the ticket hook has not run live, so answer mode's own guarantee is unproven end to end.
