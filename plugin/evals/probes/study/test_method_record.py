import hashlib
import json
import shutil
import unittest

from study_fixtures import script
from study_method_fixture import method_repo
from study_sweep_record import render
from study_topic import TopicError, load_topic


def sha(data):
    return hashlib.sha256(data).hexdigest()


class MethodRecordTest(unittest.TestCase):
    def build(self, **kwargs):
        repo = method_repo(**kwargs)
        self.addCleanup(shutil.rmtree, repo)
        self.folder = repo / "docs/prior-art/sweeps/261001-demo"
        return repo

    def text(self, **kwargs):
        repo = self.build(**kwargs)
        return render(repo, load_topic(repo, "demo"))[0]

    def section(self, text, heading):
        return text.split(f"## {heading}\n\n", 1)[1].split("\n## ", 1)[0] if f"## {heading}\n" in text else ""

    def edit_meta(self, change):
        meta = json.loads((self.folder / "meta.json").read_text())
        change(meta["sessions"])
        (self.folder / "meta.json").write_text(json.dumps(meta))

    def test_the_exported_sweep_keeps_full_digests_and_renders(self):
        repo = self.build()
        meta = json.loads((self.folder / "meta.json").read_text())
        self.assertEqual(len(meta["sessions"]["config-A"]["blocks"][0]["inputs_sha256"]), 64)
        self.assertIn("## Protocol", render(repo, load_topic(repo, "demo"))[0])

    def test_the_record_states_the_freeze_point_full_digests_amendment_isolation_and_versions(self):
        repo = self.build()
        protocol = self.section(render(repo, load_topic(repo, "demo"))[0], "Protocol")
        self.assertIn(f"- config: frozen after row 1 (pilot block of 1 unforced row), criteria sha256 `{sha((repo / 'docs/prior-art/quality-criteria-v2.md').read_bytes())}`, "
                      f"packet sha256 `{sha(b'packet config' + bytes([10]))}` (screening-packet-config.md), 2026-10-20", protocol)
        self.assertIn("- session A: claude claude-opus-5-5; session B: agy gemini-3.8-flash-high, the topic config's session B", protocol)
        self.assertIn("- session B pilot, information only: gemini-3.8-flash-high agreement 1.000 on 2 rows", protocol)
        self.assertIn("- packet amendment at the freeze: the pilot draft became the frozen packet; pilot packets sha256[:16] ", protocol)
        self.assertIn("- isolation: agy --disable-slash-commands; empty temporary working folder; stdin closed; claude --bare --tools '' --setting-sources '' --strict-mcp-config "
                      "--no-session-persistence --disable-slash-commands --max-turns 1; empty temporary working folder; stdin closed", protocol)
        self.assertIn("- CLI versions: agy 9.9.9 (fixture), claude 9.9.9 (fixture)", protocol)

    def test_agreement_leads_without_the_computed_date_and_states_it_with_date_too(self):
        agreement = self.section(self.text(), "Agreement and capture-recapture")
        self.assertIn("- config: post-freeze rows 6 (every row both sessions screened that is ranked after the pilot block, which ends at row 1): 23/24 judged cells identical "
                      "without the computed Date (0.958); with Date 29/30 (0.967); target 0.90 without Date", agreement)
        self.assertIn("- config kappa: Authority 0.700, Methodology 1.000, Objectivity 1.000, Position 1.000; eligibility kappa 1.000 (0 of 6 decisions differ); ", agreement)
        compared = script("compare-screening-sessions").compare(self.folder, "product", None)
        self.assertIn(f"- product: post-freeze rows {compared['rows']} (", agreement)
        self.assertIn(f"{compared['identical']}/{compared['judged_cells']} judged cells identical", agreement)

    def test_chapman_in_the_record_uses_the_rows_the_comparison_uses(self):
        repo = self.build()
        agreement = self.section(render(repo, load_topic(repo, "demo"))[0], "Agreement and capture-recapture")
        compared = script("compare-screening-sessions").compare(self.folder, "product", None)["mechanisms"]
        self.assertIn(f"- product capture-recapture over every row both sessions screened: A {compared['A']}, B {compared['B']}, shared {compared['shared']}, union {compared['union']}; "
                      f"Chapman {compared['chapman_lower_bound']:.1f} is a lower bound, not an estimate", agreement)

    def test_recall_at_the_cut_is_stated_per_stratum_and_flags_a_shortfall(self):
        recall = self.section(self.text(), "Recall")
        self.assertIn("- config: recall at the cut 2/2 (1.000) of the config standard, counting rows both sessions screened; meets the 0.80 target", recall)
        self.assertIn("- product: recall at the cut 1/2 (0.500) of the product standard, counting rows both sessions screened; below the 0.80 target: change the screening-order "
                      "formula or the cut, not the terms; missed: p/r9 (not in the screening order)", recall)

    def test_recall_at_the_cut_leaves_out_a_forced_row_only_one_session_screened(self):
        repo = self.build()
        (self.folder / "config-qgs-adjudicated.json").write_text(json.dumps({"final": ["o/r1", "o/forced"]}))
        self.assertIn("- config: recall at the cut 2/2 (1.000)", self.section(render(repo, load_topic(repo, "demo"))[0], "Recall"))
        rows = (self.folder / "config-screen-B.jsonl").read_text().splitlines()
        (self.folder / "config-screen-B.jsonl").write_text("".join(line + "\n" for line in rows if json.loads(line)["order_rank"] != 8))
        self.edit_meta(lambda sessions: sessions["config-B"]["blocks"][0].update(ranks=[r for r in sessions["config-B"]["blocks"][0]["ranks"] if r != 8]))
        self.assertIn("- config: recall at the cut 1/2 (0.500) of the config standard, counting rows both sessions screened; below the 0.80 target: change the screening-order "
                      "formula or the cut, not the terms; missed: o/forced (rank 8)", self.section(render(repo, load_topic(repo, "demo"))[0], "Recall"))

    def test_every_session_lists_its_blocks(self):
        sessions = self.section(self.text(), "Screening sessions")
        self.assertIn("- config-A: claude claude-opus-5-5, effort high; ranks 1-8 packet ", sessions)
        self.assertIn("- product-B: agy gemini-3.8-flash-high, effort set by the model id; ranks 1-6 packet ", sessions)
        self.assertRegex(sessions, r"- config-pilot-A: claude claude-opus-5-5, effort high; ranks 1-1 packet `[0-9a-f]{16}` prompt `[0-9a-f]{16}` inputs `[0-9a-f]{16}` 9.9.9 \(fixture\) 2026-10-20")

    def test_the_fixture_ran_a_transient_error_row_and_a_refetch_after_a_scored_block(self):
        events = []
        self.build(events=events)
        self.assertEqual(events, ["refused: run-screening-session: rank 2 has a transient fetch error (tree: exit 1: HTTP 502); run fetch-screening-inputs.py again, "
                                  "or mark it permanent with --mark-permanent after checking it by hand",
                                  "refetch after a scored block: fetched 1, kept 5, still transient 0, calls to the scored rank 0"])
        rows = [json.loads(line) for line in (self.folder / "product-screen-A.jsonl").read_text().splitlines()]
        self.assertEqual([r["commit"] for r in rows if r["order_rank"] == 2], ["https://github.com/p/r2/commit/" + "d" * 40])

    def test_a_block_without_a_row_hash_for_each_rank_is_refused(self):
        repo = self.build()
        self.edit_meta(lambda sessions: sessions["config-A"]["blocks"][0]["row_sha256"].pop("8"))
        with self.assertRaisesRegex(TopicError, "config-A has a block whose ranks lack a row_sha256 each"):
            render(repo, load_topic(repo, "demo"))
        self.edit_meta(lambda sessions: sessions["config-A"]["blocks"][0].pop("ranks"))
        with self.assertRaisesRegex(TopicError, "config-A has a block whose ranks lack a row_sha256 each"):
            render(repo, load_topic(repo, "demo"))

    def test_a_cli_version_change_within_a_session_is_a_threat_not_a_refusal(self):
        repo = self.build()
        self.assertNotIn("CLI version changed", render(repo, load_topic(repo, "demo"))[0])
        def split(sessions):
            block = sessions["product-B"]["blocks"].pop()
            for ranks, version in ((block["ranks"][:3], block["cli_version"]), (block["ranks"][3:], "1.4.3")):
                sessions["product-B"]["blocks"].append({**block, "ranks": ranks, "row_sha256": {str(r): block["row_sha256"][str(r)] for r in ranks}, "cli_version": version})

        self.edit_meta(split)
        text = render(repo, load_topic(repo, "demo"))[0]
        self.assertIn("- CLI version changed within a session: product-B (1.4.3, 9.9.9 (fixture))", self.section(text, "Threats"))
        self.assertIn("- CLI versions: agy 1.4.3, 9.9.9 (fixture), claude 9.9.9 (fixture)", self.section(text, "Protocol"))

    def test_a_session_model_other_than_the_frozen_one_is_refused(self):
        repo = self.build()
        self.edit_meta(lambda sessions: sessions["product-A"].update(model="claude-haiku-4-5"))
        with self.assertRaisesRegex(TopicError, "product-A ran claude claude-haiku-4-5, the freeze names claude claude-opus-5-5"):
            render(repo, load_topic(repo, "demo"))

    def test_a_session_block_without_its_input_hash_is_refused(self):
        repo = self.build()
        self.edit_meta(lambda sessions: sessions["product-B"]["blocks"][0].pop("inputs_sha256"))
        with self.assertRaisesRegex(TopicError, "product-B has a block without inputs_sha256"):
            render(repo, load_topic(repo, "demo"))

    def test_sessions_a_and_b_must_have_scored_the_same_inputs(self):
        repo = self.build()
        self.edit_meta(lambda sessions: sessions["config-B"]["blocks"][0]["row_sha256"].update({"3": "0" * 64}))
        with self.assertRaisesRegex(TopicError, r"config: sessions A and B scored different inputs for ranks \[3\]"):
            render(repo, load_topic(repo, "demo"))

    def test_a_screened_stratum_without_both_session_files_is_refused(self):
        repo = self.build()
        (self.folder / "product-screen-B.jsonl").unlink()
        with self.assertRaisesRegex(TopicError, "no product-screen-B.jsonl"):
            render(repo, load_topic(repo, "demo"))

    def test_the_same_model_family_and_its_fallback_are_threats(self):
        self.assertNotIn("same model family", self.text())
        threats = self.section(self.text(same_family=True), "Threats")
        self.assertIn("- same model family: config sessions A (claude-opus-5-5) and B (claude-sonnet-4-6) are both claude models", threats)
        self.assertIn("- session B fallback: the topic config's fallback", threats)

    def test_the_fixed_session_b_and_unscreened_papers_are_threats(self):
        threats = self.section(self.text(), "Threats")
        self.assertIn("- session B fixed by the topic config (gemini-3.8-flash-high), not chosen by agreement with A", threats)
        self.assertIn("- academic papers logged, not screened: 1 papers in papers.jsonl named 1 repositories that joined the pool; the papers themselves are not scored", threats)

    def test_agy_sessions_carry_the_agy_isolation_threat(self):
        threats = self.section(self.text(), "Threats")
        self.assertIn("- agy MCP servers, hooks and user settings not excluded: config-B, config-pilot-B-gemini-3.8-flash-high, product-B, product-pilot-B-gemini-3.8-flash-high ran through agy", threats)

    def test_claude_sessions_without_bare_carry_the_plugin_hook_threat(self):
        self.assertNotIn("plugin hooks not excluded", self.text())
        threats = self.section(self.text(bare=False), "Threats")
        self.assertIn("- plugin hooks not excluded (no --bare): config-A, config-pilot-A, product-A, product-pilot-A ran without --bare because no API-key auth source was set", threats)

    def test_an_unrated_calibration_sample_is_an_llm_only_threat(self):
        self.assertIn("- LLM-only screening: no calibration sample was drawn", self.section(self.text(), "Threats"))
        self.assertIn("- LLM-only screening: the calibration sample is rated on 9 of 10 rows", self.section(self.text(rated="partial"), "Threats"))
        repo = self.build(rated="full")
        text = render(repo, load_topic(repo, "demo"))[0]
        self.assertIn("- user vs session A: decisions 10/10, judged cells 40/40; user vs session B: decisions 9/10, judged cells 35/40", self.section(text, "Calibration"))
        self.assertNotIn("LLM-only", text)
        sample = json.loads((self.folder / "calibration-sample.json").read_text())
        sample["rows"][0]["inputs_sha256"] = "0" * 64
        (self.folder / "calibration-sample.json").write_text(json.dumps(sample))
        with self.assertRaisesRegex(TopicError, f"calibration row {sample['rows'][0]['stratum']} #{sample['rows'][0]['order_rank']}: its inputs_sha256 is not the row_sha256 session A scored"):
            render(repo, load_topic(repo, "demo"))

    def test_the_stop_line_comes_from_the_data_and_a_hand_typed_stop_row_is_refused(self):
        repo = self.build()
        self.assertIn("## Stratum: config\n\nstop: pool exhausted at row 6\n", render(repo, load_topic(repo, "demo"))[0])
        topic = json.loads((repo / "docs/prior-art/topics/demo.json").read_text())
        topic["strata"]["product"]["stop_row"] = 60
        (repo / "docs/prior-art/topics/demo.json").write_text(json.dumps(topic))
        with self.assertRaisesRegex(TopicError, "strata.product.stop_row is 60, the screening data stop at row 6"):
            render(repo, load_topic(repo, "demo"))

    def test_a_tag_only_stratum_is_stated_and_not_screened(self):
        text = self.text()
        self.assertIn("## Tag-only strata\n\n- local: tag-only inventory, not screened by two sessions", text)
        self.assertNotIn("## Stratum: local", text)

    def test_a_missing_stratum_standard_is_refused(self):
        repo = self.build()
        (self.folder / "config-qgs-adjudicated.json").unlink()
        with self.assertRaisesRegex(TopicError, "config-qgs-adjudicated.json"):
            render(repo, load_topic(repo, "demo"))


if __name__ == "__main__":
    unittest.main()
