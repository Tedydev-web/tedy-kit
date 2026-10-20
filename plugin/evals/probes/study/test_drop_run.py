import json
import shutil
import tempfile
import unittest
from pathlib import Path

from study_fixtures import script, topic_repo, write_json, write_jsonl

KEY = "judge-config-qgs-A-claude-opus-5-5-run1"


class DropRunTest(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo()
        self.work = Path(tempfile.mkdtemp(prefix="study-drop-"))
        for folder in (self.repo, self.work):
            self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        blocks = [{"ranks": [1, 2], "row_sha256": {"1": "a" * 64, "2": "b" * 64}}, {"ranks": [5], "row_sha256": {"5": "c" * 64}}]
        write_json(self.work / "meta.json", {"title": "t", "sessions": {KEY: {"model": "claude-opus-5-5", "blocks": blocks}}})
        write_jsonl(self.work / f"{KEY}.jsonl", [{"order_rank": r, "verdict": "yes"} for r in (1, 2, 5)])
        write_jsonl(self.work / "config-screening-inputs.jsonl", [{"order_rank": r, "repo": f"o/r{r}"} for r in (1, 2, 5)])

    def drop(self, *extra):
        script("drop-run").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--key", KEY, "--today", "2026-10-20", *extra])

    def test_a_judge_run_block_is_dropped_with_its_reason_recorded_and_the_calibration_inputs_kept(self):
        self.drop("--ranks", "1-2", "--reason", "run under the packet before the fix")
        meta = json.loads((self.work / "meta.json").read_text())
        self.assertEqual([b["ranks"] for b in meta["sessions"][KEY]["blocks"]], [[5]])
        self.assertEqual(meta["drops"], [{"key": KEY, "ranks": [1, 2], "rows": 2, "reason": "run under the packet before the fix", "date": "2026-10-20",
                                          "copy": f"dropped/{KEY}-1-2-1"}])
        self.assertEqual([json.loads(line)["order_rank"] for line in (self.work / f"{KEY}.jsonl").read_text().splitlines()], [5])
        self.assertEqual(len((self.work / "config-screening-inputs.jsonl").read_text().splitlines()), 3)
        self.assertTrue((self.work / f"dropped/{KEY}-1-2-1.rows.jsonl").is_file())

    def test_a_stage_1_pool_run_block_is_dropped_and_its_inputs_are_kept(self):
        key = "stage1-config-brief-claude-sonnet-5-5"
        meta = json.loads((self.work / "meta.json").read_text())
        meta["sessions"][key] = {"model": "claude-sonnet-5-5", "blocks": [{"ranks": [1, 2], "shape": "brief", "row_sha256": {"1": "a" * 64, "2": "b" * 64}},
                                                                         {"ranks": [3], "shape": "brief", "row_sha256": {"3": "c" * 64}}]}
        write_json(self.work / "meta.json", meta)
        write_jsonl(self.work / f"{key}.jsonl", [{"order_rank": r, "repo": f"o/r{r}", "verdict": "no", "problems": []} for r in (1, 2, 3)])
        write_jsonl(self.work / "stage1-inputs-config-brief.jsonl", [{"order_rank": r, "repo": f"o/r{r}"} for r in (1, 2, 3)])
        script("drop-run").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--key", key, "--today", "2026-10-20", "--ranks", "3-3",
                                 "--reason", "a batch over the size limit"])
        meta = json.loads((self.work / "meta.json").read_text())
        self.assertEqual([b["ranks"] for b in meta["sessions"][key]["blocks"]], [[1, 2]])
        self.assertEqual((meta["drops"][0]["key"], meta["drops"][0]["copy"]), (key, f"dropped/{key}-3-3-1"))
        self.assertEqual([json.loads(line)["order_rank"] for line in (self.work / f"{key}.jsonl").read_text().splitlines()], [1, 2])
        self.assertEqual(len((self.work / "stage1-inputs-config-brief.jsonl").read_text().splitlines()), 3)

    def test_a_drop_without_a_reason_is_refused(self):
        with self.assertRaises(SystemExit):
            self.drop("--ranks", "1-2")
        with self.assertRaisesRegex(SystemExit, "a dropped block needs a reason"):
            self.drop("--ranks", "1-2", "--reason", "  ")
        self.assertNotIn("drops", json.loads((self.work / "meta.json").read_text()))


