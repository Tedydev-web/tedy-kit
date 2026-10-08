# Google Doc and Figma comment style

Default samples for comments on the PRD Doc and on Figma frames. A profile copy at `<profile>/style/doc-figma-comment.md` replaces this file. `draft-lint.mjs doc-comment` and `figma-comment` enforce the mechanical half for the map's `language.doc_figma`.

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
| Resolving a thread, including one the agent opened | Open threads are the user's checklist |
| A bare node id instead of the frame link | Figma cannot search by node id |
