# 0017: Position pages state the best current method per design question, and a lint keeps them honest

Status: accepted (2026-11-04)

## Context
- The knowledge base held 45 public cards and 360 private notes, indexed by domain. It could say which source is good and what its code does, but not which method is best for a question the kit meets again.
- The session-model question of 2026-11-03 showed the cost. Before that study, 28 relevant notes already existed and nobody assembled them. One of them, which advised long-lived sessions, contradicted the others unnoticed. The kit's own role-per-session design (ADR 0003) went against the notes until the user raised the pain.
- A 2026-11-04 audit of the kit against the notes found 15 places where the kit disagreed with a note, 10 note pairs that disagreed with each other, and no ADR or skill that named a note. Its findings grouped into ten recurring design questions.
- A pilot page for the session question, then nine more, showed the shape works. A lint caught a contradicting note dropped from a page, and the pages surfaced kit deviations that were then fixed or recorded: ADRs 0010 and 0016, the link parser, the rules template and the gate notes.

## Decision
- One position page per recurring design question, in `docs/prior-art/private/positions/<slug>.md`, kept private because it cites private notes. Its parts:
  - the method as a claim;
  - a ring (`adopt`, `trial`, `assess`, `hold`), gated by known uses;
  - a certainty graded apart from the ring;
  - the kit's status, conforms or deviates with the ADR named;
  - the notes it derives from;
  - a required dissent section;
  - a dated list of moves.

  The format and rules are in `docs/prior-art/procedure.md`.
- Notes name the pages they bear on with `positions:`. A note read after a page's review that shares the page's domain must carry the field, or `positions: none`.
- `plugin/lib/positions.mjs` lints the pages against the notes, and `prior-art-index.mjs check` and `write` exit 1 while a page is pending. A page is pending when:
  - a note names it but the page cites it nowhere;
  - a cited note was read after the review;
  - an untriaged new note sits in its domain;
  - its dissent is empty;
  - its ring gate fails.

  The private index lists the pages first, so the instruction to read the index before designing reaches the answer before the raw notes.
- From ADR 0017 on, the `## Prior art` section carries `position: <slug> conforms`, `position: <slug> deviates: <reason>` or `position: none (<why>)`. `plugin/tests/adr-prior-art.test.mjs` requires the line, and checks the slug where the pages exist.
- A ring or kit-status move waits for the user. The lint marks a page pending and never moves it.
- The rule enters `docs/canon/standard.json` in the next standard version, as ADR 0014 did for its techniques.

## Prior art

- GRADE handbook (GRADE Working Group, studied 2026-11-04, via web)
  - https://gdt.gradepro.org/app/handbook/handbook.html "Quality of evidence is a continuum; any discrete categorisation involves some degree of arbitrariness."
  - Lesson: certainty of evidence is graded in a few named levels and kept apart from the strength of a recommendation.
  - Taken: `certainty` uses GRADE's four levels with the downgrades named, separate from `ring`.
- Andrej Karpathy on LLM knowledge bases (public post, studied 2026-11-04, via x)
  - https://x.com/karpathy/status/2039805659525644595 "Something I'm finding very useful recently: using LLMs to build personal knowledge bases for various topics of research interest."
  - Lesson: raw sources are compiled into maintained pages an agent reads, instead of re-synthesizing from the raw sources each time.
  - Taken: pages over the notes, written by the agent and approved by the user. Not taken: compiling all notes into a wiki, which flattens dissent.

position: none (no page yet covers how the knowledge base itself is synthesized; this ADR creates the pages)

## Consequences
- A kit change on a known question starts from the page. A new note in the page's domain cannot stay unseen, because the lint stops `check` until the note is triaged.
- Pages are private, so a fresh clone has the code, tests and procedure but no pages. The local lint test is skipped there.
- Ten pages now exist, all `adopt` with low certainty, for the same reasons: vendor-reported known uses and no one-person measurement.
- Weakest link: no source measures whether position pages improve an agent's design decisions. The one measured maintenance result for living syntheses (Cochrane COVID-19 reviews, in the research note `living-mode-needs-entry-exit-criteria-and-capacity`) shows they go stale for lack of capacity. The design leans on the lint and on one page per question, not on diligence.
