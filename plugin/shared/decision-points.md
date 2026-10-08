# Decision points

How every `/tedy:*` skill hands a decision to the user. The user's rules say when to ask; this file says how. The user should never have to type a command or compose an answer.

## Asking

- Write the short analysis in the reply first: what you found, the options, and which one you recommend and why. The question then refers to analysis the user has already seen.
- One `AskUserQuestion` call per topic, 1–4 questions per call, 2–4 options per question, header at most 12 characters.
- The recommended option comes first with `(Recommended)` in its label. Every option description states its consequence: what happens next and what it costs.
- Options come from what you found (draft numbers, PR numbers, file paths, map values), not from generic placeholders. The automatic "Other" field is where the user pastes a URL, a path or a sentence; mention that in the question when a free value is expected.
- Use `multiSelect: true` only when choices are independent, such as which draft comments to drop.
- A subagent cannot ask. The skill asks, then passes the answer on.
- Plan mode has its own approval flow; no menus there.

## The next-step menu

Every role skill ends a completed unit of work (a draft written, a review posted, a reconcile table produced) with one question, header `Bước tiếp`:

1. The recommended next step, with its consequence (for example "Review PR #712 kế tiếp đang chờ anh").
2. One real alternative drawn from the current state.
3. `Dừng ở đây`: end the turn with a summary of at least 80 characters that names what was done and what is pending.

Skip the menu only when the user's request already named the next step.

## When the question times out

- Local, reversible choice: take the recommended option and open the next reply with `Quyết định khi anh vắng: <choice>`.
- Publishing under the user's name, push, PR, merge, a scope cut: do nothing; list it as pending at the top of the next reply.
- Next-step menu: stop with the 80-character summary.
