import json
import shutil
import tempfile
import unittest
from pathlib import Path

from study_fixtures import FakeFetch, script, topic_repo, write_json, write_jsonl
from study_topic import TopicError, load_topic

SHA = "c" * 40
TREE_ONE = ["README.md", "CHANGELOG.md", "package.json", ".github/workflows/ci.yml", "tests/test_gate.py", "tests/fixtures/deep/x.py", "skills/tdd/SKILL.md",
            "skills/tdd/notes.txt", "skills/docs/SKILL.md", "packages/core/evals/run.py", "bench/benchmarks/speed.ts", "docs/README.md"]
OWNER_REPOS = [{"name": "small", "stargazers_count": 1, "description": "x"}, {"name": "tdd-kit", "stargazers_count": 90, "description": "TDD hooks for Claude Code"},
               {"name": "forked", "stargazers_count": 900, "fork": True}]
EVIDENCE = [("repos/o/one/releases", json.dumps([{"tag_name": "v1.2", "published_at": "2026-09-01T00:00:00Z"}])), ("repos/o/one/tags", json.dumps([{"name": "v1.2"}, {"name": "v1.1"}])),
            ("users/o/repos?per_page=100&type=owner", json.dumps(OWNER_REPOS)), ("users/o", json.dumps({"public_repos": 12})), ("contents/package.json", json.dumps({"name": "@o/tdd-kit"})),
            ("registry.npmjs.org/@o%2Ftdd-kit", json.dumps({"dist-tags": {"latest": "1.2.0"}})), ("contents/CHANGELOG.md", "## 1.2\n- red step\n"),
            ("/releases", "[]"), ("/tags", "[]")]
POOL = [{"order_rank": 1, "repo": "o/one", "order": 3, "units": ["skills/tdd"], "stars": 3, "pushed": "2026-09-01", "created": "2025-01-01", "channels": ["code"],
         "closed_issues": 4, "merged_prs": 9, "license": "MIT", "archived": False},
        {"order_rank": 2, "repo": "o/two", "order": 2, "contract_files": ["src/hook.ts", "src/gone.ts"], "stars": 1, "pushed": "2026-09-01", "channels": ["code"],
         "closed_issues": 0, "merged_prs": 0, "license": "none", "archived": False}]


