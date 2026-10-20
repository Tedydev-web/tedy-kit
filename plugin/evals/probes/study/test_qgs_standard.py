import json
import shutil
import tempfile
import unittest
from pathlib import Path

from study_fixtures import FakeFetch, script, topic_repo, write_json, write_jsonl
from study_topic import TopicError, load_topic

FACETS = {"alpha": {"sweep": "261020-demo-alpha", "problems": ["X1", "X2"], "terms": ["tdd"], "strata": {"config": {"stop_row": None, "forced_repos": []}}},
          "beta": {"sweep": "261020-demo-beta", "problems": ["X3"], "terms": ["test"], "strata": {"config": {"stop_row": None, "forced_repos": []}}}}
REPOS = {1: "o/a", 2: "o/b", 3: "o/c", 4: "o/d", 5: "o/e", 6: "o/f", 7: "o/g"}


def verdicts(path, rows):
    write_jsonl(path, [{"id": i, "repo": REPOS[i], "verdict": verdict, "problems": problems, "why": "w"} for i, verdict, problems in rows])


class ClopperPearsonTest(unittest.TestCase):
    def test_the_interval_and_the_one_sided_bounds_match_the_methods_reports(self):
        from study_agreement import clopper_pearson, lower_bound, upper_bound
        self.assertEqual([tuple(round(v, 2) for v in clopper_pearson(k, n)) for k, n in ((8, 10), (16, 20), (40, 50))], [(0.44, 0.97), (0.56, 0.94), (0.66, 0.90)])
        self.assertEqual((clopper_pearson(0, 5)[0], clopper_pearson(5, 5)[1]), (0.0, 1.0))
        self.assertEqual([round(lower_bound(n, n), 4) for n in (30, 58, 59, 60)], [0.9050, 0.9497, 0.9505, 0.9513])
        self.assertGreaterEqual(lower_bound(59, 59), 0.95)
        self.assertLess(max(lower_bound(58, 58), lower_bound(59, 60)), 0.95)
        self.assertEqual([round(upper_bound(0, n), 4) for n in (100, 200)], [0.0295, 0.0149])
        with self.assertRaises(TopicError):
            clopper_pearson(1, 0)


