import json
import shutil
import tempfile
import unittest
from pathlib import Path

from study_fixtures import FakeFetch, script, topic_repo, write_json
from study_pool import Pool, work_file
from study_topic import TopicError, load_topic, terms_digest

FACETS = {"alpha": {"sweep": "261002-demo-alpha", "problems": ["X1"], "terms": ["tdd"], "strata": {"config": {"stop_row": None, "forced_repos": []}}},
          "beta": {"sweep": "261002-demo-beta", "problems": ["X2"], "terms": ["test"], "strata": {"config": {"stop_row": None, "forced_repos": []}}}}
ROW = {"stars": 1, "pushed": "2026-09-01", "created": "2026-01-01", "channels": ["github-repo-search"], "via": [], "description": "", "archived": False, "fork": False,
       "branch": "main", "oid": "a" * 40}


def snapshot(folder):
    return {str(p.relative_to(folder)): p.read_bytes() for p in sorted(folder.rglob("*")) if p.is_file()}


class FacetWorkTest(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo()
        path = self.repo / "docs/prior-art/topics/demo.json"
        write_json(path, {**json.loads(path.read_text()), "problems": ["X1", "X2"], "facets": FACETS})
        self.discovery, self.work = (Path(tempfile.mkdtemp(prefix=p)) for p in ("study-discovery-", "study-facet-"))
        for folder in (self.repo, self.discovery, self.work):
            self.addCleanup(shutil.rmtree, folder)
        digest = terms_digest(load_topic(self.repo, "demo")["terms"])
        write_json(self.discovery / "config-state.json", {"hits": {"o/kit": {"repo": "o/kit", "channels": {"github-repo-search": ["q"]}}}, "log": [], "done": [], "terms_sha256": digest})
        write_json(self.discovery / "config-pool.json", {"rows": [{**ROW, "repo": "o/kit"}, {**ROW, "repo": "o/new"}], "prisma": {}})
        write_json(self.discovery / "cache/trees/o__kit.json", {"oid": "a" * 40, "truncated": False, "paths": ["skills/tdd/SKILL.md"]})
        write_json(self.discovery / "cache/asset-shas/o__kit.json", {"truncated": False, "shas": {"skills/tdd/SKILL.md": "s1"}})
        write_json(self.discovery / "cache/meta.json", {"o/kit": {"nameWithOwner": "o/kit"}})

    def link(self, *extra):
        script("link-discovery").main(["--topic", "demo:alpha", "--repo", str(self.repo), "--work", str(self.work), "--discovery", str(self.discovery), *extra])

    def test_a_facet_folder_links_a_discovery_whose_terms_match_the_topic(self):
        self.link()
        self.assertEqual(json.loads((self.work / "discovery.json").read_text()), {"folder": str(self.discovery.resolve()), "topic": "demo",
                                                                                   "config": str((self.repo / "docs/prior-art/topics/demo.json").resolve()),
                                                                                   "terms_sha256": terms_digest(["tdd", "test"])})
        state = json.loads((self.discovery / "config-state.json").read_text())
        write_json(self.discovery / "config-state.json", {**state, "terms_sha256": terms_digest(["tdd"])})
        with self.assertRaisesRegex(SystemExit, "config-state.json was discovered with other terms"):
            self.link()
        write_json(self.discovery / "config-state.json", {k: v for k, v in state.items() if k != "terms_sha256"})
        with self.assertRaisesRegex(SystemExit, "config-state.json predates the terms digest"):
            self.link()
        with self.assertRaisesRegex(SystemExit, "is not a facet"):
            script("link-discovery").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--discovery", str(self.discovery)])

    def test_a_facet_folder_with_its_own_discovery_state_is_not_linked(self):
        write_json(self.work / "product-state.json", {"hits": {}, "log": [], "done": []})
        with self.assertRaisesRegex(SystemExit, "holds its own product-state.json"):
            self.link()

    def test_a_link_refuses_reads_once_the_topic_terms_change(self):
        self.link()
        self.assertEqual(work_file(self.work, "config-pool.json"), self.discovery / "config-pool.json")
        path = self.repo / "docs/prior-art/topics/demo.json"
        write_json(path, {**json.loads(path.read_text()), "terms": ["tdd", "test", "red"]})
        with self.assertRaisesRegex(TopicError, "links a discovery made with other terms than .*demo.json now lists"):
            work_file(self.work, "config-pool.json")
        with self.assertRaisesRegex(SystemExit, "links a discovery made with other terms"):
            script("rank-config-pool").main(["--topic", "demo:alpha", "--repo", str(self.repo), "--work", str(self.work)])

    def test_only_the_discovery_states_pools_and_caches_are_read_through_the_link(self):
        write_json(self.discovery / "snowball-state.json", {"hits": {}, "log": [], "done": [], "papers": {}})
        write_json(self.discovery / "config-ranked.json", {"rows": []})
        self.link()
        for name in ("snowball-state.json", "config-ranked.json", "cache/other/o__kit.json"):
            self.assertEqual(work_file(self.work, name), self.work / name)
        for name in ("config-state.json", "cache/trees/o__kit.json", "cache/asset-shas/o__kit.json", "cache/meta.json"):
            self.assertEqual(work_file(self.work, name), self.discovery / name)
        self.assertEqual(script("export-sweep-data").paper_rows(self.work), [])

    def test_facet_steps_read_the_linked_discovery_and_never_write_it(self):
        self.link()
        before = snapshot(self.discovery)
        fetch = FakeFetch([("repos/o/new/git/trees/", json.dumps({"tree": [{"path": "README.md", "type": "blob", "sha": "r"}]}))])
        fetched, errors = script("fetch-repo-trees").fetch_trees(self.work, "config", fetch)
        self.assertEqual((fetched, errors, len(fetch.calls)), (1, 0, 1))
        script("rank-config-pool").main(["--topic", "demo:alpha", "--repo", str(self.repo), "--work", str(self.work)])
        ranked = json.loads((self.work / "config-ranked.json").read_text())
        self.assertEqual([(r["repo"], r["unit_count"]) for r in ranked["rows"]], [("o/kit", 1), ("o/new", 0)])
        self.assertEqual(snapshot(self.discovery), before)
        self.assertTrue((self.work / "cache/trees/o__new.json").is_file())


class DiscoveryTermsTest(unittest.TestCase):
    def setUp(self):
        self.work = Path(tempfile.mkdtemp(prefix="study-terms-"))
        self.addCleanup(shutil.rmtree, self.work)

    def test_a_discovery_state_refuses_to_resume_under_other_terms(self):
        pool = Pool(self.work / "config-state.json", ["tdd", "test"])
        pool.record("repo tdd", "github-repo-search", "tdd", "ok", 0, 0, 0, 0)
        self.assertEqual(json.loads((self.work / "config-state.json").read_text())["terms_sha256"], terms_digest(["test", "TDD"]))
        Pool(self.work / "config-state.json", ["test", "tdd"])
        with self.assertRaisesRegex(TopicError, "was discovered with other terms"):
            Pool(self.work / "config-state.json", ["tdd", "test", "red"])
        write_json(self.work / "old-state.json", {"hits": {}, "log": [], "done": []})
        with self.assertRaisesRegex(TopicError, "predates the terms digest"):
            Pool(self.work / "old-state.json", ["tdd"])


if __name__ == "__main__":
    unittest.main()