class InputsTest(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo()
        self.work = Path(tempfile.mkdtemp(prefix="study-inputs-"))
        for path in (self.repo, self.work):
            self.addCleanup(shutil.rmtree, path)
        self.topic = load_topic(self.repo, "demo")
        rows, _ = script("export-screening-order").screening_order(self.topic, "config", {"rows": POOL}, 200)
        write_jsonl(self.work / "config-screening-order.jsonl", rows)
        write_json(self.work / "cache/trees/o__one.json", {"oid": SHA, "paths": TREE_ONE})

    def fetch(self, *extra):
        return FakeFetch([*extra, *EVIDENCE, ("repos/o/two/commits/HEAD", "d" * 40 + "\n"), ("repos/o/two/git/trees/", json.dumps({"tree": [{"path": "src/hook.ts"}, {"path": "readme.md"}]})),
                          ("contents/skills/tdd/SKILL.md?ref=" + SHA, "write the failing test first"), ("contents/README.md", "# one " + "r" * 9000),
                          ("contents/src/hook.ts", "x" * 9000), ("contents/readme.md", "# two")])

    def fetch_inputs(self, fetch, **options):
        return script("fetch-screening-inputs").fetch_inputs(self.topic, self.work, "config", 200, fetch, **options)

    def rows(self):
        return {r["order_rank"]: r for r in map(json.loads, (self.work / "config-screening-inputs.jsonl").read_text().splitlines())}

    def test_inputs_pin_the_commit_and_carry_the_unit_files_readme_and_listing(self):
        self.fetch_inputs(self.fetch())
        rows = self.rows()
        self.assertEqual(rows[1]["sha"], SHA)
        self.assertEqual([(f["path"], f["text"], f["truncated"]) for f in rows[1]["files"]], [("skills/tdd/SKILL.md", "write the failing test first", False), ("skills/tdd/notes.txt", "", False)])
        self.assertEqual((len(rows[1]["readme"]), rows[1]["facts"]["stars"]), (8000, 3))
        self.assertEqual((rows[2]["sha"], rows[2]["readme"], rows[2]["files"][0]["path"], len(rows[2]["files"][0]["text"]), rows[2]["files"][0]["truncated"]),
                         ("d" * 40, "# two", "src/hook.ts", 8000, True))
        again = FakeFetch()
        self.fetch_inputs(again)
        self.assertEqual(again.calls, [])

    def test_the_anchor_facts_come_through_the_real_screening_order(self):
        self.fetch_inputs(self.fetch())
        self.assertEqual({k: self.rows()[1]["facts"][k] for k in ("closed_issues", "merged_prs", "license", "pushed")},
                         {"closed_issues": 4, "merged_prs": 9, "license": "MIT", "pushed": "2026-09-01"})

    def test_inputs_carry_the_evidence_the_anchors_score_on(self):
        self.fetch_inputs(self.fetch())
        row = self.rows()[1]
        self.assertEqual(row.get("evidence"), {"releases": {"count": 1, "latest": "v1.2", "published": "2026-09-01"}, "tags": {"count": 2, "latest": "v1.2"},
                                               "owner_public_repos": 12,
                                               "owner_top_repos": [{"name": "tdd-kit", "stars": 90, "description": "TDD hooks for Claude Code"}, {"name": "small", "stars": 1, "description": "x"}],
                                               "workflows": ["ci.yml"],
                                               "tests": {"count": 4, "paths": ["bench/benchmarks/speed.ts", "packages/core/evals/run.py", "tests/fixtures/deep/x.py", "tests/test_gate.py"]},
                                               "changelog_head": "## 1.2\n- red step\n", "package": {"npm": {"name": "@o/tdd-kit", "published": True, "latest": "1.2.0"}}})

    def test_release_and_tag_counts_at_the_page_cap_read_100_plus(self):
        self.fetch_inputs(self.fetch(("repos/o/one/releases", json.dumps([{"tag_name": f"v{i}"} for i in range(100)])), ("repos/o/one/tags", json.dumps([{"name": "t"}] * 100))))
        self.assertEqual((self.rows()[1]["evidence"]["releases"]["count"], self.rows()[1]["evidence"]["tags"]["count"]), ("100+", "100+"))

    def test_test_paths_are_capped_by_count(self):
        write_json(self.work / "cache/trees/o__one.json", {"oid": SHA, "paths": ["README.md"] + [f"tests/t{i:02}.py" for i in range(40)]})
        self.fetch_inputs(self.fetch())
        tests = self.rows()[1]["evidence"]["tests"]
        self.assertEqual((tests["count"], len(tests["paths"])), (40, 30))

    def test_only_a_root_readme_counts(self):
        write_json(self.work / "cache/trees/o__one.json", {"oid": SHA, "paths": ["docs/README.md", "README.rst"]})
        self.fetch_inputs(self.fetch(("contents/README.rst", "rst readme")))
        self.assertEqual(self.rows()[1]["readme"], "rst readme")
        write_json(self.work / "cache/trees/o__one.json", {"oid": SHA, "paths": ["docs/README.md"]})
        (self.work / "config-screening-inputs.jsonl").unlink()
        self.fetch_inputs(self.fetch())
        self.assertEqual((self.rows()[1]["readme"], self.rows()[1]["missing"]), ("", ["README: no root README in the pinned tree"]))

    def test_a_fetched_tree_is_cached_so_a_refetch_keeps_the_pinned_commit(self):
        self.fetch_inputs(self.fetch(("contents/src/hook.ts", ("", "exit 1: HTTP 502"))))
        self.assertEqual(json.loads((self.work / "cache/trees/o__two.json").read_text())["oid"], "d" * 40)
        again = self.fetch(("repos/o/two/commits/HEAD", "e" * 40 + "\n"))
        self.fetch_inputs(again)
        self.assertEqual((again.called("repos/o/two/commits/HEAD"), self.rows()[2]["sha"]), ([], "d" * 40))

    def test_only_a_gone_repository_or_commit_is_permanent_and_a_missing_file_is_scored(self):
        self.fetch_inputs(self.fetch(("repos/o/two/git/trees/", ("", "exit 1: HTTP 502")), ("contents/README.md", ("", "exit 1: HTTP 404"))))
        rows = self.rows()
        self.assertEqual((rows[2].get("error"), rows[2].get("error_kind")), ("tree: exit 1: HTTP 502", "transient"))
        self.assertEqual((rows[1].get("error"), rows[1].get("missing")), (None, ["README: exit 1: HTTP 404"]))
        again = self.fetch()
        self.fetch_inputs(again)
        self.assertTrue(again.called("repos/o/two/git/trees/"))
        self.assertEqual(again.called("repos/o/one"), [])
        self.assertEqual((self.rows()[2].get("error"), self.rows()[2]["missing"]), (None, ["src/gone.ts: not in the pinned tree"]))
        for status in ("exit 1: gh: Not Found (HTTP 404)", "exit 1: GraphQL: Could not resolve to a Repository with the name 'o/two'", "exit 1: HTTP 410"):
            (self.work / "config-screening-inputs.jsonl").unlink()
            (self.work / "cache/trees/o__two.json").unlink(missing_ok=True)
            self.fetch_inputs(self.fetch(("repos/o/two/commits/HEAD", ("", status))))
            self.assertEqual(self.rows()[2]["error_kind"], "permanent", status)

    def test_a_dns_failure_is_transient_and_an_unpublished_package_is_not_an_error(self):
        self.fetch_inputs(self.fetch(("registry.npmjs.org", ("", "exit 6: curl: (6) Could not resolve host: registry.npmjs.org"))))
        self.assertEqual((self.rows()[1]["error_kind"], self.rows()[1]["error"]), ("transient", "npm: exit 6: curl: (6) Could not resolve host: registry.npmjs.org"))
        self.fetch_inputs(self.fetch(("registry.npmjs.org", ("", "exit 22: The requested URL returned error: 404"))))
        self.assertEqual((self.rows()[1].get("error"), self.rows()[1]["evidence"]["package"]["npm"]), (None, {"name": "@o/tdd-kit", "published": False}))

    def test_a_package_the_registry_lists_as_unpublished_is_not_published(self):
        unpublished = json.dumps({"_id": "@o/tdd-kit", "name": "@o/tdd-kit", "time": {"created": "2024-03-26", "unpublished": {"time": "2024-03-27", "versions": ["2.8.0"]}}})
        self.fetch_inputs(self.fetch(("registry.npmjs.org", unpublished)))
        self.assertEqual((self.rows()[1].get("error"), self.rows()[1]["evidence"]["package"]["npm"]), (None, {"name": "@o/tdd-kit", "published": False}))

    def test_a_forced_aggregator_in_the_order_is_fetched_like_any_row(self):
        ranked = {"rows": POOL, "aggregators": [{"repo": "o/forced", "description": "awesome list"}]}
        rows, _ = script("export-screening-order").screening_order(self.topic, "config", ranked, 200)
        write_jsonl(self.work / "config-screening-order.jsonl", rows)
        self.fetch_inputs(self.fetch())
        self.assertEqual(self.rows()[3]["repo"], "o/forced")

    def test_the_pilot_set_is_the_first_pilot_rows_unforced_rows_only(self):
        ranked = {"rows": POOL, "aggregators": [{"repo": "o/forced", "description": "awesome list"}]}
        rows, _ = script("export-screening-order").screening_order(self.topic, "config", ranked, 200)
        write_jsonl(self.work / "config-screening-order.jsonl", rows)
        ranks = script("fetch-screening-inputs").set_ranks({**self.topic, "pilot_rows": 1}, self.work, "config", "pilot")
        self.assertEqual(ranks, {1})
        self.fetch_inputs(self.fetch(), ranks=ranks)
        self.assertEqual(sorted(self.rows()), [1])

    def test_an_unparsable_or_empty_tree_is_a_transient_error(self):
        for body, message in (("not json", "tree: unparsable"), (json.dumps({"tree": []}), "tree: empty")):
            (self.work / "config-screening-inputs.jsonl").unlink(missing_ok=True)
            self.fetch_inputs(self.fetch(("repos/o/two/git/trees/", body)))
            self.assertEqual((self.rows()[2].get("error"), self.rows()[2].get("error_kind")), (message, "transient"))

    def test_a_truncated_tree_is_partial_never_dead(self):
        write_json(self.work / "cache/trees/o__one.json", {"oid": SHA, "paths": ["README.md"], "truncated": True})
        fetch = self.fetch((f"git/trees/{SHA}?recursive=1", json.dumps({"tree": [{"path": "a/b.md"}], "truncated": True})),
                           (f"git/trees/{SHA}", json.dumps({"tree": [{"path": "README.md"}, {"path": "skills"}]})),
                           (f"contents/skills/tdd?ref={SHA}", json.dumps([{"path": "skills/tdd/SKILL.md"}])))
        self.fetch_inputs(fetch)
        row = self.rows()[1]
        self.assertEqual((row.get("error"), row["tree"], row["sha"], [f["path"] for f in row["files"]]), (None, "partial", SHA, ["skills/tdd/SKILL.md"]))
        self.assertEqual(fetch.called("repos/o/one/commits/HEAD"), [])
        self.assertEqual(json.loads((self.work / "cache/trees/o__one.json").read_text())["paths"], ["README.md", "a/b.md", "skills", "skills/tdd/SKILL.md"])

    def test_a_failed_unit_listing_in_a_partial_tree_is_a_transient_error_and_is_not_cached(self):
        write_json(self.work / "cache/trees/o__one.json", {"oid": SHA, "paths": ["README.md"], "truncated": True})
        trees = ((f"git/trees/{SHA}?recursive=1", json.dumps({"tree": [{"path": "a/b.md"}], "truncated": True})),
                 (f"git/trees/{SHA}", json.dumps({"tree": [{"path": "README.md"}, {"path": "skills"}]})))
        self.fetch_inputs(self.fetch(*trees, (f"contents/skills/tdd?ref={SHA}", ("", "exit 1: HTTP 502"))))
        self.assertEqual((self.rows()[1]["error"], self.rows()[1]["error_kind"]), ("unit skills/tdd: exit 1: HTTP 502", "transient"))
        self.assertFalse(json.loads((self.work / "cache/trees/o__one.json").read_text()).get("partial"))
        self.fetch_inputs(self.fetch(*trees, (f"contents/skills/tdd?ref={SHA}", json.dumps([{"path": "skills/tdd/SKILL.md"}]))))
        self.assertEqual((self.rows()[1].get("error"), self.rows()[1]["tree"]), (None, "partial"))

    def test_a_scored_rank_is_never_fetched_again(self):
        self.fetch_inputs(self.fetch(("repos/o/two/git/trees/", ("", "exit 1: HTTP 502"))))
        write_json(self.work / "meta.json", {"sessions": {"config-pilot-A": {"blocks": [{"ranks": [2]}]}}})
        again = self.fetch()
        fetched, kept, failed = self.fetch_inputs(again)
        self.assertEqual((again.called("repos/o/two"), fetched, self.rows()[2]["error"]), ([], 0, "tree: exit 1: HTTP 502"))

    def test_the_operator_marks_only_an_unscored_transient_row_permanent(self):
        self.fetch_inputs(self.fetch(("repos/o/two/git/trees/", ("", "exit 1: HTTP 502"))))
        self.fetch_inputs(FakeFetch(), mark_permanent=[2])
        self.assertEqual((self.rows()[2]["error_kind"], self.rows()[2]["error"]), ("permanent", "tree: exit 1: HTTP 502; marked permanent by the operator: repository or commit gone"))
        with self.assertRaisesRegex(TopicError, "config rank 2 is already permanent"):
            self.fetch_inputs(FakeFetch(), mark_permanent=[2])
        write_json(self.work / "meta.json", {"sessions": {"config-A": {"blocks": [{"ranks": [1]}]}}})
        with self.assertRaisesRegex(TopicError, "config rank 1 is already scored"):
            self.fetch_inputs(FakeFetch(), mark_permanent=[1])

    def test_only_a_commit_or_tree_error_can_be_marked_permanent(self):
        self.fetch_inputs(self.fetch(("registry.npmjs.org", ("", "exit 6: curl: (6) Could not resolve host: registry.npmjs.org"))))
        with self.assertRaisesRegex(TopicError, r"config rank 1 failed on npm: exit 6: .*, not on its commit or tree; only a commit: or tree: error can be marked permanent"):
            self.fetch_inputs(FakeFetch(), mark_permanent=[1])
        self.assertEqual(self.rows()[1]["error_kind"], "transient")

    def test_binary_files_are_skipped_and_each_row_is_written_as_fetched(self):
        class Breaks(FakeFetch):
            def run(self, cmd, timeout=180, cwd=None):
                if "repos/o/two" in " ".join(cmd):
                    raise RuntimeError("connection reset")
                return super().run(cmd, timeout, cwd)

        rules = [("contents/skills/tdd/SKILL.md?ref=" + SHA, "PNG\x00\x01binary"), *EVIDENCE]
        with self.assertRaises(RuntimeError):
            self.fetch_inputs(Breaks(rules))
        row = self.rows()[1]
        self.assertEqual(row["files"][0], {"path": "skills/tdd/SKILL.md", "text": "", "truncated": False, "binary": True})
        self.assertNotIn(2, self.rows())


if __name__ == "__main__":
    unittest.main()
