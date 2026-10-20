import json
import shutil
import tempfile
import unittest
from pathlib import Path

from study_sweep_record import render, write_record
from study_topic import TopicError, load_topic, topic_for_sweep
from study_v4_fixture import SWEEP, v4_sweep


def section(text, heading):
    return text.split(f"## {heading}\n\n", 1)[1].split("\n## ", 1)[0]


class V4RecordTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.built = v4_sweep()
        cls.text = render(cls.built, load_topic(cls.built, "demo"))[0]

    def copy(self, audit=True):
        repo = Path(tempfile.mkdtemp(prefix="study-v4-copy-"))
        self.addCleanup(shutil.rmtree, repo, ignore_errors=True)
        shutil.copytree(self.built if audit else v4_sweep(audit=False), repo, dirs_exist_ok=True)
        return repo, repo / "docs/prior-art/sweeps" / SWEEP

    def test_topic_qgs_facet_labels_calibration_judges_and_faceted_screening_reach_the_record(self):
        recall = section(self.text, "Recall")
        self.assertIn("- config: pooled recall at the stop 22/23 (0.957, 95% CI 0.78-1.00) of the deduplicated config standard, counting rows both sessions screened within a "
                      "facet's depth; meets the 0.80 target", recall)
        self.assertIn("- config facet alpha: 12/13 (0.923, 95% CI 0.64-1.00) of the members labelled for it, within its own depth; reported, no pass or fail", recall)
        self.assertIn("- product channel from the config pool: 2 repositories joined the product pool; they hold 2 of the 23 product standard members, 1 of them found by no other "
                      "product channel", recall)
        self.assertIn("stop: pooled recall reached the 0.80 target at depth 60; facet stop rows alpha 40 (pool exhausted), beta 40 (pool exhausted)", self.text)
        facets = section(self.text, "Facets")
        self.assertIn("- config: 79 repositories screened once, counted per facet alpha 40, beta 40; overlap alpha+beta 1; each repository counts once in pooled recall and PRISMA", facets)
        self.assertIn('- alpha ranking: problems X1, X2; terms tdd, test; counted code-search queries config ["\\"tdd\\" filename:SKILL.md"]', facets)
        calibration = section(self.text, "Calibration")
        self.assertRegex(calibration, r"- config: calibration set of 60 rows, drawn per facet alpha 30, beta 30; likely positives 30 of 60; the user labelled \d+ eligible and \d+ relevant")
        judges = section(self.text, "Judges")
        for judge in ("screening-A claude claude-opus-5-5", "screening-B claude claude-sonnet-5-5", "qgs-A claude claude-opus-5-5", "qgs-B claude claude-sonnet-5-5", "reader claude claude-opus-5-5"):
            for stratum in ("config", "product"):
                self.assertRegex(judges, rf"- {judge}, {stratum}: run 1 sensitivity 1\.000 \(95% CI [\d.]+-1\.00\), kappa 1\.000, .*; run 2 .*; runs differ on 0 of 60 rows .*; qualified\n")
        self.assertIn("- config QGS qgs-B: claude-sonnet-5-5 judged 32 candidates through the toolchain on their pre-fetched inputs", judges)
        self.assertIn("- config cross-family QGS judge gemini-3.8-flash-high: 12 candidates judged, 12 also judged by both Claude judges; agreement with qgs-A 11/12 (kappa 0.750)", judges)
        self.assertIn("1 candidates both Claude judges rejected and it accepted went to the reader, which accepted 0", judges)
        self.assertIn("- config standard: 23 members from 32 candidates both Claude judges judged; reader queue 1 disputed or unsure, 1 cross-family only", judges)
        self.assertRegex(judges, r"- config audit: 20 rows screened again by gemini-3\.8-flash-high: eligibility agreement with A 20/20 \(kappa 1\.000\), with B 20/20")
        threats = section(self.text, "Threats")
        for threat in ("- same model family: config sessions A (claude-opus-5-5) and B (claude-sonnet-5-5)", "- reader shares the QGS judges' model family: the reader claude-opus-5-5",
                       "- recall is an upper estimate: "):
            self.assertIn(threat, threats)
        self.assertNotIn("cross-family audit pending", threats)

    def test_a_repository_ranked_in_both_facets_is_one_screened_row_counted_for_both(self):
        rows = [line for line in section(self.text, "Stratum: config").splitlines() if line.startswith("| ") and "o/shared" in line]
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0].endswith("| alpha, beta |"))
        self.assertIn("| rank | repo | commit | scores | decision | mechanisms | reason | facets |", self.text)

    def test_the_record_regenerates_byte_identically_from_the_sweep_folder(self):
        repo, _ = self.copy()
        write_record(repo, topic_for_sweep(repo, SWEEP))
        first = (repo / f"docs/prior-art/sweeps/{SWEEP}.md").read_text()
        write_record(repo, load_topic(repo, "demo"))
        self.assertEqual((repo / f"docs/prior-art/sweeps/{SWEEP}.md").read_text(), first)
        self.assertEqual(first, self.text)

    def test_a_hand_typed_facet_stop_row_is_refused(self):
        repo, _ = self.copy()
        path = repo / "docs/prior-art/topics/demo.json"
        topic = json.loads(path.read_text())
        topic["facets"]["beta"]["strata"]["product"]["stop_row"] = 30
        path.write_text(json.dumps(topic))
        with self.assertRaisesRegex(TopicError, r"the facets' product stop rows are \{'alpha': 40, 'beta': 30\}, the facet orders and the standard give \{'alpha': 40, 'beta': 40\}"):
            render(repo, load_topic(repo, "demo"))

    def test_a_standard_that_its_judge_files_do_not_give_is_refused(self):
        repo, folder = self.copy()
        adjudicated = json.loads((folder / "config-qgs-adjudicated.json").read_text())
        member = adjudicated["final"].pop()
        adjudicated["labels"].pop(member)
        adjudicated["resolved"] = {**adjudicated["resolved"], "of": adjudicated["final"], "final": adjudicated["final"]}
        (folder / "config-qgs-adjudicated.json").write_text(json.dumps(adjudicated))
        with self.assertRaisesRegex(TopicError, "config-qgs-adjudicated.json is not the standard its judge files give; rebuild it with qgs-standard.py"):
            render(repo, load_topic(repo, "demo"))

    def test_a_judge_run_that_is_missing_or_ran_on_other_inputs_is_refused(self):
        repo, folder = self.copy()
        (folder / "judge-product-reader-claude-opus-5-5-run2.jsonl").unlink()
        with self.assertRaisesRegex(TopicError, "reader claude-opus-5-5 did not qualify on the product calibration set"):
            render(repo, load_topic(repo, "demo"))
        repo, folder = self.copy()
        meta = json.loads((folder / "meta.json").read_text())
        block = meta["sessions"]["judge-config-screening-A-claude-opus-5-5-run1"]["blocks"][0]
        block["row_sha256"][str(block["ranks"][0])] = "0" * 64
        (folder / "meta.json").write_text(json.dumps(meta))
        with self.assertRaisesRegex(TopicError, "judge-config-screening-A-claude-opus-5-5-run1: ranks .* were judged on other inputs"):
            render(repo, load_topic(repo, "demo"))

    def test_labels_of_another_calibration_set_are_refused(self):
        repo, folder = self.copy()
        (folder / "calibration-set.json").write_text((folder / "calibration-set.json").read_text() + " ")
        with self.assertRaisesRegex(TopicError, "calibration-labels.json was imported for another calibration set"):
            render(repo, load_topic(repo, "demo"))

    def test_an_audit_not_yet_run_is_a_threat(self):
        repo, _ = self.copy(audit=False)
        text = render(repo, load_topic(repo, "demo"))[0]
        threats = section(text, "Threats")
        self.assertIn("- cross-family audit pending: config: 0 of 0 audit rows screened by gemini-3.8-flash-high", threats)
        self.assertIn("- cross-family audit pending: product: ", threats)
        self.assertNotIn("audit: 20 rows", text)


if __name__ == "__main__":
    unittest.main()
