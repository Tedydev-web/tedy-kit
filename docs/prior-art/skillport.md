---
name: gotalab/skillport
pinned: https://github.com/gotalab/skillport/tree/51334ae94919fc1c261673ffefdce9176c9094ef
license: MIT
studied: 2026-10-28
channel: github
---

# gotalab/skillport

A CLI and MCP server that installs, indexes and validates Agent Skills. Studied for the canon (sweep `261021-canon`, pass 1): it machine-checks every SKILL.md against a written frontmatter standard and backs the checker with property-based negative tests.

## Evidence
- https://github.com/gotalab/skillport/blob/51334ae94919fc1c261673ffefdce9176c9094ef/packages/skillport-core/src/skillport/modules/skills/internal/validation.py#L13-L14 "NAME_MAX_LENGTH = 64 DESCRIPTION_MAX_LENGTH = 1024"
- https://github.com/gotalab/skillport/blob/51334ae94919fc1c261673ffefdce9176c9094ef/packages/skillport-core/src/skillport/modules/skills/internal/validation.py#L208 "frontmatter.name: cannot contain reserved word '{reserved}'"
- https://github.com/gotalab/skillport/blob/51334ae94919fc1c261673ffefdce9176c9094ef/packages/skillport-core/src/skillport/modules/skills/internal/validation.py#L246-L247 "# Unexpected keys → fatal (per Agent Skills spec) unexpected_keys = set(parsed_meta.keys()) - ALLOWED_FRONTMATTER_KEYS"
- https://github.com/gotalab/skillport/blob/51334ae94919fc1c261673ffefdce9176c9094ef/packages/skillport-core/src/skillport/modules/skills/internal/validation.py#L275-L276 "except Exception: pass # Skip if file cannot be parsed"
- https://github.com/gotalab/skillport/blob/51334ae94919fc1c261673ffefdce9176c9094ef/packages/skillport-core/src/skillport/modules/skills/internal/validation.py#L161-L164 "if lines and lines > SKILL_LINE_THRESHOLD: issues.append( ValidationIssue( severity="warning","
- https://github.com/gotalab/skillport/blob/51334ae94919fc1c261673ffefdce9176c9094ef/.skills/experimental/skill-evaluator/scripts/validate_skill.py#L397-L398 "passed=False, message=f"SKILL.md body exceeds 500 lines ({body_lines} lines)","
- https://github.com/gotalab/skillport/blob/51334ae94919fc1c261673ffefdce9176c9094ef/tests/pbt/test_name_properties.py#L61 "assert not _validate_name_chars(name), f"'{name}' should NOT pass validation""
- https://github.com/gotalab/skillport/blob/51334ae94919fc1c261673ffefdce9176c9094ef/tests/pbt/test_name_properties.py#L139-L140 "# Simulate normalization: strip + lower normalized_once = category.strip().lower()"
- https://github.com/gotalab/skillport/blob/51334ae94919fc1c261673ffefdce9176c9094ef/packages/skillport-core/src/skillport/interfaces/cli/commands/validate.py#L127-L128 "if not skills: msg = "No skills found""
- https://github.com/gotalab/skillport/blob/51334ae94919fc1c261673ffefdce9176c9094ef/.github/workflows/release.yml#L8 "description: 'Force publish to PyPI (skip release-please check)'"

## Issues and changelog
- https://github.com/gotalab/skillport/issues/73 "Without this change, skills using these new fields would fail validation with "unexpected field(s)" error."
  - Broke: Claude Code 2.1.0 added skill frontmatter fields (`model`, `context`, `agent`, `hooks`, `user-invocable`), and the strict key allow-list made every skill that used them fatal. Fixed: the keys were added as pass-through fields in 1.1.1, with docs and split tests in #74.
- https://github.com/gotalab/skillport/issues/83 "printed `Source not found` but exited `0`."
  - Broke: `skillport add --json` reported a failure in JSON and still exited 0, so CI could not see it. Fixed: a non-zero exit when no skill is added, with an integration test.
- https://github.com/gotalab/skillport/issues/51 "The tool incorrectly reports that the skill name in the frontmatter does not match the directory name, even when they are identical."
  - Broke: on Windows the name-equals-directory rule compared the name with a full backslash path and refused every `add`. Fixed: v0.6.1 compares with `Path.name`.

## Lessons
- Every rule of the written frontmatter standard is a checker branch with a field, a message and a severity (S12, S23); but `guide/cli.md:677-690` lists 10 fatal rules and omits the reserved-word and XML-tag rules the code enforces, so the doc and the checker drift apart with no test tying them. Touches README.md:191-195 (5 skill authoring rules) and plugin/tests/skill-size.test.mjs:8; gap: only size is checked, the 1,024-character description rule and the YAML-safety rule are not; low cost, one frontmatter test over plugin/skills/*/SKILL.md.
- One budget, two checkers, two severities (S22, S4): the shipped validator warns at 500 lines while the experimental evaluator script fails at 500, so whether a long skill passes depends on which copy runs. Touches plugin/tests/skill-size.test.mjs:8; overlap (one test, fails at 9,000 characters); none.
- A checker is shown to reject generated wrong input before it is trusted (S8): Hypothesis builds names with invalid characters and over-long names and asserts each is refused. The same file's normalisation tests assert a local `strip().lower()` instead of the code under test, so they cannot fail; a test must import what it guards. Touches plugin/tests (negative fixtures in sweep-record.test.mjs); overlap; none.
- A check that cannot read its input skips silently (S8): `except Exception: pass` drops the unexpected-key and compatibility checks when SKILL.md does not parse, and the skill passes. Touches plugin/lib/hook-io.mjs (a broken config turns every personal gate on, per hook-io.test.mjs); overlap; none.
- A run that finds nothing to check fails (S8, S13): `validate` exits 1 on "No skills found" and its JSON lists each skill with its failed checks, though it records no standard version per skill. Touches plugin/lib/sweep-record.mjs (`checkSweepFolder`); partial, sweeps and cards only, no per-artifact conformance report for skills or gates; medium cost.
- A strict allow-list over a platform-owned format breaks when the platform grows (S16): #73 had to add five Claude Code 2.1.0 keys after skills using them were refused. Touches plugin/evals/probes/run-probes.sh; partial, probes run by hand and none checks the skill frontmatter keys the platform accepts; low cost.
- The release tag and manifest version move together through release-please, yet a manual `force_publish` input publishes any named tag and skips that check (S15). Touches plugin/lib/profile.mjs:147-164 (release worktree at the recorded tag); gap: no test compares plugin.json version with the tag; low cost.
