import json
import shutil
import tempfile
import unittest
from pathlib import Path

from study_fixtures import FakeFetch, script, topic_repo, write_json, write_jsonl
from study_topic import load_topic

SHA = "c" * 40


class InputsTest(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo()
        self.work = Path(tempfile.mkdtemp(prefix="study-inputs-"))
        for path in (self.repo, self.work):
            self.addCleanup(shutil.rmtree, path)
        self.topic = load_topic(self.repo, "demo")
        write_jsonl(self.work / "config-screening-order.jsonl", [{"order_rank": 1, "repo": "o/one", "units": ["skills/tdd"], "stars": 3, "pushed": "2026-09-01", "forced": False},
                                                                 {"order_rank": 2, "repo": "o/two", "contract_files": ["src/hook.ts"], "forced": False}])
        write_json(self.work / "cache/trees/o__one.json", {"oid": SHA, "paths": ["README.md", "skills/tdd/SKILL.md", "skills/tdd/notes.txt", "skills/docs/SKILL.md", "package.json"]})

    def fetch(self, *extra):
        return FakeFetch([*extra, ("repos/o/two/commits/HEAD", "d" * 40 + "\n"), ("repos/o/two/git/trees/", json.dumps({"tree": [{"path": "src/hook.ts"}, {"path": "readme.md"}]})),
                          ("contents/skills/tdd/SKILL.md?ref=" + SHA, "write the failing test first"), ("contents/README.md", "# one"),
                          ("contents/src/hook.ts", "x" * 9000), ("contents/readme.md", "# two")])

    def rows(self):
        return {r["order_rank"]: r for r in map(json.loads, (self.work / "config-screening-inputs.jsonl").read_text().splitlines())}

    def test_inputs_pin_the_commit_and_carry_the_unit_files_readme_and_listing(self):
        script("fetch-screening-inputs").fetch_inputs(self.topic, self.work, "config", 200, self.fetch())
        rows = self.rows()
        self.assertEqual(rows[1]["sha"], SHA)
        self.assertEqual([(f["path"], f["text"], f["truncated"]) for f in rows[1]["files"]], [("skills/tdd/SKILL.md", "write the failing test first", False), ("skills/tdd/notes.txt", "", False)])
        self.assertEqual((rows[1]["readme"], rows[1]["listing"], rows[1]["facts"]["stars"]), ("# one", ["README.md", "package.json", "skills"], 3))
        self.assertEqual((rows[2]["sha"], rows[2]["files"][0]["path"], len(rows[2]["files"][0]["text"]), rows[2]["files"][0]["truncated"]), ("d" * 40, "src/hook.ts", 8000, True))
        again = FakeFetch()
        script("fetch-screening-inputs").fetch_inputs(self.topic, self.work, "config", 200, again)
        self.assertEqual(again.calls, [])

    def test_a_failed_tree_or_readme_marks_the_row_and_the_next_run_fetches_it_again(self):
        fetch = self.fetch(("repos/o/two/git/trees/", ("", "exit 1: HTTP 502")), ("contents/README.md", ("", "exit 1: HTTP 404")))
        script("fetch-screening-inputs").fetch_inputs(self.topic, self.work, "config", 200, fetch)
        rows = self.rows()
        self.assertEqual(rows[2].get("error"), "tree: exit 1: HTTP 502")
        self.assertEqual(rows[1].get("error"), "README: exit 1: HTTP 404")
        again = self.fetch()
        script("fetch-screening-inputs").fetch_inputs(self.topic, self.work, "config", 200, again)
        self.assertTrue(again.called("repos/o/two/git/trees/") and again.called("contents/README.md"))
        self.assertEqual([r.get("error") for r in self.rows().values()], [None, None])


if __name__ == "__main__":
    unittest.main()
