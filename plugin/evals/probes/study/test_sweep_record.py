import shutil
import subprocess
import sys
import unittest
from pathlib import Path

from study_fixtures import topic_repo, write_json
from study_sweep_record import render
from study_topic import TopicError, load_topic, topic_for_sweep

HERE = Path(__file__).resolve().parent


class SweepRecordTest(unittest.TestCase):
    def repo(self, **kwargs):
        repo = topic_repo(**kwargs)
        self.addCleanup(shutil.rmtree, repo)
        return repo

    def rows(self, text, stratum):
        body = text.split(f"## Stratum: {stratum}\n", 1)[1].split("\n## ", 1)[0]
        return [line.split(" | ")[0][2:] for line in body.splitlines() if line.startswith("| ") and not line.startswith("| rank")]

    def test_stop_row_and_forced_flags_come_from_the_topic_and_the_screening_order(self):
        repo = self.repo()
        text, summary = render(repo, load_topic(repo, "demo"))
        self.assertEqual(self.rows(text, "config"), ["1", "2", "5"])
        self.assertIn("Screened beyond the stop or outside both sessions: 1 rows", text)
        self.assertIn("rows config 3, local 1;", summary)
        repo = self.repo(strata={"config": {"stop_row": 3, "forced_repos": []}})
        self.assertEqual(self.rows(render(repo, load_topic(repo, "demo"))[0], "config"), ["1", "2", "3", "5"])

    def test_every_topic_stratum_gets_a_section_with_its_capture_recapture_line(self):
        repo = self.repo()
        text, _ = render(repo, load_topic(repo, "demo"))
        self.assertIn("## Stratum: local\n\nstop: row 1\n", text)
        self.assertIn("| 1 | plugin:skill |", text)
        self.assertIn("- local: {'union': 1}", text)

    def test_decisions_are_derived_from_the_mechanism_table(self):
        repo = self.repo()
        text, _ = render(repo, load_topic(repo, "demo"))
        self.assertIn("| 1 | o/one | https://github.com/o/one/commit/" + "a" * 40 + " | A1 M1 O1 D1 P1 N1 | study | gate | picked for the ledger |", text)
        self.assertIn("| 2 | o/two | ", text)
        self.assertIn("| excluded: irrelevant | - | both sessions excluded: irrelevant; sums A 0, B 0 |", text)
        self.assertIn("A1/0.5 M1 O1 D1 P1 N1 | eligible | gate |", text)
        self.assertIn("- config #5 o/forced Authority: A 1, B 0.5", text)
        self.assertNotIn("proof", text.split("## Mechanisms")[0])

    def test_a_stratum_without_a_stop_row_is_refused(self):
        repo = self.repo(strata={"config": {"forced_repos": []}})
        with self.assertRaisesRegex(TopicError, "strata.config.stop_row must be a int"):
            render(repo, load_topic(repo, "demo"))

    def test_the_legacy_entry_point_finds_the_topic_by_sweep_name(self):
        repo = self.repo()
        result = subprocess.run([sys.executable, str(HERE.parent / "prior-art-sweep-record.py"), str(repo), "261001-demo"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((repo / "docs/prior-art/sweeps/261001-demo.md").read_text(), render(repo, load_topic(repo, "demo"))[0])
        result = subprocess.run([sys.executable, str(HERE.parent / "prior-art-sweep-record.py"), str(repo), "nope"], capture_output=True, text=True)
        self.assertIn("sweep nope is named by 0 topic configs", result.stderr)

    def test_topic_configs_are_validated_at_load(self):
        repo = self.repo()
        with self.assertRaisesRegex(TopicError, "must be kebab-case"):
            load_topic(repo, "../x")
        with self.assertRaisesRegex(TopicError, "no topic config"):
            load_topic(repo, "missing")
        write_json(repo / "docs/prior-art/topics/bad.json", {"sweep": "261001-demo", "terms": [], "strata": {}})
        with self.assertRaisesRegex(TopicError, "terms must be a non-empty list"):
            load_topic(repo, "bad")
        with self.assertRaisesRegex(TopicError, "named by 2 topic configs"):
            topic_for_sweep(repo, "261001-demo")
        (repo / "docs/prior-art/topics/bad.json").write_text("{")
        with self.assertRaisesRegex(TopicError, "not JSON"):
            load_topic(repo, "bad")

    def test_every_committed_sweep_record_regenerates_byte_identical(self):
        repo = HERE.parents[3]
        records = sorted((repo / "docs/prior-art/sweeps").glob("*.md"))
        self.assertTrue(records)
        for record in records:
            with self.subTest(record=record.name):
                self.assertEqual(render(repo, topic_for_sweep(repo, record.stem))[0], record.read_text())

    def test_the_dev_topic_regenerates_the_committed_record(self):
        repo = HERE.parents[3]
        topic = load_topic(repo, "dev")
        committed = (repo / "docs/prior-art/sweeps" / f"{topic['sweep']}.md").read_text()
        self.assertEqual(render(repo, topic)[0], committed)


if __name__ == "__main__":
    unittest.main()
