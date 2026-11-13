# Decision points

How every `/tedy:*` skill hands a decision to the user. The user's rules say when to ask; this file says how. The user should never have to type a command or compose an answer.

## Asking

- In a job (`shared/jobs.md`), never call `AskUserQuestion`. Decide each local, reversible choice yourself, the next-step menu included, and record it with its reason in the job's outcome; only a decision the user must make (`shared/jobs.md`, Job 2) becomes a `question` card, which the cockpit asks.
- Write the short analysis in the reply first: what you found, the options, and which one you recommend and why. The question then refers to analysis the user has already seen.
- One `AskUserQuestion` call per topic, 1–4 questions per call, 2–4 options per question, header at most 12 characters.
- The recommended option comes first with `(Recommended)` in its label. Every option description states its consequence: what happens next and what it costs.
- Options come from what you found (draft numbers, PR numbers, file paths, map values), not from generic placeholders. The automatic "Other" field is where the user pastes a URL, a path or a sentence; mention that in the question when a free value is expected.
- Use `multiSelect: true` only when choices are independent, such as which draft comments to drop.
- A subagent cannot ask. The skill asks, then passes the answer on.
- Publishing is never asked with `AskUserQuestion`. Lint the text, then quote everything the command publishes verbatim in one fenced block of the reply, with the lint's `pinned:`, `warning:` and `notice:` lines and the exact command on a line of its own, and run that command in the same turn. Its permission prompt (the kit's `permissions.ask` rules, or a git-gate ask) is the one approval (ADR 0022); the prompt shows only the command, so the quote is what the user reads. A "No" at the prompt with a typed note, or a request in chat, is how the user rewords, trims or holds: edit, lint, quote again and run again.
- Two or more comment writes of one turn go out as one `publish-batch.mjs <batch.json>` run, so the user approves the turn once: `batch.json` is `{ "items": [["openproject.mjs", "comment", "<id>", "--body-file", "<file>", "--apply"], …] }`, holding only `openproject.mjs comment|comment-edit`, `figma-comments.mjs post|reply`, `gdoc-comments.mjs reply|anchor|edit` and `github-write.mjs post|reply|resolve|unresolve|minimize`, each written as its own command would be. Quote every item's full text as above, then run `node <plugin>/scripts/publish-batch.mjs <batch.json>`. Its prompt names each item with the first line of its text; it stops at the first item that fails and says which items ran. Work-package writes (`openproject.mjs apply`, `set`), PR bodies and the Doc comment file keep their own command.
- When a kit write is refused, fix what its refusal names (its last line names the check that refused: `refused by github-write`, `refused by pins`, `card refused by card-check`), quote the text again and run the command again. Never change the kit's approval settings (`profile.mjs publish-approval`) to get past a refusal.
- Plan mode has its own approval flow; no menus there.

## Labels

Headers and option labels in the skills are keys such as `next.header` or `merge.yes`. `node <plugin>/scripts/labels.mjs` prints each key with its label in the user's chat language (`language.chat` in the profile config); put the label in the question verbatim, never the key.

## The next-step menu

Every role skill ends a completed unit of work (a draft written, a review posted, a reconcile table produced) with one question, header `next.header`:

1. The recommended next step, with its consequence (for example "Review PR #712, the next one waiting on the user").
2. One real alternative drawn from the current state.
3. `next.stop`: end the turn with a summary of at least 80 characters that names what was done and what is pending.

Skip the menu only when the user's request already named the next step. A job asks no menu: it puts the recommended next step and the alternative in its outcome and ends, and the cockpit tells the user.

## When the question times out

- Local, reversible choice: take the recommended option and open the next reply by naming the choice taken while the user was away (the user's rules may give the exact words).
- Publishing under the user's name, push, PR, merge, a scope cut: do nothing; list it as pending at the top of the next reply.
- Next-step menu: stop with the 80-character summary.
- Under Remote Control a question never times out and the session waits for the user. Do not ask there for a decision that should not wait: write it as a card (`pending.mjs card question …`, or `card publish …` for a write), which stays on disk and is asked again when the cockpit next lists its cards, and go on with the work that does not depend on it. A job never asks the user (`shared/jobs.md`, Job 2).
