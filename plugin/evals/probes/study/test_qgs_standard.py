import json
import shutil
import tempfile
import unittest
from pathlib import Path

from study_fixtures import FakeFetch, script, topic_repo, write_json, write_jsonl
from study_topic import TopicError, load_topic

FACETS = {"alpha": {"sweep": "261020-demo-alpha", "problems": ["X1", "X2"], "terms": ["tdd"], "strata": {"config": {"stop_row": None, "forced_repos": []}}},
          "beta": {"sweep": "261020-demo-beta", "problems": ["X3"], "terms": ["test"], "strata": {"config": {"stop_row": None, "forced_repos": []}}}}


def verdicts(path, rows):
    write_jsonl(path, [{"id": i, "repo": repo, "verdict": verdict, "problems": problems, "why": "w"} for i, repo, verdict, problems in rows])


class ClopperPearsonTest(unittest.TestCase):
    def test_the_interval_matches_the_methods_report(self):
        from study_agreement import clopper_pearson
        self.assertEqual([tuple(round(v, 2) for v in clopper_pearson(k, n)) for k, n in ((8, 10), (16, 20), (40, 50))], [(0.44, 0.97), (0.56, 0.94), (0.66, 0.90)])
        self.assertEqual(clopper_pearson(0, 5)[0], 0.0)
        self.assertEqual(clopper_pearson(5, 5)[1], 1.0)
        with self.assertRaises(TopicError):
            clopper_pearson(1, 0)


class TopicQgsTest(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo(strata={"config": {"stop_row": None, "forced_repos": [], "channels": {}}})
        path = self.repo / "docs/prior-art/topics/demo.json"
        write_json(path, {**json.loads(path.read_text()), "problems": ["X1", "X2", "X3"], "facets": FACETS, "qgs_list_topic": "claude",
                          "cross_family": {"cli": "agy", "model": "gemini-3.8-flash-high"}})
        self.work = Path(tempfile.mkdtemp(prefix="study-qgs-"))
        for folder in (self.repo, self.work):
            self.addCleanup(shutil.rmtree, folder, ignore_errors=True)

    def test_candidates_are_extracted_once_per_topic_never_with_facet_terms(self):
        write_json(self.work / "config-ranked.json", {"rows": [], "aggregators": [{"repo": "l/awesome-claude", "description": "awesome claude list"}]})
        (self.work / "cache/readmes").mkdir(parents=True)
        (self.work / "cache/readmes/l__awesome-claude.md").write_text("- [a](https://github.com/o/a) tdd guard\n- [b](https://github.com/o/b) test runner\n")
        with self.assertRaisesRegex(SystemExit, "once per topic with the topic's terms; run it with --topic demo"):
            script("extract-qgs-candidates").main(["--topic", "demo:alpha", "--repo", str(self.repo), "--work", str(self.work), "--stratum", "config"], fetch=FakeFetch())
        script("extract-qgs-candidates").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--stratum", "config"], fetch=FakeFetch())
        self.assertEqual([json.loads(line)["repo"] for line in (self.work / "config-qgs-candidates.jsonl").read_text().splitlines()], ["o/a", "o/b"])

    def judged(self):
        verdicts(self.work / "config-qgs-judge-A.jsonl", [(1, "o/a", "yes", ["X1"]), (2, "o/b", "yes", ["X3"]), (3, "o/c", "no", []), (4, "o/d", "unsure", []),
                                                          (5, "o/e", "no", []), (6, "o/f", "no", []), (7, "o/g", "yes", ["X2", "X3"])])
        verdicts(self.work / "config-qgs-judge-B.jsonl", [(1, "o/a", "yes", ["X2"]), (2, "o/b", "no", []), (3, "o/c", "no", []), (4, "o/d", "no", []),
                                                          (5, "o/e", "no", []), (6, "o/f", "no", []), (7, "o/g", "yes", ["X3"])])
        verdicts(self.work / "config-qgs-cross-gemini-3.8-flash-high.jsonl", [(1, "o/a", "yes", ["X1"]), (5, "o/e", "yes", ["X1"]), (6, "o/f", "no", [])])

    def standard(self):
        from study_qgs import qgs_standard
        return qgs_standard(load_topic(self.repo, "demo"), self.work, "config")

    def test_the_reader_reads_disagreements_unsure_rows_and_cross_family_yes_rows_both_claude_judges_rejected(self):
        self.judged()
        with self.assertRaisesRegex(TopicError, r"the reader has not judged queued candidates \[2, 4, 5\]"):
            self.standard()
        verdicts(self.work / "config-qgs-reader.jsonl", [(2, "o/b", "no", []), (4, "o/d", "yes", ["X1"]), (5, "o/e", "yes", ["X3"])])
        out = self.standard()
        self.assertEqual(out["queue"], {"disputed": [2, 4], "cross_family_only": [5]})
        self.assertEqual(out["final"], ["o/a", "o/g", "o/d", "o/e"])
        self.assertEqual(out["labels"], {"o/a": ["X1", "X2"], "o/g": ["X2", "X3"], "o/d": ["X1"], "o/e": ["X3"]})
        self.assertEqual(out["cross_family"]["model"], "gemini-3.8-flash-high")
        self.assertEqual((out["cross_family"]["overlap"], out["cross_family"]["accepted_against_both"], out["cross_family"]["reader_yes"]), (3, [5], [5]))

    def test_a_yes_without_a_problem_label_or_a_label_outside_the_topic_is_refused(self):
        self.judged()
        verdicts(self.work / "config-qgs-judge-B.jsonl", [(1, "o/a", "yes", [])])
        with self.assertRaisesRegex(TopicError, "config-qgs-judge-B.jsonl id 1: a yes verdict needs at least one problem id"):
            self.standard()
        verdicts(self.work / "config-qgs-judge-B.jsonl", [(1, "o/a", "yes", ["X9"])])
        with self.assertRaisesRegex(TopicError, r"config-qgs-judge-B.jsonl id 1: problems \['X9'\] are not topic problems"):
            self.standard()
        verdicts(self.work / "config-qgs-judge-B.jsonl", [(1, "o/a", "maybe", [])])
        with self.assertRaisesRegex(TopicError, "verdict must be yes, no or unsure"):
            self.standard()

    def test_members_join_every_facet_their_labels_name(self):
        from study_qgs import member_facets
        topic = load_topic(self.repo, "demo")
        self.assertEqual(member_facets(topic, {"o/a": ["X1", "X2"], "o/g": ["X2", "X3"], "o/e": ["X3"]}), {"o/a": ["alpha"], "o/g": ["alpha", "beta"], "o/e": ["beta"]})

    def test_the_standard_is_written_for_the_resolver_and_keeps_the_labels(self):
        self.judged()
        verdicts(self.work / "config-qgs-reader.jsonl", [(2, "o/b", "no", []), (4, "o/d", "yes", ["X1"]), (5, "o/e", "yes", ["X3"])])
        script("qgs-standard").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--stratum", "config", "--write"])
        written = json.loads((self.work / "config-qgs-adjudicated.json").read_text())
        self.assertEqual((written["final"], written["labels"]["o/g"]), (["o/a", "o/g", "o/d", "o/e"], ["X2", "X3"]))
        self.assertIn("both Claude judges answered yes, or the reader's yes on a queued candidate", written["rule"])
        with self.assertRaisesRegex(SystemExit, "once per topic"):
            script("qgs-standard").main(["--topic", "demo:alpha", "--repo", str(self.repo), "--work", str(self.work), "--stratum", "config", "--write"])


if __name__ == "__main__":
    unittest.main()
