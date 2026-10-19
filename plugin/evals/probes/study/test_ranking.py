import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from study_fixtures import HERE, FakeFetch, script, topic_repo, write_json, write_jsonl
from study_rank import Ranker, rank_product
from study_topic import TopicError, load_topic


def row(repo, via=(), channels=("github-repo-search",), pushed="2026-09-01", created="2026-01-01", description=""):
    return {"repo": repo, "channels": list(channels), "via": list(via), "pushed": pushed, "created": created, "description": description, "stars": 1}


class RankerTest(unittest.TestCase):
    def setUp(self):
        self.cache = Path(tempfile.mkdtemp(prefix="study-cache-"))
        self.addCleanup(shutil.rmtree, self.cache)

    def tree(self, repo, paths, shas=None):
        name = repo.lower().replace("/", "__") + ".json"
        write_json(self.cache / "trees" / name, {"paths": paths})
        write_json(self.cache / "asset-shas" / name, {"shas": shas or {}})

    def test_focus_order_drops_vendored_and_copied_assets(self):
        self.tree("o/focused", ["skills/tdd/SKILL.md"], {"skills/tdd/SKILL.md": "s1"})
        self.tree("o/big", ["skills/tdd/SKILL.md", "skills/docs/SKILL.md", "skills/web/SKILL.md", "skills/api/SKILL.md"], {"skills/tdd/SKILL.md": "s2"})
        self.tree("o/vendor", ["fixtures/skills/tdd/SKILL.md", "examples/tdd/.claude/x"])
        self.tree("o/copy", ["skills/tdd/SKILL.md"], {"skills/tdd/SKILL.md": "s1"})
        rows = [row("o/copy", created="2026-05-01"), row("o/focused", created="2026-01-01"), row("o/big"), row("o/vendor")]
        ranked = Ranker(["tdd"], self.cache).rank(rows)
        by = {r["repo"]: r for r in ranked["rows"]}
        self.assertEqual([r["repo"] for r in ranked["rows"]], ["o/focused", "o/big", "o/copy", "o/vendor"])
        self.assertEqual((by["o/focused"]["order"], by["o/big"]["focus"]), (2.0, 0.25))
        self.assertEqual((by["o/vendor"]["unit_count"], by["o/vendor"]["vendored_hits"]), (0, 2))
        self.assertEqual((by["o/copy"]["unit_count"], by["o/copy"]["copied_units"]), (0, 1))

    def test_code_queries_name_and_social_hits_add_to_the_order(self):
        self.tree("o/a", [])
        via = ["code \"failing test\" filename:SKILL.md: a/SKILL.md", "code \"failing test\" filename:SKILL.md: b/SKILL.md", "code tdd filename:AGENTS.md: AGENTS.md", 'x "tdd skill"']
        ranked = Ranker(["tdd", "test"], self.cache).rank([row("o/a", via=via, channels=("github-code-search", "x"), description="a tdd kit")])
        self.assertEqual(ranked["rows"][0]["code_queries"], ['code "failing test" filename:SKILL.md', "code tdd filename:AGENTS.md"])
        self.assertEqual(ranked["rows"][0]["order"], 2 + 1 + 0.5)

    def test_aggregators_are_split_off_and_their_held_repositories_snowball(self):
        self.tree("o/awesome-tdd", [])
        held = ["repos/A@one/skills/tdd/SKILL.md", "repos/B@two/x.md", "repos/C@three/y.md"]
        self.tree("o/held-kit", held)
        ranked = Ranker(["tdd"], self.cache).rank([row("o/awesome-tdd", description="curated"), row("o/held-kit")])
        self.assertEqual(ranked["rows"], [])
        self.assertEqual({a["repo"]: a["aggregator"] for a in ranked["aggregators"]}, {"o/awesome-tdd": ["text"], "o/held-kit": ["foreign-paths"]})
        self.assertEqual(ranked["snowball_from_paths"], {"a/one": ["o/held-kit"]})

    def test_the_product_order_counts_channels_contract_files_and_a_name_hit(self):
        pool = [{"repo": "o/tdd-guard", "evidence": {"npm": ["p"], "code": ["a.ts", "b.ts", "c.ts"]}, "description": "", "stars": 1, "created": "2026-01-01T0",
                 "pushed": "2026-02-01T0", "archived": False, "fork": False},
                {"repo": "o/awesome-hooks", "evidence": {"repo": ["r"]}, "description": "", "stars": 1, "created": "2026", "pushed": "2026", "archived": False, "fork": False}]
        ranked = rank_product(pool, ["tdd"])
        self.assertEqual([(r["repo"], r["order"], r["order_rank"]) for r in ranked["rows"]], [("o/tdd-guard", 5.0, 1)])
        self.assertEqual(ranked["aggregators"], [{"repo": "o/awesome-hooks", "description": ""}])


