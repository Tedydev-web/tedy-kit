import json
import shutil
import tempfile
import unittest
from pathlib import Path

from study_fixtures import FakeFetch, script, topic_repo, write_json, write_jsonl
from study_topic import load_topic

SHA = "c" * 40
TREE_ONE = ["README.md", "CHANGELOG.md", "package.json", ".github/workflows/ci.yml", "tests/test_gate.py", "tests/fixtures/deep/x.py", "skills/tdd/SKILL.md",
            "skills/tdd/notes.txt", "skills/docs/SKILL.md"]
EVIDENCE = [("repos/o/one/releases", json.dumps([{"tag_name": "v1.2", "published_at": "2026-09-01T00:00:00Z"}])), ("repos/o/one/tags", json.dumps([{"name": "v1.2"}, {"name": "v1.1"}])),
            ("users/o", json.dumps({"public_repos": 12})), ("contents/package.json", json.dumps({"name": "@o/tdd-kit"})),
            ("registry.npmjs.org/@o%2Ftdd-kit", json.dumps({"dist-tags": {"latest": "1.2.0"}})), ("contents/CHANGELOG.md", "## 1.2\n- red step\n"),
            ("/releases", "[]"), ("/tags", "[]")]


class InputsTest(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo()
        self.work = Path(tempfile.mkdtemp(prefix="study-inputs-"))
        for path in (self.repo, self.work):
            self.addCleanup(shutil.rmtree, path)
        self.topic = load_topic(self.repo, "demo")
        write_jsonl(self.work / "config-screening-order.jsonl", [{"order_rank": 1, "repo": "o/one", "units": ["skills/tdd"], "stars": 3, "pushed": "2026-09-01", "forced": False,
                                                                  "closed_issues": 4, "merged_prs": 9, "license": "MIT"},
                                                                 {"order_rank": 2, "repo": "o/two", "contract_files": ["src/hook.ts"], "forced": False}])
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
        self.assertEqual((rows[2]["sha"], rows[2]["files"][0]["path"], len(rows[2]["files"][0]["text"]), rows[2]["files"][0]["truncated"]), ("d" * 40, "src/hook.ts", 8000, True))
        again = FakeFetch()
        self.fetch_inputs(again)
        self.assertEqual(again.calls, [])

    def test_inputs_carry_the_evidence_the_anchors_score_on(self):
        self.fetch_inputs(self.fetch())
        row = self.rows()[1]
        self.assertEqual(row.get("evidence"), {"releases": {"count": 1, "latest": "v1.2", "published": "2026-09-01"}, "tags": {"count": 2, "latest": "v1.2"},
                                               "owner_public_repos": 12, "workflows": ["ci.yml"], "tests": ["tests/test_gate.py"], "changelog_head": "## 1.2\n- red step\n",
                                               "package": {"npm": {"name": "@o/tdd-kit", "published": True, "latest": "1.2.0"}}})
        self.assertEqual({k: row["facts"][k] for k in ("closed_issues", "merged_prs", "license")}, {"closed_issues": 4, "merged_prs": 9, "license": "MIT"})

    def test_a_fetched_tree_is_cached_so_a_refetch_keeps_the_pinned_commit(self):
        self.fetch_inputs(self.fetch(("contents/src/hook.ts", ("", "exit 1: HTTP 502"))))
        self.assertEqual(json.loads((self.work / "cache/trees/o__two.json").read_text())["oid"], "d" * 40)
        again = self.fetch(("repos/o/two/commits/HEAD", "e" * 40 + "\n"))
        self.fetch_inputs(again)
        self.assertEqual((again.called("repos/o/two/commits/HEAD"), self.rows()[2]["sha"]), ([], "d" * 40))

    def test_errors_are_transient_unless_the_repository_or_commit_is_gone(self):
        self.fetch_inputs(self.fetch(("repos/o/two/git/trees/", ("", "exit 1: HTTP 502")), ("contents/README.md", ("", "exit 1: HTTP 404"))))
        rows = self.rows()
        self.assertEqual((rows[2].get("error"), rows[2].get("error_kind")), ("tree: exit 1: HTTP 502", "transient"))
        self.assertEqual((rows[1].get("error"), rows[1].get("error_kind")), ("README: exit 1: HTTP 404", "permanent"))
        again = self.fetch()
        self.fetch_inputs(again)
        self.assertTrue(again.called("repos/o/two/git/trees/"))
        self.assertEqual(again.called("repos/o/one"), [])
        self.assertEqual([r.get("error") for r in self.rows().values()], ["README: exit 1: HTTP 404", None])

    def test_an_unparsable_empty_or_truncated_tree_is_an_error(self):
        for body, message in (("not json", "tree: unparsable"), (json.dumps({"tree": []}), "tree: empty"), (json.dumps({"tree": [{"path": "a"}], "truncated": True}), "tree: truncated")):
            (self.work / "config-screening-inputs.jsonl").unlink(missing_ok=True)
            (self.work / "cache/trees/o__two.json").unlink(missing_ok=True)
            self.fetch_inputs(self.fetch(("repos/o/two/git/trees/", body)))
            self.assertEqual(self.rows()[2].get("error"), message)

    def test_a_scored_rank_is_never_fetched_again(self):
        self.fetch_inputs(self.fetch(("repos/o/two/git/trees/", ("", "exit 1: HTTP 502"))))
        write_json(self.work / "meta.json", {"sessions": {"config-pilot-A": {"blocks": [{"ranks": [2]}]}}})
        again = self.fetch()
        fetched, kept, failed = self.fetch_inputs(again)
        self.assertEqual((again.called("repos/o/two"), fetched, self.rows()[2]["error"]), ([], 0, "tree: exit 1: HTTP 502"))

    def test_the_operator_can_mark_an_error_permanent_to_unblock_a_stratum(self):
        self.fetch_inputs(self.fetch(("repos/o/two/git/trees/", json.dumps({"tree": [{"path": "a"}], "truncated": True}))))
        self.fetch_inputs(FakeFetch(), mark_permanent=[2])
        self.assertEqual((self.rows()[2]["error_kind"], self.rows()[2]["error"]), ("permanent", "tree: truncated; marked permanent by the operator"))

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
