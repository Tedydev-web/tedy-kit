---
name: tigerless-labs/cost-xray
pinned: https://github.com/tigerless-labs/cost-xray/tree/906ce15d931b8e145b5ed59c63f65eebe1d9f0a6
license: MIT
studied: 2026-10-28
channel: github
---

# tigerless-labs/cost-xray

A supplement of sweep 261021-canon, not reference-labelled: a local proxy that splits every Claude Code and Codex request into what took its context and its cost, studied for S32 because it measures quota spend per artifact (MCP server, skill advertisement, skill load, 1-hour cache write), though it reports and never fails an artifact.

## Evidence
- https://github.com/tigerless-labs/cost-xray/blob/906ce15d931b8e145b5ed59c63f65eebe1d9f0a6/cost_xray/analyze.py#L126-L127 "unused = [s for s in server_list if not s["used"]] unused_tok = sum(s["tokens"] for s in unused)"
- https://github.com/tigerless-labs/cost-xray/blob/906ce15d931b8e145b5ed59c63f65eebe1d9f0a6/cost_xray/analyze.py#L143-L144 ""savings": { "unused_mcp_servers": ["
- https://github.com/tigerless-labs/cost-xray/blob/906ce15d931b8e145b5ed59c63f65eebe1d9f0a6/cost_xray/detectors.py#L26 "out.append({"name": name, "description": desc, "span": line, "tokens": ntok(line)})"
- https://github.com/tigerless-labs/cost-xray/blob/906ce15d931b8e145b5ed59c63f65eebe1d9f0a6/docs/providers/claude-code.md#L78-L79 "Intermittent **skill ads** are carved out of system text (and system-role messages) by `detectors.py`; an injected `SKILL.md` body becomes a per-skill "Skill loads" row."
- https://github.com/tigerless-labs/cost-xray/blob/906ce15d931b8e145b5ed59c63f65eebe1d9f0a6/docs/providers/claude-code.md#L38 "plus a flag when the long-TTL 1-hour write bucket is non-zero."
- https://github.com/tigerless-labs/cost-xray/blob/906ce15d931b8e145b5ed59c63f65eebe1d9f0a6/cost_xray/classify.py#L80 "r_cw = (r["cache_write"] / 1_000_000) * (_WRITE_1H_FACTOR if u["write_1h"] else 1.0)"
- https://github.com/tigerless-labs/cost-xray/blob/906ce15d931b8e145b5ed59c63f65eebe1d9f0a6/docs/architecture.md#L121-L122 "compare our per-event/tool/bucket numbers against the wire `usage` and a coverage check"
- https://github.com/tigerless-labs/cost-xray/blob/906ce15d931b8e145b5ed59c63f65eebe1d9f0a6/cost_xray/verify.py#L17 "out[k] = {"ours": o, "truth": t, "ratio": o / t,"
- https://github.com/tigerless-labs/cost-xray/blob/906ce15d931b8e145b5ed59c63f65eebe1d9f0a6/docs/architecture.md#L128-L130 "assert **relationships / invariants** — drilling a cell sums back to its summary, server A > server B, value > 0 — never hardcoded token numbers, which break when the tokenizer changes."

## Issues and changelog
- https://github.com/tigerless-labs/cost-xray/pull/20 "cached gpt-4o input was being priced at $0.25/1M instead of $1.25/1M."
  - Broke: when a price entry lacked cache fields, every provider was priced with Anthropic's 0.1x read and 1.25x write multipliers (issue 19, from an external metering audit). Fixed: per-family fallback multipliers, pinned by `tests/test_cost_cache_fallback.py`.
- https://github.com/tigerless-labs/cost-xray/pull/5 "the calibrated total — and therefore the bill — is exact; only the split between sibling sources in a request is approximate"
  - Broke: per-source token splits read as exact although no public Claude tokenizer exists. Fixed: the accuracy contract stated in the README and provider doc, with residuals benchmarked by `verify.py` and an opt-in exact mode through `count_tokens`.

## Lessons
- Each artifact's context footprint is measured per request and an artifact loaded but never used is reported with its token cost (S32, S22): `analyze.py` lists unused MCP servers and their tokens under `savings`; `detectors.py` prices each skill's advertisement line and each `SKILL.md` load. Partial for S32: it reports, nothing fails. Touches plugin/tests/skill-size.test.mjs and docs/adr/0006-rules-size-budget.md; gap (the kit caps characters, not measured tokens of advertisement and load per skill); low cost, a test that sums description and body tokens per skill from one captured request.
- The 1-hour cache write is flagged and priced apart from the 5-minute one (S32): `classify.py` applies `_WRITE_1H_FACTOR` when `write_1h` is set. Touches the quota study's cache-TTL technique and the per-call spend ledger of the canon sweep; gap (no kit check reads the TTL bucket); low cost.
- A measurement tool is checked against the provider's own counts before its splits are trusted, and states which part is exact (S8, S24): `verify.py` residuals against the wire `usage`, PR 5's accuracy contract. Touches plugin/evals/probes/study (spend figures in study results); partial (the kit logs spend from the CLI's result, never reconciles it); low cost.
- Tests assert relationships, not token numbers, so a tokenizer or model change does not break them (S30): `docs/architecture.md`. Touches plugin/tests/skill-contracts.test.mjs (fact-only graders); overlap in spirit; none. It does not mark measured results stale on a model change, so S30 is not filled.
- A price fallback that assumes one provider's multipliers is a silent wrong answer; resolve per provider and pin it with a regression test (S24): PR 20. Touches the canon sweep spend ledger; overlap (one provider only); none.
