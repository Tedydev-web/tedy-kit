---
name: evidentloop/sopify
pinned: https://github.com/evidentloop/sopify/tree/9d9b319cb06713f3f9d695bf98f629e50291bba3
license: Apache-2.0
studied: 2026-10-28
channel: github
---

# evidentloop/sopify

A plan, handoff and evidence protocol installed as skills into Codex, Claude, Copilot and Cursor. Studied for the canon (sweep `261021-canon`, pass 1): it picks plan depth with a deterministic script, gates releases on doc links and version consistency, and records measured before/after payload sizes with the source revision.

## Evidence
- https://github.com/evidentloop/sopify/blob/9d9b319cb06713f3f9d695bf98f629e50291bba3/skills/en/skills/sopify/design/scripts/select_plan_level.py#L36-L37 "elif args.file_count > 5 or args.new_feature or args.cross_module: level = "standard""
- https://github.com/evidentloop/sopify/blob/9d9b319cb06713f3f9d695bf98f629e50291bba3/scripts/check-readme-links.py#L30 "Lock public-doc structure so CN/EN drift is caught by CI instead of by readers."
- https://github.com/evidentloop/sopify/blob/9d9b319cb06713f3f9d695bf98f629e50291bba3/scripts/check-readme-links.py#L234-L236 "if not resolved.exists(): errors.append( f"{path.relative_to(ROOT)}: relative link target not found -> {target}""
- https://github.com/evidentloop/sopify/blob/9d9b319cb06713f3f9d695bf98f629e50291bba3/tests/test_check_readme_links.py#L261-L263 "self.assertEqual(exit_code, 1) self.assertIn( "docs/how-sopify-works.en.md: relative link target not found -> ../docs/missing.md","
- https://github.com/evidentloop/sopify/blob/9d9b319cb06713f3f9d695bf98f629e50291bba3/scripts/check-version-consistency.sh#L157 "add_error "Version mismatch: CHANGELOG latest=$changelog_version, README badge=$readme_primary_version.""
- https://github.com/evidentloop/sopify/blob/9d9b319cb06713f3f9d695bf98f629e50291bba3/scripts/release-preflight.sh#L62-L65 "if ! python3 -m pytest "$ROOT_DIR/tests/test_golden_snapshots.py" -q 2>/dev/null; then echo "[release-preflight] Golden snapshots stale — regenerating..." python3 "$ROOT_DIR/scripts/regenerate-golden-snapshots.py" git add "$ROOT_DIR/tests/golden-snapshots.json""
- https://github.com/evidentloop/sopify/blob/9d9b319cb06713f3f9d695bf98f629e50291bba3/tests/test_golden_snapshots.py#L3-L4 "Compares sha256 hashes of all host install products (rendered from skills/) against the baseline recorded in tests/golden-snapshots.json."
- https://github.com/evidentloop/sopify/blob/9d9b319cb06713f3f9d695bf98f629e50291bba3/tests/protocol/test_convention_compliance.py#L6-L7 "Each test uses tmp_path to construct a minimal .sopify/ structure, ensuring no dependency on the runtime package."
- https://github.com/evidentloop/sopify/blob/9d9b319cb06713f3f9d695bf98f629e50291bba3/tests/behavior-scenarios/plain-language-output-v1.json#L2-L3 ""schema_version": 1, "source_revision":"
- https://github.com/evidentloop/sopify/blob/9d9b319cb06713f3f9d695bf98f629e50291bba3/tests/behavior-scenarios/plain-language-output-v1.json#L4-L9 ""copilot_baseline": { "zh-CN": {"characters": 36745, "bytes": 56414, "lines": 1919}, "en-US": {"characters": 60734, "bytes": 61071, "lines": 1918} }, "copilot_after": { "zh-CN": {"characters": 24154, "bytes": 41941, "lines": 1227},"
- https://github.com/evidentloop/sopify/blob/9d9b319cb06713f3f9d695bf98f629e50291bba3/CHANGELOG.md#L5 "Format: Summary → Changed → Plan Packages. File-level details live in `git log`."
- https://github.com/evidentloop/sopify/blob/9d9b319cb06713f3f9d695bf98f629e50291bba3/sopify_contracts/schemas/plan_md_sections.schema.json#L92 ""name": { "const": "Constraints / Not-in-scope" },"
## Issues and changelog
- https://github.com/evidentloop/sopify/issues/58 "They disagree on whether `plan_id` is allowed to be empty."
  - Broke: `write_history_receipt` built a path from an empty `plan_id` that its sibling writer refused, so a receipt could land in the month folder. Fixed: PR 59 added the guard and the same guard for an empty `month`, with two tests.
- https://github.com/evidentloop/sopify/issues/60 "The second `if not normalized: continue` can never fire."
  - Broke: the README link checker carried an unreachable empty-target guard placed after the prefix filter. Fixed: PR 61 removed it with no behaviour change; the link checker's tests stayed green.

## Lessons
- Plan depth is chosen by a script from stated signals (file count over 5, new feature, cross-module, architecture change), and the script prints its reasons (S28): `select_plan_level.py` returns light, standard or architecture. Touches plugin/skills/dev/SKILL.md and docs/prior-art/procedure.md; gap (registry: nothing); low cost, one stdlib function.
- Published docs are checked for relative links, anchors and heading order, and the checker's tests feed it a broken link and assert exit 1 (S6, S8): `check-readme-links.py` and its test run in the release preflight. Touches README.md and docs/; gap for S6 (no link check in the kit), overlap for S8; low cost.
- The release preflight fails when the CHANGELOG version, both README badges and the skill headers disagree (S15): `check-version-consistency.sh`. Touches plugin/lib/profile.mjs:160 (worktree tag) and plugin/.claude-plugin/plugin.json; partial (the doctor checks the worktree tag, but no test compares the manifest version with the tag); low cost.
- Counter-example: a gate must not refresh its own baseline when it fails (S8). The preflight regenerates stale golden snapshots and `git add`s them before re-checking, and the convention-compliance tests build their own fixture and match a regex against it without calling any production checker. Touches plugin/tests/sweep-record.test.mjs (its negative cases call the real checker); overlap; none, but worth a rule that a failing check never regenerates its own baseline.
- A measurement artifact records its schema version, the source revision it was measured on, and characters, bytes and lines of the always-loaded payload before and after the change (S1, S22): `plain-language-output-v1.json`. Touches plugin/tests/skill-size.test.mjs:11 (caps size, keeps no before/after) and docs/adr/0006-rules-size-budget.md; partial for S22, gap for S1 outside sweep records; low cost.
- Every changelog entry names the plan package that produced it (Summary, Changed, Plan Packages), and the plan schema fixes sections Context / Why, Scope, Constraints / Not-in-scope and Next in that order (S3, S21). Touches docs/prior-art/quality-criteria-v2.md (revision log, criteria only) and docs/adr/; partial for S3, overlap for S21 through the plan convention outside the kit; low cost.
- A fix to one writer's guard is applied to its sibling writer and to the next field with the same failure (S17): issue 58 and PR 59. Touches plugin/skills/dev/SKILL.md:37 (Blast radius steps); overlap; none.
- The reference's cites for S4 and S14 do not show the mechanism at this sha: `scripts/render-host-skills.py` says it is "NOT part of release / CI / pre-commit pipeline" (the CI guard is the golden snapshot test), and `skills/en/skills/sopify/references/output-contract.md` holds no desensitization rule. Touches plugin/lib/public-scan.mjs; overlap for S14 (the kit scans published text by machine); none.
