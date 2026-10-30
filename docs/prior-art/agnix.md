---
name: agent-sh/agnix
pinned: https://github.com/agent-sh/agnix/tree/0247144e59ee88337cdecc832b887718dc2acc44
license: MIT OR Apache-2.0
studied: 2026-10-30
channel: github
---

# agent-sh/agnix

A supplement of sweep 261021-canon, not reference-labelled: agnix, a Rust linter for agent configuration files (CLAUDE.md, rules, MEMORY.md, SKILL.md, settings, hooks) across several clients, dual-licensed MIT or Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`, `Cargo.toml` `license = "MIT OR Apache-2.0"`; search A recorded Apache-2.0 alone). Studied for S32 (T1 footprint) because it warns on an instruction file over 200 lines, a MEMORY.md past its 200-line or 25 KB load limit, a skill listing entry over the 1,536-character cap and a SKILL.md body over 5,000 estimated tokens, and exits 1 on those warnings only under `--strict`. Its combined always-on figure and its total listing budget are `info` diagnostics that never fail a run, the listing budget counts only a project's `.claude/skills` (no plugin skills), token counts are characters divided by 4, and it checks the prompt-cache TTL settings for valid values only.

## Evidence
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-core/src/rules/claude_md.rs#L14-L16 "CC-MEM-014: an instruction file, or an `@path` import, over 200 lines"
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-core/src/schemas/claude_md.rs#L26 "pub const MAX_INSTRUCTION_FILE_LINES: usize = 200;"
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-core/src/schemas/claude_md.rs#L28-L32 "agnix heuristic for the combined length of the instruction"
  - CC-MEM-015's 400-line combined limit is agnix's own number: the platform warns past a combined limit it does not document.
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-core/src/rules/claude_md.rs#L599 "One file over the limit is CC-MEM-014's finding."
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-core/src/rules/claude_md.rs#L612-L616 "Diagnostic::info( path.to_path_buf(), 1, 0, "CC-MEM-015","
  - The combined always-on figure (CC-MEM-015) is reported at `info`, so even `--strict` never fails on it.
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-core/src/rules/claude_md.rs#L633-L637 "fn check_memory_index(path: &Path, content: &str, diagnostics: &mut Vec<Diagnostic>) {"
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-core/src/schemas/claude_md.rs#L38-L40 "the larger reading avoids false positives."
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-core/src/rules/skill/mod.rs#L1040-L1041 "the combined // `description` and `when_to_use` text is truncated at 1,536"
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-core/src/rules/skill/mod.rs#L1047 "let len = description_trimmed.chars().count();"
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-core/src/rules/skill/mod.rs#L1054-L1058 "Diagnostic::warning( self.path.to_path_buf(), description_line, description_col, "AS-008","
  - AS-008 for a Claude Code skill: a warning past the 1,536 cap (or `skillListingMaxDescChars` from the nearest settings), only `info` between 1,024 and 1,536.
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-core/src/rules/skill/claude_ext.rs#L23 "assumes a 200,000-token window and 4 characters per token, so 1% is about"
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-core/src/rules/skill/claude_ext.rs#L499-L500 "CC-SK-025: the project's `.claude/skills` listing is estimated over the"
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-core/src/rules/skill/claude_ext.rs#L575-L579 "Diagnostic::info( self.path.to_path_buf(), 1, 1, "CC-SK-025","
  - The total listing budget (CC-SK-025) is `info` too, and returns early unless the skill sits under `.claude/skills` (lines 511-517).
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-core/src/rules/skill/portable.rs#L491-L493 "AS-021: SKILL.md body over the spec's 5,000-token recommendation."
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-core/src/rules/skill/portable.rs#L502 "let tokens = body.chars().count() / 4;"
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-cli/src/main.rs#L763-L765 "if has_errors || (cli.strict && has_warnings) {"
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/crates/agnix-core/src/rules/claude_settings.rs#L30-L31 "`promptCacheTtl` enum (CC-SET-026, added in Claude Code v2.1.242)."
  - A value check only; no rule in `crates/agnix-core/src/rules` reads a Claude hook's `additionalContext` (the word appears only in the Codex hooks rule file).

## Issues and changelog
Closed issues sorted by comments are mostly bot "Spec Drift Detected" and "Tool release" tickets, so the three below were picked by relevance to the footprint rules. `CHANGELOG.md` lines 114, 137 and 962 below.
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/CHANGELOG.md#L114 "always-loaded instructions over 400 lines in total (an agnix heuristic)"
  - Broke: nothing reported the combined size. Fixed: 0.59.0 (2026-10-17) adds CC-MEM-015 to CC-MEM-021, the combined figure at `info`.
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/CHANGELOG.md#L137 "CC-MEM-009 (unsourced 1,500-token budget; CC-MEM-014 covers size)"
  - Broke: a token budget with no documented source. Fixed: retired in 0.59.0; size rests on the documented 200-line figure.
- https://github.com/agent-sh/agnix/blob/0247144e59ee88337cdecc832b887718dc2acc44/CHANGELOG.md#L962 "**CC-MEM-014 fired on Cursor `.mdc` files**."
  - Broke: the 200-line Claude rule ran on Cursor rules, which document 500. Fixed: 0.44.0 scopes CC-MEM-014 to Claude memory files.
- https://github.com/agent-sh/agnix/pull/887 "Align CC-MEM-014's `bad_example` in `knowledge-base/rules.json` (line 2615) with the documented 200-line CLAUDE.md recommendation."
  - Broke: the rule page said "500+ lines" while the code enforced 200. Fixed: the example and the generated page now say 200; frozen versioned docs keep the old text.
- https://github.com/agent-sh/agnix/issues/1738 "AS-015 now respects ignored payloads."
  - Broke: AS-015 summed a skill folder's size including a gitignored `node_modules` that the file walk skips, so it failed a skill on bytes nothing loads. Fixed: PR 1739 counts only what the walk keeps.
- https://github.com/agent-sh/agnix/pull/1416 "add CC-SET-026/027 for main and subagent prompt-cache TTL enums"
  - Broke: `promptCacheTtl` and `subagentPromptCacheTtl` values went unchecked. Fixed: enum validation only; which TTL pays off is not judged.

## Lessons
- A footprint limit fails a run only when its severity and the exit policy say so (S32, Q7, Q8, Q9): main.rs lines 763-765, claude_md.rs lines 612-616, claude_ext.rs lines 575-579. Touches plugin/tests/skill-size.test.mjs:15 (a plain `node:test` assert, always failing) and plugin/lib/canon-checks.mjs:120 (description error, always failing); overlap, the kit is stricter than agnix by default; none.
- The combined always-on figure is computed but never fails, and its 400-line threshold is the tool's own guess (S32, Q7): schemas/claude_md.rs lines 28-32, claude_md.rs lines 599-616, changelog line 114. Touches docs/adr/0006-rules-size-budget.md:16 (6,000 bytes for the tedy rules file only, via `profile.mjs doctor`); gap for a committed total that may only shrink (T1); low cost, one test summing the kit's always-on text against a committed figure set at today's size, which is exactly what agnix stops short of.
- The listing budget is counted as name plus description plus `when_to_use`, each entry capped at 1,536, total against an assumed 8,000 characters (S32, Q8): claude_ext.rs lines 21-25 and 499-579. Touches plugin/lib/canon-checks.mjs:116-124 (per-description cap under 1,024, no total); gap for the total, overlap for the per-entry cap; low cost. agnix's total skips plugin skills, so it would not see the kit at all; the kit's own test must sum `plugin/skills/*/SKILL.md` descriptions.
- Count in the unit the platform counts, and say which (S32, Q8, Q9): mod.rs line 1047 counts `chars()`, portable.rs line 502 estimates tokens as characters over 4, CC-MEM-016 picks the larger reading of 25 KB to avoid false positives (schemas/claude_md.rs lines 38-40). Touches plugin/tests/skill-size.test.mjs:13 and plugin/lib/canon-checks.mjs:120 (JavaScript `.length`, UTF-16 code units); partial; none for ASCII text, a one-word change if a budget ever needs code points.
- A size rule must count only what is loaded, and its page must match its code (S32, S8): issue 1738 (gitignored payload counted), PR 887 (doc said 500, code 200), changelog line 962 (rule run on the wrong client). Touches plugin/tests/skill-size.test.mjs:12 (`applies(register, "skill-size", ...)` picks the files) and docs/adr/0006-rules-size-budget.md:16; overlap; none.
- Not covered: hook output size or repetition (Q10; no Claude `additionalContext` rule), whether a cache TTL pays off (Q1; CC-SET-026/027 check the enum only), plugin skills in the listing total, duplicated blocks across always-on files (Q7).
