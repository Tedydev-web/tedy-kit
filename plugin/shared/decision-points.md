# Decision points

How every `/tedy:*` skill hands a decision to the user. The user's rules say when to ask; this file says how. The user should never have to type a command or compose an answer.

## Asking

- Write the short analysis in the reply first: what you found, the options, and which one you recommend and why. The question then refers to analysis the user has already seen.
- One `AskUserQuestion` call per topic, 1–4 questions per call, 2–4 options per question, header at most 12 characters.
- The recommended option comes first with `(Recommended)` in its label. Every option description states its consequence: what happens next and what it costs.
- Options come from what you found (draft numbers, PR numbers, file paths, map values), not from generic placeholders. The automatic "Other" field is where the user pastes a URL, a path or a sentence; mention that in the question when a free value is expected.
- Use `multiSelect: true` only when choices are independent, such as which draft comments to drop.
- A subagent cannot ask. The skill asks, then passes the answer on.
- Publishing is never asked with `AskUserQuestion`. Lint the text, then show in the reply's own text, for each item the command publishes, one line naming where it goes, such as `PR #965 · 3 comments (head 788ac98f)`, `WP #21298 · comment` or `Figma <file> · reply`, then its full text verbatim: each review comment as `` **1.** `path:line` `` on its own line, then the comment and its PRD quote. Below the items put the lint's `warning:` lines, if any. Leave out the command line, the `pinned:` and `notice:` lines and any job or card path: the permission prompt shows the command. Run that command in the same turn. Its permission prompt (the kit's `permissions.ask` rules, or a git-gate ask) is the one approval (ADR 0022), so the reply is what the user reads. A "No" at the prompt with a typed note, or a request in chat, is how the user rewords, trims or holds: edit, lint, show it again and run again.
- Every kit write goes out through `publish-batch.mjs`, all writes of one turn in one batch, so every client's prompt shows what is published and the user approves the turn once. Write `batch.json` with the Write tool: `{ "items": [["openproject.mjs", "comment", "<id>", "--body-file", "<file>", "--apply"], …] }`, each item the write command the skill names, without `node` and the path (any `github-write.mjs`, `openproject.mjs`, `figma-comments.mjs`, `gdoc-comments.mjs` or `doc-comment-file.mjs` write; apply verbs keep `--apply`). Run `node <plugin>/scripts/publish-batch.mjs <batch.json> --summary`, which writes nothing and prints one summary line and the command; quote every item's full text as above, then run that command, `publish-batch.mjs <batch.json> --shows "<the summary line>"`, unchanged. The script and git-gate refuse a `--shows` that is not the batch's summary. It runs the items in order, each with its own checks, and stops at the first that fails, naming the items that ran.
- When a kit write is refused, fix what its refusal names (its last line names the check that refused: `refused by github-write`, `refused by pins`, `refused by publish-batch`), quote the text again and run the command again. Never change the kit's approval settings (`profile.mjs publish-approval`) to get past a refusal.
- Plan mode has its own approval flow; no menus there.

## Labels

Headers and option labels in the skills are keys such as `next.header` or `merge.yes`. `node <plugin>/scripts/labels.mjs` prints each key with its label in the user's chat language (`language.chat` in the profile config); put the label in the question verbatim, never the key.

## The next-step menu

Every role skill ends a completed unit of work (a draft written, a review posted, a reconcile table produced) with one question, header `next.header`:

1. The recommended next step, with its consequence (for example "Review PR #712, the next one waiting on the user").
2. One real alternative drawn from the current state.
3. `next.stop`: end the turn with a summary of at least 80 characters that names what was done and what is pending.

Skip the menu only when the user's request already named the next step.

## When the question times out

- Local, reversible choice: take the recommended option and open the next reply by naming the choice taken while the user was away (the user's rules may give the exact words).
- Publishing under the user's name, push, PR, merge, a scope cut: do nothing; list it as pending at the top of the next reply.
- Next-step menu: stop with the 80-character summary.
- Under Remote Control a question never times out and the session waits for the user. Do not ask there for a decision that should not wait: write it as a draft under `plans/drafts/` (`pending.mjs stub "<the question>"`), which `/tedy:pending` lists, and go on with the work that does not depend on it.
