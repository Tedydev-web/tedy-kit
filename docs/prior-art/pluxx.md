---
name: orchidautomation/pluxx
pinned: https://github.com/orchidautomation/pluxx/tree/80f67d2486e437e82839b06f2b7b9f9589b82b91
license: MIT
studied: 2026-10-28
channel: github
---

# orchidautomation/pluxx

A TypeScript compiler that builds one plugin source into Claude Code, Codex, Cursor, OpenCode and other host bundles. Studied for the canon (sweep `261021-canon`, pass 2): it claims a mechanism for over twenty registry problems, so each claim is checked here for real code against docs; its proof-freshness gate is the strongest of them.

## Evidence
- https://github.com/orchidautomation/pluxx/blob/80f67d2486e437e82839b06f2b7b9f9589b82b91/scripts/check-proof-freshness.ts#L38-L39 "const expectedTag = `v${packageJson.version}` const tagExists = git('tag', '--list', expectedTag) === expectedTag"
- https://github.com/orchidautomation/pluxx/blob/80f67d2486e437e82839b06f2b7b9f9589b82b91/src/proof-freshness.ts#L161 "if (receipt.freshness !== 'current') continue"
- https://github.com/orchidautomation/pluxx/blob/80f67d2486e437e82839b06f2b7b9f9589b82b91/src/proof-freshness.ts#L163 "problems.push(`Current receipt ${receipt.id} uses package ${receipt.packageVersion}; expected ${context.packageVersion}.`)"
- https://github.com/orchidautomation/pluxx/blob/80f67d2486e437e82839b06f2b7b9f9589b82b91/src/proof-freshness.ts#L167 "is not reachable from the current branch."
- https://github.com/orchidautomation/pluxx/blob/80f67d2486e437e82839b06f2b7b9f9589b82b91/src/proof-freshness.ts#L214 "if (/\bhistorical\b/i.test(line)) return"
- https://github.com/orchidautomation/pluxx/blob/80f67d2486e437e82839b06f2b7b9f9589b82b91/.github/workflows/ci.yml#L27-L28 "- name: Check proof freshness run: npm run proof:check"
- https://github.com/orchidautomation/pluxx/blob/80f67d2486e437e82839b06f2b7b9f9589b82b91/scripts/ensure-github-release-publish.mjs#L10-L11 "if (process.env.GITHUB_ACTIONS !== 'true') { failures.push('npm publish must run from GitHub Actions trusted publishing, not a local shell')"
- https://github.com/orchidautomation/pluxx/blob/80f67d2486e437e82839b06f2b7b9f9589b82b91/tests/build-cli.test.ts#L36 "it('fails build when lint has errors for the selected target', async () => {"
- https://github.com/orchidautomation/pluxx/blob/80f67d2486e437e82839b06f2b7b9f9589b82b91/tests/build.test.ts#L617 "expect(generated.content).not.toContain(SECRET_REFERENCE_SENTINEL)"
- https://github.com/orchidautomation/pluxx/blob/80f67d2486e437e82839b06f2b7b9f9589b82b91/tests/compatibility-matrix.test.ts#L24 "it('keeps docs/compatibility.md in sync with the renderer', () => {"
- https://github.com/orchidautomation/pluxx/blob/80f67d2486e437e82839b06f2b7b9f9589b82b91/docs/master-backlog.md#L7 "This path remains as a compatibility shim."
- https://github.com/orchidautomation/pluxx/blob/80f67d2486e437e82839b06f2b7b9f9589b82b91/TODO.md#L10 "This file remains a compatibility mirror of the current outstanding work."

## Issues and changelog
- https://github.com/orchidautomation/pluxx/issues/510 "Merge-SHA CI run 36935076752 failed at proof freshness before its build or tests."
  - Broke: a squash merge removed the commit the 0.1.46 receipt named, so the receipt was no longer reachable from main and tagging would have left an unusable immutable tag. Fixed: validation re-run on the exact squash commit and the receipt bound to it; the gate itself caught it.
- https://github.com/orchidautomation/pluxx/issues/463 "record that the first tag run failed closed before pack or publication"
  - Broke: release run for v0.1.38 failed in the test gate because a fixture inherited the new tag and tried to create it again. Fixed: tag-independent fixtures and recovery tests from a tagless exact-commit clone, without moving the immutable tag.
- https://github.com/orchidautomation/pluxx/issues/455 "Pluxx currently allows a product-owned runtime-env script to reintroduce shell execution"
  - Broke: a consumer's bundled `load-env.sh` shell-sourced `.env`, undoing the safe text parse of the generated wrapper. Fixed: PR #456 blocks unsafe env sourcing through the runtime script contract, which lint, doctor and install all read.

## Lessons
- A proof receipt marked current must match the package version, come from a commit reachable from the branch, pass every command, and for environment tiers be under 30 days old; CI runs this on every push and the release chain runs it first (S1, S2, S13): `check-proof-freshness.ts`, tested in tests/proof-freshness.test.ts. Touches plugin/lib/sweep-record.mjs (criteria pin) and the doctor release check at plugin/lib/profile.mjs:147-164; gap for eval and probe results, which carry no version or reachability check; medium cost.
- The waiver is too cheap: a receipt relabelled `historical` is skipped with no reason field, and any doc line that contains the word "historical" is exempt from the stale-version scan (S2, S25). Touches plugin/lib/prior-art.mjs:5 and plugin/lib/sweep-method-evidence.mjs:8 (GRANDFATHERED); partial (the sweep set keys a hash, the ADR set only names); low cost, require a reason per waiver.
- Publishing refuses outside the tagged release workflow (S15): `prepublishOnly` checks the workflow, ref type and that the tag equals `v` plus the package version; these are environment-variable checks a local shell can set, so the real boundary is trusted publishing. Touches plugin/.claude-plugin/plugin.json (0.2.12) and the doctor release check; gap (no test compares the manifest version with the tag); low cost.
- A gate is shown to fail on wrong input, and generated output is held to its renderer (S8, S12): the build lint gate has a negative test and the compatibility matrix doc must equal the renderer output. Touches plugin/tests (negative fixtures exist for the sweep gate); overlap; none.
- Generated bundles are scanned for a planted sentinel secret, so a literal secret value can never reach a build (S14). Touches plugin/lib/public-scan.mjs:7-13; overlap for published text, gap for a planted-sentinel test of each kit output; low cost.
- A moved file keeps a pointer shim, but a "compatibility mirror" that copies content rots (S19): docs/master-backlog.md only points at the new path, while TODO.md still holds its own list, dated 2026-05-01, five months before the pin. Touches plugin/tests/shim-parity.test.mjs and README.md two-line shims; overlap, keep shims pointer-only; none.
- Plan, review and receipt per ticket is a docs convention, not a check (S21, S20): docs/orchid holds 26 plans, 11 reviews and 5 receipts, so the claim that each ticket closes with all three does not hold in the tree, and the Claude hook probes (`scripts/probe-claude-hooks-runtime.ts`) have no step in ci.yml or release.yml and no npm script (S16). Touches the canon plan convention and plugin/evals/probes/run-probes.sh (run by hand); overlap in kind; none.
