---
name: agent-ecosystem/skill-validator
pinned: https://github.com/agent-ecosystem/skill-validator/tree/899dba96e0d0d7d964308ac4df9657c68f581347
license: MIT
studied: 2026-10-30
channel: github
---

# agent-ecosystem/skill-validator

A supplement of sweep 261021-canon, not reference-labelled: skill-validator, a Go CLI that checks one Agent Skills package (structure, front matter, links, token counts) and scores it with an optional LLM judge, studied for S32 (T1 footprint) because it counts a SKILL.md body and its `references/` files with the o200k_base tokenizer, warns on a body over 5,000 tokens or 500 lines, and errors on a reference over 25,000 tokens or all references over 50,000, with a distinct exit code per outcome (0 clean, 1 errors, 2 warnings only, 1 for warnings under `--strict`). It gates one skill folder at a time: a body over budget fails CI only when the pipeline treats exit 2 as failure or passes `--strict`, o200k_base is an OpenAI tokenizer standing in for Claude's, only top-level files of `references/` are counted as on-demand text, and nothing sums the descriptions of several skills into a listing total.

## Evidence
- https://github.com/agent-ecosystem/skill-validator/blob/899dba96e0d0d7d964308ac4df9657c68f581347/structure/tokens.go#L65 "cachedEnc, encoderErr = tokenizer.Get(tokenizer.O200kBase)"
- https://github.com/agent-ecosystem/skill-validator/blob/899dba96e0d0d7d964308ac4df9657c68f581347/structure/tokens.go#L89-L91 "if bodyCount > 5000 {"
- https://github.com/agent-ecosystem/skill-validator/blob/899dba96e0d0d7d964308ac4df9657c68f581347/structure/tokens.go#L97 "SKILL.md body is %d lines (spec recommends < 500)"
- https://github.com/agent-ecosystem/skill-validator/blob/899dba96e0d0d7d964308ac4df9657c68f581347/structure/tokens.go#L44 "refFileHardLimit = 25_000"
- https://github.com/agent-ecosystem/skill-validator/blob/899dba96e0d0d7d964308ac4df9657c68f581347/structure/tokens.go#L49 "refTotalHardLimit = 50_000"
- https://github.com/agent-ecosystem/skill-validator/blob/899dba96e0d0d7d964308ac4df9657c68f581347/structure/tokens.go#L131-L132 "if fileTokens > refFileHardLimit { results = append(results, ctx.ErrorFilef(relPath,"
- https://github.com/agent-ecosystem/skill-validator/blob/899dba96e0d0d7d964308ac4df9657c68f581347/structure/tokens.go#L172 "if refTotal > refTotalHardLimit {"
- https://github.com/agent-ecosystem/skill-validator/blob/899dba96e0d0d7d964308ac4df9657c68f581347/structure/tokens.go#L199 "if otherTotal > otherTotalHardLimit {"
  - Files outside the standard directories count as "other", erroring past 100,000 tokens in total (line 54).
- https://github.com/agent-ecosystem/skill-validator/blob/899dba96e0d0d7d964308ac4df9657c68f581347/structure/tokens.go#L102 "refsDir := filepath.Join(dir, "references")"
- https://github.com/agent-ecosystem/skill-validator/blob/899dba96e0d0d7d964308ac4df9657c68f581347/structure/tokens.go#L105 "if entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {"
  - Subdirectories of `references/` are skipped, and only files inside the skill folder are seen.
- https://github.com/agent-ecosystem/skill-validator/blob/899dba96e0d0d7d964308ac4df9657c68f581347/structure/frontmatter.go#L57 "utf8.RuneCountInString(desc); n > maxDescriptionChars {"
  - The description cap is 1,024 code points per skill (line 21), an error.
- https://github.com/agent-ecosystem/skill-validator/blob/899dba96e0d0d7d964308ac4df9657c68f581347/cmd/exitcode.go#L7-L10 "ExitClean = 0 // no errors, no warnings ExitError = 1 // validation errors present ExitWarning = 2 // warnings present, no errors"
- https://github.com/agent-ecosystem/skill-validator/blob/899dba96e0d0d7d964308ac4df9657c68f581347/cmd/exitcode.go#L33-L36 "if o.strict { return ExitError }"
- https://github.com/agent-ecosystem/skill-validator/blob/899dba96e0d0d7d964308ac4df9657c68f581347/cmd/check.go#L42 "treat warnings as errors (exit 1 instead of 2)"
- https://github.com/agent-ecosystem/skill-validator/blob/899dba96e0d0d7d964308ac4df9657c68f581347/README.md#L182 "This is useful in CI pipelines where you want a binary pass/fail:"

