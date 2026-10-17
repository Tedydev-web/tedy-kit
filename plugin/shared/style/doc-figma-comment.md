# Google Doc and Figma comment style

Default samples for comments on the PRD Doc and on Figma frames. A profile copy at `<profile>/style/doc-figma-comment.md` replaces this file. `draft-lint.mjs doc-comment` and `figma-comment` enforce the mechanical half for the map's `language.doc_figma`.

## Who reads it

The PM and the designer are not developers. PRD, Figma and the PM's answers are the source of truth the team starts from, so a comment talks about that truth only: a business rule that changes, or a place in the Doc or the frame that is missing, wrong, redundant, contradictory, infeasible or illogical. How the app is built (backend, contract, network internals, versions, API) never appears as a cause. Translate it into what the person using the app sees or cannot do; if it changes nothing they see, it is not a comment for the PM. The technical reason goes in the item's `note`, which shows on the HTML card for the user and is never posted.

Shape of one comment, one change per comment:

1. Where: the UC and one or two places (`BR6`, `step 5`), or the frame.
2. What is off, in product words: missing, wrong, redundant, out of step, not feasible.
3. One concrete case the app user would meet, with real names or numbers.
4. One ask: a decision with numbered options, a confirmation, or a request to write something into the Doc.

Before showing the cards, read each one as the PM: can they act on it without asking a dev what a word means? Several places that need the same change are one comment per place, or one comment that names the rule once and lists at most three places; seven places in one thread cannot be ticked off one by one.

## Doc (PRD threads)

- A quick note between teammates: what the PRD says, what is unclear, and the one decision asked for. Tag nobody; the PM reads the thread.
- New questions go into a file the user highlights and comments from; reply directly only on a thread about the same topic.

## Figma (frame comments)

- Open with the @handle of whoever owns the fix, then the change asked for, in one or two sentences.
- Link the frame, never a bare node id.

## Samples

### 1. Doc, two options and a decision asked

```text
UC_CT_02 BR9 says the limit counts saved carts, the frame counts open ones. Which one should the pop-up use?
```

### 2. Doc, reading to confirm

```text
Reading BR3 as: a refunded order still counts toward the monthly total. Is that right?
```

### 3. Figma, change request

```text
@designer.lan Should the hint say "shop" instead of "store", like the other settings screens?
```

### 4. Figma, product question to the PM

```text
@pm_minh The empty state here has no action; should it offer New cart like the Carts header?
```

## Avoid

| Pattern | Why |
|---|---|
| Greetings and thanks | The comment is read in a list of many |
| Build words as the cause: BE, FE, API, contract, on-chain, a version number | The PM acts on business rules only; the lint refuses these words outside quotes |
| One thread listing many places to fix | The user ticks threads off one by one, so one comment carries one change |
| Arrows `→` `↔` and code-like shorthand | Read as code by a non-developer; write the change out in words |
| Resolving a thread, including one the agent opened | Open threads are the user's checklist |
| Replying under a thread on a different topic | A new question goes to an HTML file with the verified highlighted passage, then is posted anchored on it after the user approves |
| Reposting answered threads after a Figma restyle | Only unanswered threads are reposted |
| Paraphrased UI copy | Copy is quoted exactly so the designer can search the frame for it |
| A bare node id instead of the frame link | Figma cannot search by node id |
