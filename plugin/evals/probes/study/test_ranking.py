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
        pool[0].update(closed_issues=2, merged_prs=7, license="MIT")
        self.assertEqual({k: rank_product(pool, ["tdd"])["rows"][0][k] for k in ("closed_issues", "merged_prs", "license")}, {"closed_issues": 2, "merged_prs": 7, "license": "MIT"})

    def test_product_contract_files_are_the_distinct_paths_the_code_search_hit(self):
        pool = [{"repo": "o/lint", "evidence": {"code": ["code SKILL.md lint extension:ts: src/a.ts", "code SKILL.md validate extension:ts: src/a.ts",
                                                         "code plugin.json schema extension:js: lib/b.js", "code SKILL.md lint extension:ts: docs/a: b.md", "code retired query extension:py: src/c.py"]},
                 "description": "", "stars": 1, "created": "2026-01-01T0", "pushed": "2026-02-01T0", "archived": False, "fork": False}]
        queries = ["SKILL.md lint extension:ts", "SKILL.md validate extension:ts", "plugin.json schema extension:js"]
        row = rank_product(pool, ["tdd"], queries)["rows"][0]
        self.assertEqual((row["contract_files"], row["order"]), (["src/a.ts", "lib/b.js", "docs/a: b.md", "src/c.py"], 3.322))