## Issues and changelog
Closed issues sorted by comments are mostly about directory layouts, Windows paths and the judge's provider, so these four were picked by relevance to footprint and exit policy. `CHANGELOG.md` lines 79-80 and 87 record issues 94 and 87.
- https://github.com/agent-ecosystem/skill-validator/issues/6 "This means you can't tell if there are warnings based on the status code for CI pipelines."
  - Broke: warnings exited 0, so a pipeline had to grep the output to see a size warning. Fixed: v0.7.0 exits 2 on warnings only and adds `--strict`, which turns warnings into exit 1.
- https://github.com/agent-ecosystem/skill-validator/issues/94 "Multibyte (CJK, emoji) descriptions are therefore rejected well below 1024 real characters."
  - Broke: the 1,024 cap counted UTF-8 bytes, so a 984-character description failed. Fixed: limits count code points, the unit of the spec's reference validator.
- https://github.com/agent-ecosystem/skill-validator/blob/899dba96e0d0d7d964308ac4df9657c68f581347/CHANGELOG.md#L79-L80 "Frontmatter length limits are now counted in characters (Unicode code points), not UTF-8 bytes"
- https://github.com/agent-ecosystem/skill-validator/issues/87 "a pathological multi-GB file in a skill package still gets fully loaded before the cap applies."
  - Broke: the 8 MiB token-count cap applied after the whole file was read. Fixed: every read is bounded and a truncated count is flagged as covering only a prefix (changelog line 87).
- https://github.com/agent-ecosystem/skill-validator/pull/83 "Explicitly selected, skill-relative subtrees are excluded from non-standard per-file token output"
  - Broke: committed generated output counted as instruction text in the "other" totals. Fixed: `--exclude-token-paths` drops chosen subtrees from the count and prints an info result when it does, so the exclusion stays visible.

## Lessons
- A body budget that only warns needs an exit policy that fails it (S32, Q9): exitcode.go lines 7-10 and 33-36, check.go line 42, issue 6. Touches plugin/tests/skill-size.test.mjs:15 (9,000 characters, a hard assert with no warning tier); overlap, the kit already fails; none.
- Count the on-demand text separately from the body, per file and in total (S32, Q9): tokens.go lines 44, 49, 131-132 and 172. Touches plugin/tests/skill-size.test.mjs:10-16 (SKILL.md only; `plugin/skills/{dev,pm,review-pr}/references/` and `plugin/shared/` are never measured); gap; low cost, a second assert summing each skill's references against a committed figure (T1). The kit's references are 362 to 10,170 bytes each, far under skill-validator's 25,000-token error, so its thresholds would never bind here; a ratchet at today's size would.
- A walk that sees only the skill folder misses shared on-demand text (S32, Q9): tokens.go lines 102-105. Touches plugin/skills/dev/SKILL.md:32 (reads `${CLAUDE_PLUGIN_ROOT}/shared/source-access.md` and `shared/decision-points.md`, outside any skill folder; `plugin/shared/` is 57,386 bytes); gap, running skill-validator on `plugin/skills/dev` would not count them; low cost if the kit test reads the paths each SKILL.md names.
- Count in the platform's unit and name it (S32, Q8, Q9): issue 94 (bytes against a characters limit), tokens.go line 65 (o200k_base as a proxy for Claude tokens). Touches plugin/lib/canon-checks.mjs:120 and plugin/tests/skill-size.test.mjs:13 (JavaScript `.length`, UTF-16 code units, characters not tokens); partial; none while kit text stays ASCII-heavy, and a token budget would still be a proxy whichever tokenizer the kit picks.
- An exclusion from a budget must be explicit and reported (S32, S8): PR 83. Touches plugin/tests/skill-size.test.mjs:12 (`applies(register, "skill-size", ...)` exempts files through the register); overlap; none.
- Not covered: the listing total across skills (Q8; one description at a time), always-on files (Q7), hook output (Q10), cache TTL or prefix order (Q1, Q3).
