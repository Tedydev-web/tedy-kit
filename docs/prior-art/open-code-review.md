---
name: alibaba/open-code-review
pinned: https://github.com/alibaba/open-code-review/tree/b52b53b2b7763fddd38890ddacc3504e65b7535f
license: Apache-2.0
studied: 2026-11-03
channel: github
domains: qa, guardrails, cost
use-when: you design how a review agent picks files, accounts for coverage, locates line comments or filters false positives
---

# alibaba/open-code-review

Alibaba's AI code review CLI (`ocr`, Go), open-sourced from its internal reviewer, studied as the strongest example of putting deterministic engineering around a review agent: code chooses and bundles the files, matches per-path rules, re-locates comments by verbatim match and runs a fact-check pass, and the model only reviews. The user found it good but complex to use, and the source shows why: it is a separate Go binary needing Git 2.41 or later and its own LLM provider and API key unless you use delegation mode; it has four entry modes (`review`, `scan`, `delegate`, sessions with a browser viewer) and a `rule.json` per repository; `--background-file` aborts above 1 MiB raw or 8,000 characters; the skill and the CLI version independently, so the skill carries fallbacks for an older CLI; one marketplace file listed the Claude Code plugin inside Codex (#891); the GitHub Action hid progress (#1164); and users reported runs of 41.8M tokens (#1264) and 20 minutes for one commit (#1418). Worth taking: per-file reviewed-or-skipped accounting, the asymmetric fact-check filter, verbatim-excerpt relocation before any model call, and a secret-path gate no include glob can override.

## Evidence
- https://github.com/alibaba/open-code-review/blob/b52b53b2b7763fddd38890ddacc3504e65b7535f/README.md#L77 "selectively reviewing only some files and missing others."
- https://github.com/alibaba/open-code-review/blob/b52b53b2b7763fddd38890ddacc3504e65b7535f/README.md#L81 "The root cause: a purely language-driven architecture lacks hard constraints on the review process."
- https://github.com/alibaba/open-code-review/blob/b52b53b2b7763fddd38890ddacc3504e65b7535f/README.md#L55 "a deliberate trade-off favoring precision over noise."
- https://github.com/alibaba/open-code-review/blob/b52b53b2b7763fddd38890ddacc3504e65b7535f/plugins/open-code-review/skills/open-code-review-delegate/SKILL.md#L128 "Before reporting, verify that every previewed file is accounted for."
- https://github.com/alibaba/open-code-review/blob/b52b53b2b7763fddd38890ddacc3504e65b7535f/plugins/open-code-review/skills/open-code-review-delegate/SKILL.md#L173 "every `reviewable_files` entry must end as reviewed or explicitly skipped; do not silently omit files."
- https://github.com/alibaba/open-code-review/blob/b52b53b2b7763fddd38890ddacc3504e65b7535f/plugins/open-code-review/skills/open-code-review-delegate/SKILL.md#L168 "delegation mode never calls an LLM. All intelligence comes from the host agent."
- https://github.com/alibaba/open-code-review/blob/b52b53b2b7763fddd38890ddacc3504e65b7535f/internal/config/template/prompts/review_filter_task_system.md#L5 "remove only the comments that this diff **proves** to be factually wrong."
- https://github.com/alibaba/open-code-review/blob/b52b53b2b7763fddd38890ddacc3504e65b7535f/internal/config/template/prompts/review_filter_task_system.md#L10 "Removing a correct comment silently destroys a real finding."
- https://github.com/alibaba/open-code-review/blob/b52b53b2b7763fddd38890ddacc3504e65b7535f/internal/config/template/prompts/review_filter_task_system.md#L12 "So when your evidence falls short of proof, approve."
- https://github.com/alibaba/open-code-review/blob/b52b53b2b7763fddd38890ddacc3504e65b7535f/internal/config/template/prompts/main_task_system.md#L22 "Reviewing an implementation file does not cover its header, interface, or configuration counterpart"
- https://github.com/alibaba/open-code-review/blob/b52b53b2b7763fddd38890ddacc3504e65b7535f/internal/diff/resolver.go#L88 "So this runs first, and without a model: ExistingCode is a verbatim excerpt,"
- https://github.com/alibaba/open-code-review/blob/b52b53b2b7763fddd38890ddacc3504e65b7535f/internal/diff/resolver.go#L93 "Zero hits and multiple hits both decline, leaving cm untouched"
- https://github.com/alibaba/open-code-review/blob/b52b53b2b7763fddd38890ddacc3504e65b7535f/internal/config/template/prompts/plan_task_system.md#L36 "Do not invent issues to fill the list."
- https://github.com/alibaba/open-code-review/blob/b52b53b2b7763fddd38890ddacc3504e65b7535f/internal/agent/selection.go#L78 "no include glob can admit a credential path,"
- https://github.com/alibaba/open-code-review/blob/b52b53b2b7763fddd38890ddacc3504e65b7535f/.opencodereview/rule.json#L6 "merge_system_rule"