class FacetRankingTest(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo(strata={"config": {"stop_row": None, "forced_repos": [], "channels": {"code_queries": ['"tdd" filename:SKILL.md', '"test" filename:AGENTS.md']}},
                                       "product": {"stop_row": None, "forced_repos": [], "channels": {"harness": "claude", "code_fields": ["SKILL.md"], "code_terms": ["tdd", "test"],
                                                                                                      "code_extensions": ["ts"]}}})
        path = self.repo / "docs/prior-art/topics/demo.json"
        write_json(path, {**json.loads(path.read_text()), "problems": ["X1", "X2"],
                          "facets": {"alpha": {"sweep": "261020-demo-alpha", "problems": ["X1"], "terms": ["tdd"]}, "beta": {"sweep": "261020-demo-beta", "problems": ["X2"], "terms": ["test"]}}})
        self.work = Path(tempfile.mkdtemp(prefix="study-facet-rank-"))
        for path in (self.repo, self.work):
            self.addCleanup(shutil.rmtree, path)

    def test_a_facet_config_ranking_counts_only_the_code_queries_built_from_its_own_terms(self):
        base = {"stars": 1, "pushed": "2026-09-01", "created": "2026-01-01", "description": "", "archived": False, "fork": False}
        rows = [{**base, "repo": "o/lifted", "channels": ["github-code-search"], "via": ['code "test" filename:AGENTS.md: AGENTS.md']},
                {**base, "repo": "o/own", "channels": ["github-code-search"], "via": ['code "tdd" filename:SKILL.md: SKILL.md']}]
        write_json(self.work / "config-pool.json", {"rows": rows})
        script("rank-config-pool").main(["--topic", "demo:alpha", "--repo", str(self.repo), "--work", str(self.work)])
        ranked = json.loads((self.work / "config-ranked.json").read_text())
        self.assertEqual([(r["repo"], r["code_queries"]) for r in ranked["rows"]], [("o/own", ['code "tdd" filename:SKILL.md']), ("o/lifted", [])])
        self.assertEqual(ranked["code_queries_counted"], ['"tdd" filename:SKILL.md'])
        script("rank-config-pool").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work)])
        self.assertEqual(json.loads((self.work / "config-ranked.json").read_text())["code_queries_counted"], "all")

    def test_a_facet_product_ranking_counts_only_its_own_terms_and_only_product_channels(self):
        config_pool = ["config pool: name or description passes the product filter"]
        lifted = {"code": ["code SKILL.md test extension:ts: src/other.ts"], "repo": ['repos "claude test"'], "npm": ["test-kit (claude test)"], "config-pool": config_pool}
        own = {"code": ["code SKILL.md tdd extension:ts: src/own.ts"], "repo": ['repos "claude tdd"', 'repos "claude test"'], "npm": ["tdd-kit (claude tdd)"], "config-pool": config_pool}
        base = {"description": "", "stars": 1, "created": "2026-01-01T0", "pushed": "2026-02-01T0", "archived": False, "fork": False}
        pool = {"rows": [{**base, "repo": "p/lifted", "evidence": lifted}, {**base, "repo": "p/own", "evidence": own}], "prisma": {"identified": 2, "not_resolvable": 0}}
        write_json(self.work / "product-pool.json", pool)
        script("rank-product-pool").main(["--topic", "demo:alpha", "--repo", str(self.repo), "--work", str(self.work)])
        ranked = json.loads((self.work / "product-ranked.json").read_text())
        self.assertEqual([(r["repo"], r["channels"], r["contract_files"], r["order"]) for r in ranked["rows"]],
                         [("p/own", ["code", "npm", "repo"], ["src/own.ts"], 4.0), ("p/lifted", [], [], 0.0)])
        self.assertEqual(ranked["rows"][0]["evidence"]["repo"], ['repos "claude tdd"'])
        self.assertEqual(ranked["code_queries_counted"], ["SKILL.md tdd extension:ts"])
        script("rank-product-pool").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work)])
        self.assertEqual(json.loads((self.work / "product-ranked.json").read_text())["rows"][0]["channels"], ["code", "config-pool", "npm", "repo"])


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
        self.assertEqual([(r.get("order_rank"), r["repo"], r["forced"]) for r in rows], [(1, "o/r1", False), (2, "o/r2", False), (4, "O/Forced-Late", True), (6, "o/forced", True)])
        self.assertEqual(missing, ["o/absent"])

    def test_a_forced_aggregator_gets_a_rank_after_every_ranked_row(self):
        topic = {**self.topic, "strata": {"config": {"forced_repos": ["o/forced", "o/other"]}}}
        ranked = {**self.ranked(3), "aggregators": [{"repo": "o/other", "description": "curated"}, {"repo": "o/forced", "description": "awesome"}]}
        rows, _ = script("export-screening-order").screening_order(topic, "config", ranked, 2)
        self.assertEqual([(r["order_rank"], r["repo"]) for r in rows], [(1, "o/r1"), (2, "o/r2"), (4, "o/other"), (5, "o/forced")])

    def test_a_forced_row_ranked_past_1000_does_not_move_the_snowball_numbering(self):
        write_jsonl(self.work / "config-screening-order.jsonl", [{"order_rank": 1, "repo": "o/r1"}, {"order_rank": 1001, "repo": "s/old"},
                                                                 {"order_rank": 1002, "repo": "o/forced", "forced": True}, {"order_rank": 7071, "repo": "o/agg", "forced": True}])
        write_jsonl(self.work / "snowball-screening-order.jsonl", [{"order_rank": 1001, "repo": "s/new"}, {"order_rank": 1002, "repo": "s/next"}])
        write_json(self.work / "snowball-cut.json", {"stratum": "config", "cut_row": 60, "source": "the written stop row"})
        added = script("merge-snowball-order").merge(self.work)
        self.assertEqual([(r["order_rank"], r["repo"]) for r in added], [(1003, "s/new"), (1004, "s/next")])

    def test_snowballed_rows_above_the_stop_row_are_numbered_from_1001(self):
        before = self.ranked(3)
        after = {"rows": [{"repo": "s/high", "order": 9, "pushed": "2026-01-01", "channels": ["snowball"], "units": [], "stars": 0, "via": []},
                          {"repo": "s/low", "order": 1, "pushed": "2026-01-01", "channels": ["snowball"], "units": [], "stars": 0, "via": []}]}
        after["rows"][0].update(closed_issues=3, merged_prs=5, license="MIT")
        cut, snowballed, rows = script("snowball-above-cut").above_cut(before, after, 2)
        self.assertEqual((cut["repo"], snowballed, [(r["order_rank"], r["repo"]) for r in rows]), ("o/r2", 2, [(1001, "s/high")]))
        self.assertEqual({k: rows[0][k] for k in ("closed_issues", "merged_prs", "license")}, {"closed_issues": 3, "merged_prs": 5, "license": "MIT"})
        with self.assertRaisesRegex(TopicError, "no row 9"):
            script("snowball-above-cut").above_cut(before, after, 9)

    def test_under_two_stage_screening_every_snowballed_repository_joins_the_pool_that_stage_1_reads(self):
        before = self.ranked(250)
        after = {"rows": [{"repo": f"s/{name}", "order": order, "pushed": "2026-01-01", "channels": ["snowball"], "units": [], "stars": 0, "via": [], "description": "tdd kit"}
                          for name, order in (("high", 99), ("low", -5))] + [{"repo": "o/r1", "order": 9, "channels": ["github-code-search"]}]}
        write_json(self.work / "config-ranked.json", before)
        write_json(self.work / "config-ranked-snowball.json", after)
        args = ["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work)]
        script("export-screening-order").main([*args, "--stratum", "config", "--all"])
        script("snowball-above-cut").main([*args, "--all"])
        self.assertEqual(json.loads((self.work / "snowball-cut.json").read_text())["cut_row"], None)
        script("merge-snowball-order").main(args)
        order = [json.loads(line) for line in (self.work / "config-screening-order.jsonl").read_text().splitlines()]
        self.assertEqual((len(order), [(r["order_rank"], r["repo"]) for r in order[-2:]]), (253, [(1001, "s/high"), (1002, "s/low")]))
        script("build-stage1-inputs").main([*args, "--stratum", "config", "--shape", "brief"], fetch=FakeFetch())
        held = [json.loads(line)["repo"] for line in (self.work / "stage1-inputs-config-brief.jsonl").read_text().splitlines()]
        self.assertEqual((len(held), held[-2:]), (253, ["s/high", "s/low"]))
        with self.assertRaisesRegex(SystemExit, "--limit must be between 1 and 200"):
            script("export-screening-order").main([*args, "--stratum", "config", "--limit", "250"])

    def test_snowballed_rows_merge_into_the_order_without_renumbering(self):
        write_jsonl(self.work / "config-screening-order.jsonl", [{"order_rank": 1, "repo": "o/r1"}, {"order_rank": 1001, "repo": "s/old"}])
        write_jsonl(self.work / "snowball-screening-order.jsonl", [{"order_rank": 1001, "repo": "s/new"}, {"order_rank": 1002, "repo": "S/Old"}])
        write_json(self.work / "snowball-cut.json", {"stratum": "config", "cut_row": 60, "source": "the written stop row"})
        added = script("merge-snowball-order").merge(self.work)
        self.assertEqual([(r["order_rank"], r["repo"]) for r in added], [(1002, "s/new")])
        self.assertEqual([(r["order_rank"], r["repo"]) for r in map(json.loads, (self.work / "config-screening-order.jsonl").read_text().splitlines())],
                         [(1, "o/r1"), (1001, "s/old"), (1002, "s/new")])
        self.assertEqual(script("merge-snowball-order").merge(self.work), [])
        (self.work / "snowball-cut.json").unlink()
        with self.assertRaisesRegex(TopicError, "no snowball-cut.json"):
            script("merge-snowball-order").merge(self.work)

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
        aggregators = [{"repo": "l/awesome-claude", "description": "curated"}, {"repo": "l/awesome-web", "description": "web"}, {"repo": "l/mirror-claude", "description": "mirror"}]
        write_json(self.work / "config-ranked.json", {"terms": ["tdd"], "aggregators": aggregators})
        with self.assertRaisesRegex(TopicError, r"was ranked with the terms \['tdd'\], not the topic's \['tdd', 'test'\]"):
            script("extract-qgs-candidates").candidates(topic, self.work, FakeFetch(), "config-ranked.json")
        write_json(self.work / "config-ranked.json", {"terms": ["TEST", "tdd"], "aggregators": aggregators})
        fetch = FakeFetch([("repos/l/awesome-claude/readme", "## TDD\n- https://github.com/a/one tdd guard\n- https://github.com/a/one again tdd\n- https://github.com/a/two docs\n")])
        lists, failed, rows, unique = script("extract-qgs-candidates").candidates(topic, self.work, fetch, "config-ranked.json")
        self.assertEqual([l["repo"] for l in lists], ["l/awesome-claude"])
        self.assertEqual([(u["id"], u["repo"], u["heading"]) for u in unique], [(1, "a/one", "TDD")])
        self.assertEqual(len(rows), 2)
        with self.assertRaisesRegex(TopicError, "qgs_list_topic"):
            script("extract-qgs-candidates").candidates(self.topic, self.work, fetch, "config-ranked.json")

    def resolved(self, *names):
        write_json(self.work / "cache/canonical.json", {n: n for n in names})

    def test_recall_resolves_renamed_repositories_before_counting_a_miss(self):
        for side in "AB":
            write_jsonl(self.work / f"qgs-judge-{side}.jsonl", [{"id": 1, "repo": "Old/Name", "verdict": "yes"}, {"id": 2, "repo": "new/x", "verdict": "yes"}])
        write_json(self.work / "qgs-adjudicated.json", {"final": ["Old/Name", "new/x", "gone/repo"]})
        write_json(self.work / "product-state.json", {"hits": {"new/name": {"channels": {"npm": []}}, "older/x": {"channels": {"code": []}}}})
        write_json(self.work / "cache/meta.json", {"older/x": {"nameWithOwner": "New/X"}, "new/name": None})
        fetch = FakeFetch([("graphql", json.dumps({"data": {"r0": None, "r1": {"nameWithOwner": "New/X"}, "r2": {"nameWithOwner": "New/Name"}}}))])
        out, resolved = script("qgs-recall").recall(self.work, self.work, ["product"], fetch=fetch)
        self.assertEqual(out["standards"]["adjudicated (source read)"], {"size": 3, "found": 2, "quasi_sensitivity": 0.667, "per_channel": {"code": 1, "npm": 1},
                                                                         "missed": ["gone/repo"], "gone": ["gone/repo"]})
        self.assertEqual(resolved["final"], ["New/Name", "New/X", "gone/repo"])
        again = FakeFetch()
        script("qgs-recall").recall(self.work, self.work, ["product"], fetch=again)
        self.assertEqual(again.calls, [])

    def test_two_members_resolving_to_one_repository_count_once(self):
        for side in "AB":
            write_jsonl(self.work / f"qgs-judge-{side}.jsonl", [{"id": 1, "repo": "a/old", "verdict": "yes"}, {"id": 2, "repo": "a/new", "verdict": "yes"}])
        write_json(self.work / "qgs-adjudicated.json", {"final": ["a/old", "a/new"]})
        write_json(self.work / "product-state.json", {"hits": {"a/new": {"channels": {"npm": []}}}})
        write_json(self.work / "cache/canonical.json", {"a/old": "A/New", "a/new": "A/New"})
        out, resolved = script("qgs-recall").recall(self.work, self.work, ["product"], fetch=FakeFetch())
        self.assertEqual((out["standards"]["strict (yes by both)"]["size"], out["standards"]["adjudicated (source read)"]["found"], resolved["final"]), (1, 1, ["A/New"]))
        self.assertEqual((out["renamed"], out["collapsed"]), ({"a/old": "A/New"}, {"A/New": ["a/old", "a/new"]}))

    def test_discovery_resolutions_are_used_before_any_github_lookup(self):
        for side in "AB":
            write_jsonl(self.work / f"qgs-judge-{side}.jsonl", [{"id": 1, "repo": "older/x", "verdict": "yes"}, {"id": 2, "repo": "lost/y", "verdict": "yes"}])
        write_json(self.work / "qgs-adjudicated.json", {"final": ["older/x", "lost/y"]})
        write_json(self.work / "product-state.json", {"hits": {"older/x": {"channels": {"npm": []}}}})
        write_json(self.work / "cache/meta.json", {"older/x": {"nameWithOwner": "New/X"}, "lost/y": None})
        fetch = FakeFetch()
        out, resolved = script("qgs-recall").recall(self.work, self.work, ["product"], fetch=fetch)
        self.assertEqual((fetch.calls, resolved["final"], out["standards"]["adjudicated (source read)"]["gone"]), ([], ["New/X", "lost/y"], ["lost/y"]))

    def test_qgs_recall_reports_kappa_and_quasi_sensitivity(self):
        verdicts = [("a/one", "yes", "yes"), ("a/two", "yes", "no"), ("a/three", "no", "no"), ("a/four", "yes", "yes")]
        for side, index in (("A", 1), ("B", 2)):
            write_jsonl(self.work / f"qgs-judge-{side}.jsonl", [{"id": i, "repo": v[0], "verdict": v[index]} for i, v in enumerate(verdicts)])
        write_json(self.work / "qgs-adjudicated.json", {"final": ["a/one", "a/two", "a/four"]})
        write_json(self.work / "product-state.json", {"hits": {"a/one": {"channels": {"npm": [], "code": []}}, "a/two": {"channels": {"npm": []}}}})
        self.resolved("a/one", "a/two", "a/four")
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
        self.resolved("a/one", "a/two", "a/three", "a/four")
        result = subprocess.run([sys.executable, "-B", str(HERE / "qgs-recall.py"), "--topic", "demo", "--repo", str(self.repo), "--work", str(self.work),
                                 "--states", "config", "--stratum", "config", "--cut", "3"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        self.assertEqual(out["at_cut"], {"stratum": "config", "cut": 3, "size": 4, "at_cut": 2, "recall": 0.5, "target": 0.8, "below_target": True,
                                         "missed": [{"repo": "a/three", "rank": 9}, {"repo": "a/four", "rank": None}],
                                         "fix": "below the target: change the screening-order formula or the cut, not the terms",
                                         "counted": "no session files yet: rows the cut would screen"})
        self.assertEqual(out["judged_by_both"], 3)
        write_jsonl(self.work / "config-screen-A.jsonl", [{"order_rank": 1}, {"order_rank": 2}])
        write_jsonl(self.work / "config-screen-B.jsonl", [{"order_rank": 1}])
        result = subprocess.run([sys.executable, "-B", str(HERE / "qgs-recall.py"), "--topic", "demo", "--repo", str(self.repo), "--work", str(self.work),
                                 "--states", "config", "--stratum", "config", "--cut", "3"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((json.loads(result.stdout)["at_cut"]["at_cut"], json.loads(result.stdout)["at_cut"]["missed"][0]), (1, {"repo": "a/two", "rank": 2}))
        write_jsonl(self.work / "config-screen-B.jsonl", [])
        result = subprocess.run([sys.executable, "-B", str(HERE / "qgs-recall.py"), "--topic", "demo", "--repo", str(self.repo), "--work", str(self.work),
                                 "--states", "config", "--stratum", "config", "--cut", "3"], capture_output=True, text=True)
        at_cut = json.loads(result.stdout)["at_cut"]
        self.assertEqual((at_cut["at_cut"], at_cut["counted"]), (0, "rows both sessions screened: 0"))

    def test_recall_before_screening_works_without_a_cut(self):
        topic = json.loads((self.repo / "docs/prior-art/topics/demo.json").read_text())
        topic["strata"]["config"]["stop_row"] = None
        write_json(self.repo / "docs/prior-art/topics/demo.json", topic)
        for side in "AB":
            write_jsonl(self.work / f"config-qgs-judge-{side}.jsonl", [{"id": 1, "repo": "a/one", "verdict": "yes"}])
        write_json(self.work / "config-qgs-adjudicated.json", {"final": ["a/one"]})
        write_json(self.work / "config-state.json", {"hits": {"a/one": {"channels": {"github-code-search": []}}}})
        self.resolved("a/one")
        result = subprocess.run([sys.executable, "-B", str(HERE / "qgs-recall.py"), "--topic", "demo", "--repo", str(self.repo), "--work", str(self.work),
                                 "--states", "config", "--stratum", "config"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["at_cut"]["cut"], None)
        self.assertEqual(json.loads(result.stdout)["standards"]["adjudicated (source read)"]["quasi_sensitivity"], 1.0)


if __name__ == "__main__":
    unittest.main()