class OrderAndSnowballTest(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo()
        self.work = Path(tempfile.mkdtemp(prefix="study-work-"))
        for path in (self.repo, self.work):
            self.addCleanup(shutil.rmtree, path)
        self.topic = load_topic(self.repo, "demo")

    def ranked(self, n):
        return {"rows": [{"order_rank": i, "repo": f"o/r{i}", "order": 10 - i, "pushed": "2026-01-01"} for i in range(1, n + 1)],
                "aggregators": [{"repo": "o/forced", "description": "awesome"}]}

    def test_the_screening_order_takes_the_top_rows_and_every_forced_repository(self):
        ranked = self.ranked(5)
        ranked["rows"][3]["repo"] = "O/Forced-Late"
        topic = {**self.topic, "strata": {"config": {"forced_repos": ["o/forced-late", "o/forced", "o/absent"]}}}
        rows, missing = script("export-screening-order").screening_order(topic, "config", ranked, 2)
        self.assertEqual([(r.get("order_rank"), r["repo"], r["forced"]) for r in rows], [(1, "o/r1", False), (2, "o/r2", False), (4, "O/Forced-Late", True), (None, "o/forced", True)])
        self.assertEqual(missing, ["o/absent"])

    def test_snowballed_rows_above_the_stop_row_are_numbered_from_1001(self):
        before = self.ranked(3)
        after = {"rows": [{"repo": "s/high", "order": 9, "pushed": "2026-01-01", "channels": ["snowball"], "units": [], "stars": 0, "via": []},
                          {"repo": "s/low", "order": 1, "pushed": "2026-01-01", "channels": ["snowball"], "units": [], "stars": 0, "via": []}]}
        cut, snowballed, rows = script("snowball-above-cut").above_cut(before, after, 2)
        self.assertEqual((cut["repo"], snowballed, [(r["order_rank"], r["repo"]) for r in rows]), ("o/r2", 2, [(1001, "s/high")]))
        with self.assertRaisesRegex(TopicError, "no row 9"):
            script("snowball-above-cut").above_cut(before, after, 9)

    def test_aggregator_readmes_snowball_linked_repositories_with_a_topic_term(self):
        write_json(self.work / "config-ranked.json", {"rows": [{"repo": "o/known"}], "aggregators": [{"repo": "l/awesome", "description": "awesome"}, {"repo": "l/dead", "description": ""}],
                                                      "snowball_from_paths": {"p/held": ["o/mirror"]}})
        readme = "# Testing\n- [x](https://github.com/n/new) tdd hook\n- [y](https://github.com/o/known) tdd\n- [z](https://github.com/n/off) a web kit\n"
        fetch = FakeFetch([("repos/l/awesome/readme", readme), ("repos/l/dead/readme", ("", "exit 1: 404"))])
        aggregators, candidates, fresh, failed = script("snowball-aggregators").snowball(self.topic, self.work, fetch, "config-ranked.json")
        self.assertEqual((aggregators, candidates, fresh, failed), (2, 3, 2, ["l/dead"]))
        state = json.loads((self.work / "snowball-state.json").read_text())
        self.assertEqual(sorted(state["hits"]), ["n/new", "p/held"])
        self.assertTrue((self.work / "cache/readmes/l__awesome.md").exists())

    def test_qgs_candidates_come_only_from_curated_lists_on_the_topic(self):
        topic = {**self.topic, "qgs_list_topic": "claude|agent"}
        write_json(self.work / "config-ranked.json", {"aggregators": [{"repo": "l/awesome-claude", "description": "curated"}, {"repo": "l/awesome-web", "description": "web"},
                                                                      {"repo": "l/mirror-claude", "description": "mirror"}]})
        fetch = FakeFetch([("repos/l/awesome-claude/readme", "## TDD\n- https://github.com/a/one tdd guard\n- https://github.com/a/one again tdd\n- https://github.com/a/two docs\n")])
        lists, failed, rows, unique = script("extract-qgs-candidates").candidates(topic, self.work, fetch, "config-ranked.json")
        self.assertEqual([l["repo"] for l in lists], ["l/awesome-claude"])
        self.assertEqual([(u["id"], u["repo"], u["heading"]) for u in unique], [(1, "a/one", "TDD")])
        self.assertEqual(len(rows), 2)
        with self.assertRaisesRegex(TopicError, "qgs_list_topic"):
            script("extract-qgs-candidates").candidates(self.topic, self.work, fetch, "config-ranked.json")

    def test_qgs_recall_reports_kappa_and_quasi_sensitivity(self):
        verdicts = [("a/one", "yes", "yes"), ("a/two", "yes", "no"), ("a/three", "no", "no"), ("a/four", "yes", "yes")]
        for side, index in (("A", 1), ("B", 2)):
            write_jsonl(self.work / f"qgs-judge-{side}.jsonl", [{"id": i, "repo": v[0], "verdict": v[index]} for i, v in enumerate(verdicts)])
        write_json(self.work / "qgs-adjudicated.json", {"final": ["a/one", "a/two", "a/four"]})
        write_json(self.work / "product-state.json", {"hits": {"a/one": {"channels": {"npm": [], "code": []}}, "a/two": {"channels": {"npm": []}}}})
        out, _ = script("qgs-recall").recall(self.work, self.work, ["product"])
        self.assertEqual((out["agreement"], out["kappa"]), (0.75, 0.5))
        self.assertEqual(out["standards"]["strict (yes by both)"], {"size": 2, "found": 1, "quasi_sensitivity": 0.5, "per_channel": {"code": 1, "npm": 1}, "missed": ["a/four"]})
        self.assertEqual(out["standards"]["adjudicated (source read)"]["quasi_sensitivity"], 0.667)

    def test_recall_at_the_cut_counts_each_stratum_against_its_own_standard(self):
        for side, verdicts in (("A", ["yes", "yes", "yes"]), ("B", ["yes", "no", "yes"])):
            write_jsonl(self.work / f"config-qgs-judge-{side}.jsonl", [{"id": i, "repo": r, "verdict": v} for i, (r, v) in enumerate(zip(["a/one", "a/two", "a/three"], verdicts))])
        write_json(self.work / "config-qgs-adjudicated.json", {"final": ["a/one", "A/Two", "a/three", "a/four"]})
        write_json(self.work / "config-state.json", {"hits": {k: {"channels": {"github-code-search": []}} for k in ("a/one", "a/two", "a/three")}})
        write_jsonl(self.work / "config-screening-order.jsonl", [{"order_rank": 1, "repo": "a/one", "forced": False}, {"order_rank": 2, "repo": "a/two", "forced": True},
                                                                 {"order_rank": 9, "repo": "a/three", "forced": False}])
        result = subprocess.run([sys.executable, "-B", str(HERE / "qgs-recall.py"), "--topic", "demo", "--repo", str(self.repo), "--work", str(self.work),
                                 "--states", "config", "--stratum", "config", "--cut", "3"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        self.assertEqual(out["at_cut"], {"stratum": "config", "cut": 3, "size": 4, "at_cut": 2, "recall": 0.5, "target": 0.8, "below_target": True,
                                         "missed": [{"repo": "a/three", "rank": 9}, {"repo": "a/four", "rank": None}],
                                         "fix": "below the target: change the screening-order formula or the cut, not the terms"})
        self.assertEqual(out["judged_by_both"], 3)


if __name__ == "__main__":
    unittest.main()
