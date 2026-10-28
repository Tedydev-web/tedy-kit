---
name: fkiene/llmtrim
pinned: https://github.com/fkiene/llmtrim/tree/9586780b3ed9bae2592203b2d4f93ba7228f1a2a
license: MPL-2.0
studied: 2026-10-28
channel: github
---

# fkiene/llmtrim

A proxy and CLI that compresses LLM request input and output while leaving the cached prefix alone. Studied for the canon (sweep `261021-canon`, pass 1): it gates engine changes on a committed benchmark baseline, bills every bench case at pinned prices, and refuses a release unless CI is green on the pushed commit.

## Evidence
- https://github.com/fkiene/llmtrim/blob/9586780b3ed9bae2592203b2d4f93ba7228f1a2a/.github/workflows/bench-gate.yml#L1 "name: Bench gate (advisory)"
- https://github.com/fkiene/llmtrim/blob/9586780b3ed9bae2592203b2d4f93ba7228f1a2a/.github/workflows/bench-gate.yml#L4 "that llmtrim's DETERMINISTIC token-reduction numbers haven't drifted from bench/baseline.json."
- https://github.com/fkiene/llmtrim/blob/9586780b3ed9bae2592203b2d4f93ba7228f1a2a/.github/workflows/bench-gate.yml#L9 "This is ADVISORY: do NOT add "Bench gate" to branch protection's required checks."
- https://github.com/fkiene/llmtrim/blob/9586780b3ed9bae2592203b2d4f93ba7228f1a2a/.github/workflows/bench-gate.yml#L15 "commit the new baseline.json in the same PR, so the change is a reviewed line in the diff."
- https://github.com/fkiene/llmtrim/blob/9586780b3ed9bae2592203b2d4f93ba7228f1a2a/.github/workflows/bench-gate.yml#L68 "Benchmark corpora are unavailable upstream; skipping this advisory run."
- https://github.com/fkiene/llmtrim/blob/9586780b3ed9bae2592203b2d4f93ba7228f1a2a/crates/llmtrim-cli/bench/scripts/benchkit/gate.py#L75 "regression: {p} reduction {got:.1f}% vs baseline {exp:.1f}%"
- https://github.com/fkiene/llmtrim/blob/9586780b3ed9bae2592203b2d4f93ba7228f1a2a/crates/llmtrim-cli/bench/scripts/benchkit/gate.py#L57 "invariant: safe must be ~lossless (<1%), got {safe}"
- https://github.com/fkiene/llmtrim/blob/9586780b3ed9bae2592203b2d4f93ba7228f1a2a/crates/llmtrim-cli/bench/scripts/benchkit/gate.py#L11-L12 "Every committed corpus file's sha256 matches the manifest. Catches a swapped or edited corpus - the cheapest credibility check there is."
- https://github.com/fkiene/llmtrim/blob/9586780b3ed9bae2592203b2d4f93ba7228f1a2a/crates/llmtrim-cli/bench/scripts/benchkit/gate.py#L88 "Everything a third party needs to reproduce or distrust a number"
- https://github.com/fkiene/llmtrim/blob/9586780b3ed9bae2592203b2d4f93ba7228f1a2a/crates/llmtrim-cli/bench/scripts/benchkit/pricing.py#L11-L12 "if not p: raise SystemExit(f"no pricing for {lib.MODEL} in {PRICING}")"
- https://github.com/fkiene/llmtrim/blob/9586780b3ed9bae2592203b2d4f93ba7228f1a2a/release.toml#L16 "Hard gate: HEAD must be pushed and every CI check on it green before anything is"
- https://github.com/fkiene/llmtrim/blob/9586780b3ed9bae2592203b2d4f93ba7228f1a2a/tools/check_ci_green.sh#L31 "release blocked: no CI checks found for $HEAD"

## Issues and changelog
- https://github.com/fkiene/llmtrim/issues/289 "Expected: Explicit source-file reads should return the requested Java code intact"
  - Broke: tool-output compression trimmed Claude Code's reads of Java (later also TypeScript and Rust) source, and the agent fell back to 20-line reads and grep, spending more calls; the token-reduction gate counts saved tokens and could not see it. Fixed: #295 keeps source-file tool results intact.
- https://github.com/fkiene/llmtrim/issues/244 "existing turns recorded by 0.12.1 remain frozen with zero rates after upgrading to 0.12.2"
  - Broke: turns recorded before a model's price was known were stored at zero rates and dropped out of every spend and savings total. Fixed: #246 reprices zero-rate turns once pricing is known.

## Lessons
- A measured number is held to a committed baseline with a stated tolerance, and moving the baseline is a reviewed line in the same PR (S10, S8); here the gate is advisory, path-filtered, deterministic token counts only, with no API call and no quality score, and it is skipped when the corpora cannot be fetched. Touches docs/adr/0009-fact-based-ablation-evals.md:14 and `checkMeasuredAdrs` in plugin/lib/sweep-record.mjs; partial: the kit re-runs a pre-change arm per change and keeps no committed baseline to diff against; low cost.
- Relational invariants sit beside the baseline, so a broken engine fails even with a fresh baseline: `safe` stays lossless, `auto` compresses, `aggressive` is at least `auto` (S8). Touches plugin/evals graders (facts only, ADR 0009:15); gap, no case asserts an ordering between arms; low cost.
- A run proves its inputs and environment: corpus files match pinned sha256 hashes, results carry tool versions and the data fetch date, and a missing corpus skips the run with a warning instead of scoring it (S9, S30). Touches docs/adr/0010-dev-red-step-and-honest-green.md (grants stated, void batches recorded); overlap for void runs; gap for hashing fixtures; low cost.
- Every bench case is billed at rates from a pinned, dated pricing file, and a model with no price stops the run (S24); this is the cost of the request measured, not the spend of running the bench, and issue 244 shows an unknown price must not be stored as zero. Touches plugin/evals/probes/study/study_session.py:306-310 (per-call `total_cost_usd` ledger); overlap for run spend; none.
- A release is cut only from a commit equal to origin/main with every CI check completed green and a non-zero check count, and the tag is the shared workspace version (S15). Touches plugin/lib/profile.mjs:147-164 (release worktree at the recorded tag); partial: no CI-green or plugin.json-equals-tag check; low cost.
- A change measured only on its target metric hides harm to the task (S10): issue 289 cut tokens while making the agent re-read files. Touches docs/adr/0009-fact-based-ablation-evals.md:17 (success means beating the no-plugin arm on the task's graders); overlap; none.