## Issues and changelog
- https://github.com/alibaba/open-code-review/issues/1454 "Consider failing (non-zero exit) when a PR-event review selects zero items from a non-empty diff"
  - Broke: reviews in CI ended in about 20 seconds with no items selected, exit 0 and nothing posted. The reporter later withdrew the fleet-wide claim (empty refs and their own scheduling); the real case was a test-only PR skipped once `**/test_*.py` joined the default excludes. Not fixed as asked: the maintainer saw no point in a non-zero exit on zero selection.
- https://github.com/alibaba/open-code-review/issues/1164 "No run through the GitHub Action can see that line."
  - Broke: when the grouping model call failed, review fell back to one subtask per file (188 conversations, 47 minutes) and said so only on a progress line the Action silences. Fixed in part: #1209 made the grouping reply integer indices instead of paths, about ten times smaller; no stop before dispatch was added.
- https://github.com/alibaba/open-code-review/issues/1195 "A complete changed-file review should not be confused with successful supporting-evidence access."
  - Broke: file counters read complete with exit 0 while required evidence under a git-ignored folder was never read, because range-mode tools see only the ref's tree. Not fixed: closed as not planned; the maintainer recommends inlining decisive evidence with `--background-file`, which cannot be missed, and keeps ref-pinned reviews reproducible from the ref pair.
- https://github.com/alibaba/open-code-review/issues/1240 "the harmless template is dropped while the file holding real secrets goes through"
  - Broke: dotfile and extensionless secrets (`.env`, `.netrc`, `id_rsa`) were selected and sent to the provider while `.env.example` was excluded. Fixed: `default_secret_patterns.json` plus an `.env` rule, checked ahead of user include and exclude, reported as its own reason.
- https://github.com/alibaba/open-code-review/issues/891 "add a Codex-native `.agents/plugins/marketplace.json` that lists only `open-code-review-codex`"
  - Broke: one `.claude-plugin/marketplace.json` served Claude Code and Codex, so Codex listed two plugins and users could install the wrong one. Fixed: a Codex-native marketplace file (`.agents/plugins/marketplace.json` exists at the pinned SHA).
- https://github.com/alibaba/open-code-review/issues/1264 "41078306 input + 743214 output = 41821520 total tokens"
  - Broke: a review of one squashed commit of 56 files spent 41.8M tokens over 946 tool calls before the user cancelled it. Not resolved in the thread: the maintainer asked for reproduction data and pointed to the AACR-Bench comparison.
- https://github.com/alibaba/open-code-review/issues/1418 "Just reviewing one commit takes over 20 minutes, and the token cost is 1.3 million."
  - Broke: slow, costly single-commit reviews; not reproduced on a small commit. Workaround offered: `ocr config set effort low`.

## Lessons
- Account for every reviewable file as reviewed or skipped with a reason: overlap with `plugin/agents/reviewer.md:33` and `:48` (`Read: <n> files; skipped: <files and why>`) and `plugin/skills/review-pr/SKILL.md:58` (every file in the diff was read); no change. OCR's main prompt adds that reviewing an implementation does not cover its header or config counterpart, worth one clause at `plugin/skills/review-pr/SKILL.md:31`; cost low.
- Asymmetric fact-check: drop a finding only when the diff proves it wrong, because a dropped true finding is invisible: touches `plugin/skills/review-pr/SKILL.md:33` ("Re-check each CONFIRMED finding yourself", no stated asymmetry) and `:34` (CONFIRMED or PLAUSIBLE); gap; cost low. State which way to err when re-checking a reviewer's finding.
- Locate a comment by matching its quoted code against the diff, without a model, declining on zero or several hits: touches `plugin/lib/draft-lint.mjs:138` (refuses a line outside the diff, but does not check that the quoted code sits on that line); gap; cost low.
- Precision over recall as a declared trade-off, with an empty result as a valid result: overlap with `plugin/skills/review-pr/references/stack-checks.md:63` (Not findings) and the CONFIRMED-only draft at `plugin/skills/review-pr/SKILL.md:35`; no change.
- Per-path review rules merged with the system rules: touches `plugin/skills/review-pr/SKILL.md:27` (one `review-calibration.md` per project map, not per path); partial; cost medium; adopt only if one project's rules start to differ by folder.
- Zero selected work is not a clean pass (#1454, #1195): overlap with `plugin/skills/dev/SKILL.md:38` (a run that executed 0 tests is not green); the review side has no equivalent for a PR whose diff the review read as empty; cost low.
- Do not ship a separate binary, provider config and multi-host manifests for review: not taken. The kit reviews in the session's own model through `tedy:reviewer`, which is OCR's delegation mode without the CLI; the cost of OCR's default mode is the complexity the user hit.
- Secret paths excluded ahead of any include glob: low relevance; the kit sends nothing to a third-party reviewer model. It applies if the kit ever adds an external review model.
