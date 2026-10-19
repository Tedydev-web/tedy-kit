import json
import shutil
import unittest

from study_method_fixture import method_repo, sha
from study_sweep_record import render
from study_topic import TopicError, load_topic


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

    def test_the_record_states_the_freeze_point_and_the_protocol_hash(self):
        protocol = self.section(self.text(), "Protocol")
        self.assertIn(f"- config: frozen after row 1 (pilot block of 1 unforced row), protocol sha256[:16] `{sha('criteria' + chr(10) + 'packet config' + chr(10))[:16]}` "
                      "over the criteria and screening-packet-config.md, 2026-10-20", protocol)
        self.assertIn("- session B pilot: gemini-3.8-flash-high agreement 1.000 on 1 rows; chosen gemini-3.8-flash-high", protocol)

    def test_agreement_and_kappa_cover_post_freeze_rows_without_the_date(self):
        agreement = self.section(self.text(), "Agreement and capture-recapture")
        self.assertIn("- config: post-freeze rows 3 (rows up to 1 left out as the pilot): 14/15 judged cells identical (0.933); target 0.90", agreement)
        self.assertIn("- config kappa: Authority 0.500, Methodology 1.000, Objectivity 1.000, Position 1.000; eligibility kappa 1.000 (0 of 3 decisions differ); "
                      "Date is computed, not judged, and left out", agreement)

    def test_chapman_is_reported_as_a_lower_bound_with_its_reason(self):
        agreement = self.section(self.text(), "Agreement and capture-recapture")
        lines = [l for l in agreement.splitlines() if l.startswith("- product capture-recapture:")]
        self.assertEqual(len(lines), 1)
        line = lines[0]
        self.assertIn("Chapman 1.0 is a lower bound, not an estimate: the two sessions are not independent captures", line)
        self.assertNotIn("{", line)

    def test_recall_at_the_cut_is_stated_per_stratum_and_flags_a_shortfall(self):
        recall = self.section(self.text(), "Recall")
        self.assertIn("- config: recall at the cut 2/2 (1.000) of the config standard; meets the 0.80 target", recall)
        self.assertIn("- product: recall at the cut 1/2 (0.500) of the product standard; below the 0.80 target: change the screening-order formula or the cut, "
                      "not the terms; missed: p/9 (not in the screening order)", recall)

    def test_every_session_is_listed_with_its_model_effort_packet_and_date(self):
        sessions = self.section(self.text(), "Screening sessions")
        self.assertIn(f"- config-A: claude claude-opus-5-5, effort high, packet sha256[:16] `{sha('packet config' + chr(10))[:16]}`, 2026-10-20", sessions)
        self.assertIn("- product-B: agy gemini-3.8-flash-high, effort set by the model id", sessions)

    def test_a_session_without_its_record_is_refused(self):
        repo = self.build()
        meta = json.loads((self.folder / "meta.json").read_text())
        del meta["sessions"]["product-B"]["effort"]
        (self.folder / "meta.json").write_text(json.dumps(meta))
        with self.assertRaisesRegex(TopicError, "product-B lacks effort"):
            render(repo, load_topic(repo, "demo"))

    def test_the_same_model_family_is_named_as_a_threat(self):
        self.assertNotIn("same model family", self.text())
        threats = self.section(self.text(same_family=True), "Threats")
        self.assertIn("- same model family: config sessions A (claude-opus-5-5) and B (claude-sonnet-4-6) are both claude models", threats)

    def test_an_unrated_calibration_sample_is_an_llm_only_threat(self):
        self.assertIn("- LLM-only screening: no calibration sample was drawn", self.section(self.text(), "Threats"))
        self.assertIn("- LLM-only screening: the calibration sample is rated on 1 of 2 rows", self.section(self.text(rated="partial"), "Threats"))
        text = self.text(rated="full")
        self.assertIn("- user vs session A: decisions 2/2, judged cells 8/8; user vs session B: decisions 2/2, judged cells 7/8", self.section(text, "Calibration"))
        self.assertNotIn("LLM-only", text)

    def test_the_stop_line_comes_from_the_data_and_a_hand_typed_stop_row_is_refused(self):
        text = self.text()
        self.assertIn("## Stratum: config\n\nstop: pool exhausted at row 3\n", text)
        repo = self.build()
        topic = json.loads((repo / "docs/prior-art/topics/demo.json").read_text())
        topic["strata"]["product"]["stop_row"] = 60
        (repo / "docs/prior-art/topics/demo.json").write_text(json.dumps(topic))
        with self.assertRaisesRegex(TopicError, "strata.product.stop_row is 60, the screening data stop at row 3"):
            render(repo, load_topic(repo, "demo"))

    def test_a_missing_stratum_standard_is_refused(self):
        repo = self.build()
        (self.folder / "config-qgs-adjudicated.json").unlink()
        with self.assertRaisesRegex(TopicError, "config-qgs-adjudicated.json"):
            render(repo, load_topic(repo, "demo"))


if __name__ == "__main__":
    unittest.main()
