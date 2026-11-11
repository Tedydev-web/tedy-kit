# 0020: An answer ticket from a client that reports no annotations needs the whole preview shown in the chat

Status: accepted 2026-11-11; live check pending (Consequences)

## Context
- ADR 0016 issues a one-use ticket only when AskUserQuestion's `tool_response.annotations[question].preview` equals the chosen option's preview: the terminal client reports which preview the user had in front of them.
- T3 Code returns `{questions, answers}` and no `annotations`. On 2026-11-11 the gate log held nine AskUserQuestion answers from T3 in answer mode, every one `"decision":"no-ticket"` with `response_keys: ["questions","answers"]`; at least one was a real publish approval (PR review comments), and its write was refused.
- A first fix (never released) took the chosen preview as shown whenever `annotations` was absent and `publishQuote` was on. An independent review failed it: the publish-quote gate counts every string in an AskUserQuestion input as shown, previews included, so it passed on the preview itself; and it judges only `github-write.mjs post|reply|edit`, leaving `pr-body`, `openproject.mjs`, `gdoc-comments.mjs`, `figma-comments.mjs` and `doc-comment-file.mjs` with no check of what the user saw.
- T3 Code issue 14237, closed 2026-10-20, says T3's Claude adapter dropped option previews before its question card, so until that fix a T3 user approved previews they never saw, and after it T3 still reports no annotations, so the kit cannot tell whether a preview was drawn.
- The absent key means the answering client attested nothing, not that the client is T3; any client that omits it is treated the same way.

## Decision
- A response that carries `annotations` (an object, `{}` and `null` included) is judged as ADR 0016 says; nothing changes for the terminal.
- A response with no `annotations` key gets a ticket only when the chosen option's whole preview, normalised as the ticket matcher does (quote marks dropped, whitespace folded, blank lines skipped), appears as a run of whole lines inside one block the question's own turn showed: one assistant text block of the main session (not a sidechain entry) that sits after the last user or tool-result entry before this call's own `tool_use` and before that `tool_use`, or one question, option label or description string of the call being answered. A draft quoted in an earlier turn, a quote followed by any tool call, and text written after the question do not count, so one approving click cannot mint a ticket for a draft the user rejected or one already posted. Option previews, thinking, any other tool's input, earlier AskUserQuestion calls (one may have failed validation and never been drawn) and user turns never count, and a preview stitched from two blocks does not match.
- The ticket hook reads at most the last 16 MB of the transcript; with a missing or unreadable transcript, or no entry for this call in it, only the call's own question, label and description strings count.
- A skill that asks for a publish approval quotes the whole preview verbatim, command line included, in one fenced block of its reply right before the question, with no tool call between (`plugin/shared/decision-points.md`, the review draft format and `/tedy:pending`); the scripts' refusal says so.

## Prior art

- anthropics/claude-code issue 108790 (proprietary, studied 2026-11-11, via github)
  - card: claude-code-surfaces
  - https://github.com/anthropics/claude-code/issues/108790 "The session was open in the Code tab and followed from the mobile app over Remote Control."
  - Lesson: a second client, the desktop Code tab (issue title: previews "are never drawn, yet the selected preview reaches the model"), has the same gap; the absent key is a client property, not a T3 one.
  - Taken: the rule keys on the absent `annotations`, not on the client's name.
- Claude Agent SDK, handle approvals and user input (Anthropic docs, studied 2026-11-11, via web)
  - https://code.claude.com/docs/en/agent-sdk/user-input "Return an `answers` object mapping each question’s `question` field to the selected option’s `label`"
  - Lesson: the documented host response lists `questions`, `answers` and `response` only, so an SDK host such as T3 has no documented way to report what it displayed.
  - Taken: the ticket hook cannot rely on annotations from SDK hosts.

no social prior art: 2026-11-11 x: "claude code AskUserQuestion preview not shown approve"; youtube: "claude code AskUserQuestion preview approval hook"

position: approval-to-absent-user conforms

## Consequences
- In T3 an approval is one AskUserQuestion after the reply quotes the preview, so the second prompt stays gone.
- The chat carries the command line and target of each write, which the user reads before approving.
- Markdown rendering can hide text in a reply as it can in a preview (an HTML comment, a collapsed details block). The hook does not check for a fence; the skill rule asks for one, which protects only against an agent that follows it. This is the same ceiling the README states for previews.
- The transcript becomes evidence, and the kit's deny rules protect only its state folders. Under `bypassPermissions` an agent could append a forged assistant line to the session transcript; that sits inside ADR 0016's accepted ceiling (in bypass mode a write outside the kit scripts meets no prompt either), and in other modes an Edit, Write or shell redirect into `~/.claude/projects` prompts.
- An answer given late (after the user was away) still counts, because the evidence is the question's own turn, not a time window. A quote followed by a tool call before the question does not count; the refusal then says to quote again, which costs one more question.
- Weakest link: the hook was exercised with transcript fixtures and the real T3 response shape from the gate log, not yet by a live T3 answer. The live check after release: one approving answer in T3 must log `"decision":"ticket"`.
