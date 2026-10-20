import json
import shutil
import tempfile
import unittest
from pathlib import Path

from study_agreement import resolved_standard
from study_fixtures import FakeFetch, script, topic_repo, write_json, write_jsonl
from study_screening_input import fetch_inputs
from study_topic import TopicError, load_topic

FACETS = {"alpha": {"sweep": "261020-demo-alpha", "problems": ["X1"], "terms": ["tdd"], "strata": {"config": {"stop_row": None, "forced_repos": []}}},
          "beta": {"sweep": "261020-demo-beta", "problems": ["X2"], "terms": ["test"], "strata": {"config": {"stop_row": None, "forced_repos": ["o/forced"]}}}}


def facet_order(work, facet, repos, forced=(), counted=("q",)):
    folder = work / "facets" / facet
    write_jsonl(folder / "config-screening-order.jsonl", [{"order_rank": i, "repo": r, "units": [f"skills/{facet}"], "pushed": "2026-09-01", "forced": r in forced}
                                                          for i, r in enumerate(repos, 1)])
    write_json(folder / "config-ranked.json", {"rows": [], "aggregators": [], **({"code_queries_counted": list(counted)} if counted is not None else {})})


class MergedOrderTest(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo(strata={"config": {"stop_row": None, "forced_repos": [], "channels": {}}})
        path = self.repo / "docs/prior-art/topics/demo.json"
        write_json(path, {**json.loads(path.read_text()), "problems": ["X1", "X2"], "facets": FACETS})
        self.work = Path(tempfile.mkdtemp(prefix="study-merge-"))
        for folder in (self.repo, self.work):
            self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        self.topic = load_topic(self.repo, "demo")

    def merge(self):
        script("merge-facet-orders").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work)])
        return [json.loads(line) for line in (self.work / "config-screening-order.jsonl").read_text().splitlines()]

    def test_a_repository_ranked_in_two_facets_is_one_row_fetched_and_screened_once(self):
        facet_order(self.work, "alpha", ["o/a1", "o/shared", "o/a3"])
        facet_order(self.work, "beta", ["o/b1", "o/b2", "O/Shared", "o/forced"], forced=["o/forced"])
        rows = self.merge()
        self.assertEqual([(r["order_rank"], r["repo"]) for r in rows], [(1, "o/a1"), (2, "o/b1"), (3, "o/shared"), (4, "o/b2"), (5, "o/a3"), (6, "o/forced")])
        shared = rows[2]
        self.assertEqual((shared["facets"], shared["units"]), ({"alpha": {"rank": 2, "forced": False, "order": None}, "beta": {"rank": 3, "forced": False, "order": None}},
                                                              ["skills/alpha", "skills/beta"]))
        self.assertEqual((rows[5]["forced"], rows[5]["facets"]["beta"]["forced"]), (True, True))
        summary = json.loads((self.work / "facet-orders.json").read_text())["config"]
        self.assertEqual((summary["rows"], summary["shared"], summary["facets"]["alpha"]["code_queries_counted"]), (6, 1, ["q"]))
        fetch = FakeFetch()
        for rank in (r["order_rank"] for r in rows):
            write_json(self.work / "cache/trees" / (rows[rank - 1]["repo"].lower().replace("/", "__") + ".json"), {"oid": "e" * 40, "paths": ["README.md"]})
        fetch_inputs(self.topic, self.work, "config", 2, fetch)
        held = [json.loads(line)["repo"] for line in (self.work / "config-screening-inputs.jsonl").read_text().splitlines()]
        self.assertEqual(held, ["o/a1", "o/b1", "o/shared", "o/b2", "o/forced"])
        self.assertEqual(len(fetch.called("repos/o/shared/contents/README.md")), 1)

    def test_numbers_already_given_are_kept_and_a_dropped_repository_is_refused(self):
        facet_order(self.work, "alpha", ["o/a1", "o/a2"])
        facet_order(self.work, "beta", ["o/b1"])
        self.merge()
        facet_order(self.work, "alpha", ["o/new", "o/a1", "o/a2"])
        self.assertEqual([(r["order_rank"], r["repo"]) for r in self.merge()], [(1, "o/a1"), (2, "o/b1"), (3, "o/a2"), (4, "o/new")])
        facet_order(self.work, "alpha", ["o/a1"])
        with self.assertRaisesRegex(SystemExit, r"holds \['o/a2', 'o/new'\], which no facet order lists any more"):
            self.merge()

    def test_a_facet_ranked_without_its_counted_queries_or_a_topic_without_facets_is_refused(self):
        facet_order(self.work, "alpha", ["o/a1"], counted=None)
        facet_order(self.work, "beta", ["o/b1"])
        with self.assertRaisesRegex(SystemExit, "does not list the facet's counted code-search queries"):
            self.merge()
        with self.assertRaisesRegex(SystemExit, "runs once per topic"):
            script("merge-facet-orders").main(["--topic", "demo:alpha", "--repo", str(self.repo), "--work", str(self.work)])