class TopicQgsTest(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo(strata={"config": {"stop_row": None, "forced_repos": [], "channels": {}},
                                       "product": {"stop_row": None, "forced_repos": [], "channels": {"harness": "claude|hook"}}})
        path = self.repo / "docs/prior-art/topics/demo.json"
        write_json(path, {**json.loads(path.read_text()), "problems": ["X1", "X2", "X3"], "facets": FACETS, "qgs_list_topic": "claude",
                          "cross_family": {"cli": "agy", "model": "gemini-3.8-flash-high"}})
        self.work = Path(tempfile.mkdtemp(prefix="study-qgs-"))
        for folder in (self.repo, self.work):
            self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        write_jsonl(self.work / "qgs-candidates.jsonl", [{"id": i, "repo": r, "list": "l/awesome-claude", "heading": "h", "line": r} for i, r in REPOS.items()])

    def test_candidates_are_extracted_once_per_topic_never_with_facet_terms(self):
        write_json(self.work / "config-ranked.json", {"terms": ["tdd", "test"], "rows": [], "aggregators": [{"repo": "l/awesome-claude", "description": "awesome claude list"}]})
        (self.work / "cache/readmes").mkdir(parents=True)
        (self.work / "cache/readmes/l__awesome-claude.md").write_text("- [a](https://github.com/o/a) tdd guard\n- [b](https://github.com/o/b) test runner\n")
        with self.assertRaisesRegex(SystemExit, "once per topic with the topic's terms; run it with --topic demo"):
            script("extract-qgs-candidates").main(["--topic", "demo:alpha", "--repo", str(self.repo), "--work", str(self.work)], fetch=FakeFetch())
        script("extract-qgs-candidates").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work)], fetch=FakeFetch())
        self.assertEqual([json.loads(line)["repo"] for line in (self.work / "qgs-candidates.jsonl").read_text().splitlines()], ["o/a", "o/b"])

    def judged(self):
        verdicts(self.work / "qgs-judge-A.jsonl", [(1, "yes", ["X1"]), (2, "yes", ["X3"]), (3, "no", []), (4, "unsure", []), (5, "no", []), (6, "no", []), (7, "yes", ["X2", "X3"])])
        verdicts(self.work / "qgs-judge-B.jsonl", [(1, "yes", ["X2"]), (2, "no", []), (3, "no", []), (4, "no", []), (5, "no", []), (6, "no", []), (7, "yes", ["X3"])])
        write_jsonl(self.work / "qgs-cross-gemini-3.8-flash-high.jsonl", [{"repo": "O/A", "verdict": "yes", "problems": ["X1"], "why": "g"},
                                                                                 {"repo": "o/e", "verdict": "yes", "problems": ["X1"], "why": "g"},
                                                                                 {"id": 6, "repo": "o/f", "verdict": "no", "problems": [], "why": "g"}])

    def standard(self):
        from study_qgs import qgs_standard
        return qgs_standard(load_topic(self.repo, "demo"), self.work)

    def test_the_reader_reads_disagreements_unsure_rows_and_cross_family_yes_rows_both_claude_judges_rejected(self):
        self.judged()
        with self.assertRaisesRegex(TopicError, r"the reader has not judged queued candidates \[2, 4, 5\]"):
            self.standard()
        verdicts(self.work / "qgs-reader.jsonl", [(2, "no", []), (4, "yes", ["X1"]), (5, "yes", ["X3"])])
        out = self.standard()
        self.assertEqual(out["queue"], {"disputed": [2, 4], "cross_family_only": [5]})
        self.assertEqual(out["final"], ["o/a", "o/g", "o/d", "o/e"])
        self.assertEqual(out["labels"], {"o/a": ["X1", "X2"], "o/g": ["X2", "X3"], "o/d": ["X1"], "o/e": ["X3"]})
        self.assertEqual((out["cross_family"]["overlap"], out["cross_family"]["accepted_against_both"], out["cross_family"]["reader_yes"]), (3, [5], [5]))

    def test_a_candidate_judged_by_one_judge_or_none_is_a_gap_until_judged_or_dropped_with_a_reason(self):
        self.judged()
        verdicts(self.work / "qgs-reader.jsonl", [(2, "no", []), (4, "yes", ["X1"]), (5, "yes", ["X3"])])
        write_jsonl(self.work / "qgs-judge-B.jsonl", [json.loads(line) for line in (self.work / "qgs-judge-B.jsonl").read_text().splitlines()][:5])
        with self.assertRaisesRegex(TopicError, r"2 candidates are not judged by both judges: 6 o/f \(missing judge B\); 7 o/g \(missing judge B\)"):
            self.standard()
        with self.assertRaisesRegex(SystemExit, "a dropped candidate needs a reason"):
            script("drop-qgs-candidates").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--ids", "6,7", "--reason", " "])
        script("drop-qgs-candidates").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--ids", "6,7",
                                            "--reason", "the repositories are gone", "--today", "2026-10-20"])
        out = self.standard()
        self.assertEqual((out["final"], out["dropped"]), (["o/a", "o/d", "o/e"], {"6": {"repo": "o/f", "reason": "the repositories are gone", "date": "2026-10-20"},
                                                                                "7": {"repo": "o/g", "reason": "the repositories are gone", "date": "2026-10-20"}}))

    def test_a_judge_row_or_a_cross_family_row_that_names_another_repository_fails(self):
        self.judged()
        rows = [json.loads(line) for line in (self.work / "qgs-judge-B.jsonl").read_text().splitlines()]
        rows[2]["repo"] = "o/zzz"
        write_jsonl(self.work / "qgs-judge-B.jsonl", rows)
        with self.assertRaisesRegex(TopicError, r"qgs-judge-B.jsonl id 3 names 'o/zzz', but candidate 3 is 'o/c'"):
            self.standard()
        self.judged()
        verdicts(self.work / "qgs-reader.jsonl", [(2, "no", []), (4, "yes", ["X1"]), (5, "yes", ["X3"])])
        write_jsonl(self.work / "qgs-cross-gemini-3.8-flash-high.jsonl", [{"id": 2, "repo": "o/e", "verdict": "yes", "problems": ["X1"], "why": "g"}])
        with self.assertRaisesRegex(TopicError, "row id 2 names o/e, which is candidate 5; the join is by repository name and the two disagree"):
            self.standard()
        write_jsonl(self.work / "qgs-cross-gemini-3.8-flash-high.jsonl", [{"repo": "o/elsewhere", "verdict": "yes", "problems": ["X1"], "why": "g"}])
        with self.assertRaisesRegex(TopicError, "names 'o/elsewhere', which is not a candidate"):
            self.standard()

    def test_a_yes_without_a_problem_label_or_a_label_outside_the_topic_is_refused_before_it_is_written(self):
        from study_session_reply import parse_qgs_reply
        expected = {1: {"repo": "o/a"}, 2: {"repo": "o/b"}}
        reply = "\n".join(json.dumps(r) for r in ({"order_rank": 1, "repo": "o/a", "verdict": "yes", "problems": [], "why": "w"},
                                                  {"order_rank": 2, "repo": "o/b", "verdict": "no", "problems": ["X9"], "why": "w"}))
        rows, problems = parse_qgs_reply(reply, expected, ["X1", "X2", "X3"])
        self.assertEqual(rows, [])
        self.assertEqual(problems, ["rank 1 answers yes without a problem id", "rank 2 names problems ['X9'] outside the topic"])
        self.judged()
        verdicts(self.work / "qgs-judge-B.jsonl", [(1, "yes", [])])
        with self.assertRaisesRegex(TopicError, "qgs-judge-B.jsonl id 1: a yes verdict needs at least one problem id"):
            self.standard()

    def test_members_join_every_facet_their_labels_name_and_the_standard_keeps_the_labels(self):
        from study_qgs import member_facets
        self.assertEqual(member_facets(load_topic(self.repo, "demo"), {"o/a": ["X1", "X2"], "o/g": ["X2", "X3"], "o/e": ["X3"]}),
                         {"o/a": ["alpha"], "o/g": ["alpha", "beta"], "o/e": ["beta"]})
        self.judged()
        verdicts(self.work / "qgs-reader.jsonl", [(2, "no", []), (4, "yes", ["X1"]), (5, "yes", ["X3"])])
        script("qgs-standard").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--write"])
        written = json.loads((self.work / "qgs-adjudicated.json").read_text())
        self.assertEqual((written["final"], written["labels"]["o/g"], written["candidates"]), (["o/a", "o/g", "o/d", "o/e"], ["X2", "X3"], 7))
        self.assertIn("every candidate is judged by both Claude judges, or dropped with a recorded reason", written["rule"])

    def test_product_members_are_the_members_whose_name_or_list_line_passes_the_product_filter(self):
        from study_qgs import product_members
        write_jsonl(self.work / "qgs-candidates.jsonl", [{"id": 1, "repo": "o/a", "list": "l", "heading": "h", "line": "- o/a: a claude hook that runs tdd"},
                                                         {"id": 2, "repo": "o/b", "list": "l", "heading": "h", "line": "- o/b: a tdd skill"},
                                                         {"id": 3, "repo": "o/claude-test", "list": "l", "heading": "h", "line": "- o/claude-test"}])
        self.assertEqual(product_members(load_topic(self.repo, "demo"), self.work, ["o/a", "o/b", "O/Claude-Test"]), ["o/a", "O/Claude-Test"])


if __name__ == "__main__":
    unittest.main()
