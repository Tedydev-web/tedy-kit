---
name: anthropics/claude-agent-sdk-python
pinned: https://github.com/anthropics/claude-agent-sdk-python/tree/c01a99416a02805b0a050d058da51bde53f6df64
license: MIT
studied: 2026-10-28
channel: github
---

# anthropics/claude-agent-sdk-python

The vendor's Python SDK for Claude Code. Studied for the canon (sweep `261021-canon`, pass 1): it keeps its own release and CI standard with machine checks, and names per rule which check enforces it.

## Evidence
- https://github.com/anthropics/claude-agent-sdk-python/blob/c01a99416a02805b0a050d058da51bde53f6df64/.github/scripts/check_workflow_hardening.py#L2 "Fail if a workflow job that calls Claude, or .github/egress-firewall.yaml, breaks a rule in CLAUDE.md,"
- https://github.com/anthropics/claude-agent-sdk-python/blob/c01a99416a02805b0a050d058da51bde53f6df64/CLAUDE.md#L72-L73 "fails when a job that runs the Claude Code action or mentions `ANTHROPIC_FEDERATION_RULE_ID` breaks protection 1 or 3,"
- https://github.com/anthropics/claude-agent-sdk-python/blob/c01a99416a02805b0a050d058da51bde53f6df64/CLAUDE.md#L75-L76 "It cannot see a job that calls Claude another way, so check new workflows by hand too."
- https://github.com/anthropics/claude-agent-sdk-python/blob/c01a99416a02805b0a050d058da51bde53f6df64/CLAUDE.md#L79 "Do not skip or weaken the check."
- https://github.com/anthropics/claude-agent-sdk-python/blob/c01a99416a02805b0a050d058da51bde53f6df64/CLAUDE.md#L58-L59 "Both jobs refuse that file unless it is a plain text file with no credential-like strings in it."
- https://github.com/anthropics/claude-agent-sdk-python/blob/c01a99416a02805b0a050d058da51bde53f6df64/scripts/_cli_version_validation.py#L18 ""latest" and "stable" are the installer's dist-tags, and they are *moving*:"
- https://github.com/anthropics/claude-agent-sdk-python/blob/c01a99416a02805b0a050d058da51bde53f6df64/.claude/skills/verify/SKILL.md#L60 "each must fail *before* any subprocess"
- https://github.com/anthropics/claude-agent-sdk-python/blob/c01a99416a02805b0a050d058da51bde53f6df64/src/claude_agent_sdk/testing/session_store_conformance.py#L3-L4 "assert the 14 behavioral contracts every adapter must satisfy."
- https://github.com/anthropics/claude-agent-sdk-python/blob/c01a99416a02805b0a050d058da51bde53f6df64/.github/workflows/publish.yml#L7 "Package version to publish (e.g., 0.1.4)"

## Issues and changelog
- https://github.com/anthropics/claude-agent-sdk-python/issues/1254 "projected usage is 47.567 GiB, exceeding the 47.5 GiB safety threshold"
  - Broke: the 0.2.153 release stopped at a pre-flight check of the PyPI storage quota after all five wheels built. Fixed: a maintainer action on the quota; the gate itself stayed, so a release never fails half-published.

## Lessons
- A rule of the standard names the check that enforces it, and the check names what it cannot see (S23): CLAUDE.md pairs each workflow protection with `check_workflow_hardening.py` and says jobs calling Claude another way need a hand check. Touches docs/adr/0006 and the rule-citations test; overlap for rules.md, gap for skills and gates, which state no enforcing check per rule; low cost, one `enforced by:` field per rule.
- Exemptions live in the check, each with its reason, and "do not skip or weaken the check" is part of the rule (S2, S25): `EXEMPT_FROM_FIREWALL_RUNNER` keys a job to a written reason. Touches plugin/lib/sweep-method-evidence.mjs (GRANDFATHERED holds a reason) and the gates; partial overlap; low cost.
- A pinned version is validated before anything is downloaded, and moving tags are refused (S5, S15): `_cli_version_validation.py` rejects `latest` and `stable` for the bundled CLI. Touches plugin/lib/profile.mjs:147-154 (release worktree check); overlap for the release tag, gap for pinned tool versions in evals; low cost.
- A validator is shown to fail on wrong inputs before its pass is trusted (S8): the verify skill drives each release validator under stubbed `curl` and `bash` with moving tags, garbage pins and empty bodies. Touches plugin/tests (negative fixtures exist for the sweep gate); overlap; none.
- Reusable checks ship as a parameterised conformance suite, not copies (S4): `run_session_store_conformance(MyStore)` serves every adapter. Touches plugin/evals/probes/study (topic configs); overlap for studies, gap for gates and roles; medium cost.
- A release refuses generated text unless it passes a content check (S14): the changelog Claude writes is accepted only as plain text with no credential-like strings, and the job that writes it holds no credentials. Touches plugin/lib/public-scan.mjs:7-13; overlap; none.
- A release gate checks a resource budget before publishing, so a release never lands half-way (S15): issue 1254. Touches the doctor release check; gap (no pre-flight budget check), low value for the kit today.
