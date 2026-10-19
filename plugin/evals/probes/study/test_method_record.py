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
        self.assertIn("claude --bare --tools '' --setting-sources '' --strict-mcp-config --no-session-persistence --disable-slash-commands --max-turns 1", protocol)
        self.assertIn("- CLI versions: agy 9.9.9 (fixture), claude 9.9.9 (fixture)", protocol)

    def test_agreement_leads_without_the_computed_date_and_states_it_with_date_too(self):
        agreement = self.section(self.text(), "Agreement and capture-recapture")
        self.assertIn("- config: post-freeze rows 3 (ranked after the pilot block, which ends at row 1): 11/12 judged cells identical without the computed Date (0.917); "
                      "with Date 14/15 (0.933); target 0.90 without Date", agreement)
        self.assertIn("- config kappa: Authority 0.500, Methodology 1.000, Objectivity 1.000, Position 1.000; eligibility kappa 1.000 (0 of 3 decisions differ); ", agreement)

    def test_chapman_in_the_record_uses_the_rows_the_comparison_uses(self):
        repo = self.build()
        agreement = self.section(render(repo, load_topic(repo, "demo"))[0], "Agreement and capture-recapture")
        compared = script("compare-screening-sessions").compare(self.folder, "product", None)["mechanisms"]
        self.assertIn(f"- product capture-recapture over every row both sessions screened: A {compared['A']}, B {compared['B']}, shared {compared['shared']}, union {compared['union']}; "
                      f"Chapman {compared['chapman_lower_bound']:.1f} is a lower bound, not an estimate", agreement)

    def test_recall_at_the_cut_is_stated_per_stratum_and_flags_a_shortfall(self):
        recall = self.section(self.text(), "Recall")
        self.assertIn("- config: recall at the cut 2/2 (1.000) of the config standard; meets the 0.80 target", recall)
        self.assertIn("- product: recall at the cut 1/2 (0.500) of the product standard; below the 0.80 target: change the screening-order formula or the cut, "
                      "not the terms; missed: p/9 (not in the screening order)", recall)

    def test_every_session_lists_its_blocks(self):
        sessions = self.section(self.text(), "Screening sessions")
        self.assertIn("- config-A: claude claude-opus-5-5 (9.9.9 (fixture)), effort high; ranks 1-5 packet ", sessions)
        self.assertIn("- product-B: agy gemini-3.8-flash-high (9.9.9 (fixture)), effort set by the model id; ranks 1-3 packet ", sessions)
        self.assertIn("- config-pilot-A: claude claude-opus-5-5", sessions)

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
        self.assertIn("- academic papers logged, not screened: ", threats)

    def test_claude_sessions_without_bare_carry_the_plugin_hook_threat(self):
        self.assertNotIn("plugin hooks not excluded", self.text())
        threats = self.section(self.text(bare=False), "Threats")
        self.assertIn("- plugin hooks not excluded (no --bare): config-A, config-pilot-A, product-A, product-pilot-A ran without --bare because no API-key auth source was set", threats)

    def test_an_unrated_calibration_sample_is_an_llm_only_threat(self):
        self.assertIn("- LLM-only screening: no calibration sample was drawn", self.section(self.text(), "Threats"))
        self.assertIn("- LLM-only screening: the calibration sample is rated on 1 of 2 rows", self.section(self.text(rated="partial"), "Threats"))
        text = self.text(rated="full")
        self.assertIn("- user vs session A: decisions 2/2, judged cells 8/8; user vs session B: decisions 2/2, judged cells 7/8", self.section(text, "Calibration"))
        self.assertNotIn("LLM-only", text)

    def test_the_stop_line_comes_from_the_data_and_a_hand_typed_stop_row_is_refused(self):
        repo = self.build()
        self.assertIn("## Stratum: config\n\nstop: pool exhausted at row 3\n", render(repo, load_topic(repo, "demo"))[0])
        topic = json.loads((repo / "docs/prior-art/topics/demo.json").read_text())
        topic["strata"]["product"]["stop_row"] = 60
        (repo / "docs/prior-art/topics/demo.json").write_text(json.dumps(topic))
        with self.assertRaisesRegex(TopicError, "strata.product.stop_row is 60, the screening data stop at row 3"):
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