class RetireRunTest(unittest.TestCase):
    AUDIT = "config-audit-gemini-3.8-flash-high"

    def setUp(self):
        self.repo = topic_repo()
        self.work = Path(tempfile.mkdtemp(prefix="study-retire-"))
        for folder in (self.repo, self.work):
            self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        blocks = [{"ranks": [3, 4], "row_sha256": {"3": "a" * 64, "4": "b" * 64}}]
        write_json(self.work / "meta.json", {"title": "t", "sessions": {self.AUDIT: {"cli": "agy", "model": "gemini-3.8-flash-high", "blocks": blocks},
                                                                         KEY: {"model": "claude-opus-5-5", "blocks": [{"ranks": [1], "row_sha256": {"1": "c" * 64}}]}}})
        write_jsonl(self.work / f"{self.AUDIT}.jsonl", [{"order_rank": r, "verdict": "yes"} for r in (3, 4)])
        write_jsonl(self.work / f"{KEY}.jsonl", [{"order_rank": 1, "verdict": "yes"}])

    def run_tool(self, name, key, *extra):
        script(name).main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--key", key, "--today", "2026-10-20", *extra])

    def test_a_cross_family_run_is_retired_only_once_every_block_was_dropped_and_its_file_holds_no_row(self):
        with self.assertRaisesRegex(SystemExit, f"{self.AUDIT} still records blocks; drop each with drop-run.py before it is retired"):
            self.run_tool("retire-run", self.AUDIT, "--reason", "Gemini unreachable")
        self.run_tool("drop-run", self.AUDIT, "--ranks", "3-4", "--reason", "agy quota ran out mid-run")
        with self.assertRaisesRegex(SystemExit, "a retired run needs a reason"):
            self.run_tool("retire-run", self.AUDIT, "--reason", " ")
        self.run_tool("retire-run", self.AUDIT, "--reason", "Gemini unreachable until the quota resets")
        meta = json.loads((self.work / "meta.json").read_text())
        self.assertEqual(meta["retired"], [{"key": self.AUDIT, "reason": "Gemini unreachable until the quota resets", "date": "2026-10-20"}])
        self.assertEqual(meta["sessions"][self.AUDIT]["blocks"], [])
        self.assertFalse((self.work / f"{self.AUDIT}.jsonl").exists())
        with self.assertRaisesRegex(SystemExit, f"{self.AUDIT} is already retired"):
            self.run_tool("retire-run", self.AUDIT, "--reason", "again")

    def test_a_roster_session_is_never_retired(self):
        self.run_tool("drop-run", KEY, "--ranks", "1-1", "--reason", "packet fix")
        with self.assertRaisesRegex(SystemExit, f"{KEY} is a roster session: production judges are run again after a drop, never retired; only a cross-family audit "
                                                "or QGS run is retired"):
            self.run_tool("retire-run", KEY, "--reason", "no time")
        self.assertNotIn("retired", json.loads((self.work / "meta.json").read_text()))

    def test_a_session_with_no_recorded_drop_is_not_retired(self):
        meta = json.loads((self.work / "meta.json").read_text())
        meta["sessions"][self.AUDIT]["blocks"] = []
        write_json(self.work / "meta.json", meta)
        (self.work / f"{self.AUDIT}.jsonl").write_text("")
        with self.assertRaisesRegex(SystemExit, f"meta.json records no drop of {self.AUDIT}; a run is retired only after drop-run.py dropped its blocks"):
            self.run_tool("retire-run", self.AUDIT, "--reason", "Gemini unreachable")


if __name__ == "__main__":
    unittest.main()
