import json
import shutil
import unittest

from study_fixtures import topic_repo, write_json
from study_topic import TopicError, load_topic, topic_for_sweep, write_stop_row

FACETS = {"alpha": {"sweep": "261002-demo-alpha", "problems": ["X1"], "terms": ["tdd"],
                    "strata": {"config": {"stop_row": None, "forced_repos": ["o/alpha"]}}},
          "beta": {"sweep": "261002-demo-beta", "problems": ["X2"], "terms": ["test"], "strata": {"config": {"stop_row": None, "forced_repos": []}}}}


class FacetTest(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo()
        self.addCleanup(shutil.rmtree, self.repo)
        self.path = self.repo / "docs/prior-art/topics/demo.json"
        self.write(FACETS)

    def write(self, facets, **extra):
        topic = json.loads(self.path.read_text())
        write_json(self.path, {**topic, "problems": ["X1", "X2"], "facets": facets, **extra})

    def test_a_facet_overlays_its_sweep_problems_terms_and_strata_on_the_topic(self):
        topic = load_topic(self.repo, "demo:alpha")
        self.assertEqual((topic["name"], topic["facet"], topic["sweep"], topic["problems"], topic["terms"]), ("demo:alpha", "alpha", "261002-demo-alpha", ["X1"], ["tdd"]))
        self.assertEqual(topic["strata"]["config"], {"stop_row": None, "forced_repos": ["o/alpha"], "channels": {}})
        self.assertEqual(topic["strata"]["local"], {"stop_row": None, "forced_repos": []})
        self.assertEqual(load_topic(self.repo, "demo")["sweep"], "261001-demo")

    def test_a_facet_never_inherits_the_topic_stop_row_or_forced_repositories(self):
        self.write({**FACETS, "beta": {**FACETS["beta"], "strata": {"config": {"channels": {"x": ["q"]}}}}})
        self.assertEqual(load_topic(self.repo, "demo:beta")["strata"]["config"], {"stop_row": None, "forced_repos": [], "channels": {}})

    def test_the_facets_split_the_topic_problems_once_with_distinct_sweeps(self):
        self.write({"alpha": FACETS["alpha"]})
        with self.assertRaisesRegex(TopicError, r"facets leave problems \['X2'\] in no facet"):
            load_topic(self.repo, "demo")
        self.write({**FACETS, "beta": {**FACETS["beta"], "problems": ["X1", "X2"]}})
        with self.assertRaisesRegex(TopicError, r"problem X1 sits in facets \['alpha', 'beta'\]"):
            load_topic(self.repo, "demo:alpha")
        self.write({**FACETS, "beta": {**FACETS["beta"], "sweep": "261001-demo"}})
        with self.assertRaisesRegex(TopicError, r"sweep 261001-demo is named more than once"):
            load_topic(self.repo, "demo")

    def test_a_facet_with_a_malformed_shape_is_refused(self):
        self.write({**FACETS, "alpha": {**FACETS["alpha"], "strata": {"config": None}}})
        with self.assertRaisesRegex(TopicError, r"facets\.alpha\.strata\.config must be an object"):
            load_topic(self.repo, "demo:alpha")
        self.write({**FACETS, "alpha": {**FACETS["alpha"], "terms": ["tdd", 3]}})
        with self.assertRaisesRegex(TopicError, r"facets\.alpha\.terms must be non-empty strings"):
            load_topic(self.repo, "demo:alpha")
        self.write({**FACETS, "alpha": None})
        with self.assertRaisesRegex(TopicError, r"facets\.alpha must be an object"):
            load_topic(self.repo, "demo:beta")

    def test_a_facet_must_exist_and_stay_inside_the_topic_terms_and_problems(self):
        with self.assertRaisesRegex(TopicError, "no facet gamma"):
            load_topic(self.repo, "demo:gamma")
        self.write({**FACETS, "alpha": {**FACETS["alpha"], "terms": ["tdd", "red"]}})
        with self.assertRaisesRegex(TopicError, r"facets\.alpha: terms \['red'\] are not topic terms"):
            load_topic(self.repo, "demo:alpha")
        self.write({**FACETS, "alpha": {**FACETS["alpha"], "problems": ["X9"]}})
        with self.assertRaisesRegex(TopicError, r"facets\.alpha: problems \['X9'\] are not topic problems"):
            load_topic(self.repo, "demo:alpha")
        self.write({**FACETS, "alpha": {**FACETS["alpha"], "strata": {"web": {"stop_row": None}}}})
        with self.assertRaisesRegex(TopicError, r"facets\.alpha: strata \['web'\] are not topic strata"):
            load_topic(self.repo, "demo:alpha")

    def test_the_stop_row_of_a_facet_is_written_into_the_facet_only(self):
        before = self.path.read_text()
        write_stop_row(load_topic(self.repo, "demo:beta"), "config", 70)
        after = json.loads(self.path.read_text())
        self.assertEqual((after["facets"]["beta"]["strata"]["config"]["stop_row"], after["facets"]["alpha"]["strata"]["config"]["stop_row"], after["strata"]["config"]["stop_row"]),
                         (70, None, 2))
        beta = '"sweep": "261002-demo-beta", "problems": ["X2"], "terms": ["test"], "strata": {"config": {"stop_row": '
        self.assertEqual(self.path.read_text(), before.replace(beta + "null", beta + "70"))
        self.assertEqual(load_topic(self.repo, "demo:beta")["strata"]["config"]["stop_row"], 70)

    def test_a_facet_sweep_finds_its_facet(self):
        self.assertEqual(topic_for_sweep(self.repo, "261002-demo-beta")["name"], "demo:beta")
        self.assertEqual(topic_for_sweep(self.repo, "261001-demo")["name"], "demo")
        self.write({**FACETS, "beta": {**FACETS["beta"], "sweep": "261002-demo-alpha"}})
        with self.assertRaisesRegex(TopicError, "named by 2 topic configs"):
            topic_for_sweep(self.repo, "261002-demo-alpha")


if __name__ == "__main__":
    unittest.main()