class DepthTest(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo(strata={"config": {"stop_row": None, "forced_repos": [], "channels": {}}})
        path = self.repo / "docs/prior-art/topics/demo.json"
        write_json(path, {**json.loads(path.read_text()), "problems": ["X1", "X2"], "facets": FACETS})
        self.work = Path(tempfile.mkdtemp(prefix="study-depth-"))
        for folder in (self.repo, self.work):
            self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        alpha = [f"o/a{i}" for i in range(1, 161)]
        beta = [f"o/b{i}" for i in range(1, 121)]
        alpha[4], beta[99] = "o/shared", "o/shared"
        facet_order(self.work, "alpha", alpha)
        facet_order(self.work, "beta", beta)
        script("merge-facet-orders").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work)])
        self.labels = {**{f"o/a{i}": ["X1"] for i in (10, 20, 65, 150)}, **{f"o/b{i}": ["X2"] for i in (30, 66, 68)}, "o/shared": ["X2"], "o/gone": ["X2"], "o/b-missing": ["X2"]}

    def standard(self, labels):
        final = list(labels)
        write_json(self.work / "config-qgs-adjudicated.json", {"final": final, "labels": labels, "resolved": resolved_standard(final, {})})

    def plan(self, *extra):
        import contextlib
        import io
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            script("facet-depth").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--stratum", "config", *extra])
        return json.loads(printed.getvalue())

    def screen(self, ranks):
        for side in "AB":
            write_jsonl(self.work / f"config-screen-{side}.jsonl", [{"order_rank": r} for r in ranks])

    def test_depth_extends_in_blocks_of_ten_from_sixty_until_pooled_recall_reaches_the_target(self):
        self.standard(self.labels)
        out = self.plan()
        self.assertEqual((out["depth"], out["reached"], out["planned"], out["found"], out["size"]), (150, True, 8, 0, 10))
        self.assertEqual([r["found"] for r in out["rounds"]][:3], [4, 7, 7])
        self.assertEqual(out["stops"], {"alpha": {"row": 150, "rule": "recall target"}, "beta": {"row": 120, "rule": "pool exhausted"}})
        self.assertEqual((out["facets"]["alpha"]["found"], out["facets"]["alpha"]["size"]), (0, 4))
        self.assertEqual(out["facets"]["beta"]["missed"], ["o/b-missing", "o/b30", "o/b66", "o/b68", "o/gone", "o/shared"])
        self.assertEqual(len(out["unscreened"]), 150 + 120 - 1)

    def test_stops_are_written_only_after_both_sessions_screened_every_row_in_depth(self):
        self.standard(self.labels)
        with self.assertRaisesRegex(SystemExit, "lie within a facet's depth but were not screened by both sessions"):
            self.plan("--write-stop")
        order = [json.loads(line) for line in (self.work / "config-screening-order.jsonl").read_text().splitlines()]
        self.screen([r["order_rank"] for r in order])
        out = self.plan("--write-stop")
        self.assertEqual((out["found"], out["facets"]["alpha"]["found"], out["facets"]["beta"]["found"], out["interval"]), (8, 4, 4, [0.444, 0.975]))
        written = json.loads((self.repo / "docs/prior-art/topics/demo.json").read_text())["facets"]
        self.assertEqual((written["alpha"]["strata"]["config"]["stop_row"], written["beta"]["strata"]["config"]["stop_row"]), (150, 120))

    def test_a_target_out_of_reach_stops_at_the_cap_or_the_pool_and_says_so(self):
        self.standard({k: v for k, v in self.labels.items() if k != "o/a150"})
        out = self.plan()
        self.assertEqual((out["depth"], out["reached"], out["planned"]), (200, False, 7))
        self.assertEqual(out["stops"], {"alpha": {"row": 160, "rule": "pool exhausted"}, "beta": {"row": 120, "rule": "pool exhausted"}})

    def test_a_member_without_problem_labels_is_refused(self):
        final = list(self.labels)
        write_json(self.work / "config-qgs-adjudicated.json", {"final": final, "resolved": resolved_standard(final, {})})
        with self.assertRaisesRegex(SystemExit, "does not label every member with its problems; build it with qgs-standard.py --write"):
            self.plan()


if __name__ == "__main__":
    unittest.main()
