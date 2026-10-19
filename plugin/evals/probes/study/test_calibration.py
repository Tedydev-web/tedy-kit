import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from study_fixtures import HERE, screen_row, topic_repo, write_json, write_jsonl
from study_topic import TopicError


def sides(work, stratum, ranks, b_value=lambda r: 1):
    write_jsonl(work / f"{stratum}-screen-A.jsonl", [{**screen_row(r, f"{stratum[0]}/{r}", 1 if r % 3 else 0, ["gate"] if r % 3 else []), "sha": "e" * 40} for r in ranks])
    write_jsonl(work / f"{stratum}-screen-B.jsonl", [screen_row(r, f"{stratum[0]}/{r}", b_value(r) if r % 3 else 0, ["gate"] if r % 3 else []) for r in ranks])
    write_json(work / f"{stratum}-mechanism-map.json", {"A": {}, "B": {}})
    write_jsonl(work / f"{stratum}-screening-inputs.jsonl", [{"order_rank": r, "repo": f"{stratum[0]}/{r}", "sha": "e" * 40, "facts": {}, "listing": ["README.md"],
                                                             "readme": f"readme {stratum} {r}", "files": [{"path": "SKILL.md", "text": f"skill text {r}", "truncated": False}]} for r in ranks])


class CalibrationTest(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo(strata={"config": {"stop_row": None, "forced_repos": []}, "product": {"stop_row": None, "forced_repos": []}, "local": {"stop_row": None, "forced_repos": []}})
        self.work = Path(tempfile.mkdtemp(prefix="study-calibration-"))
        for path in (self.repo, self.work):
            self.addCleanup(shutil.rmtree, path)
        sides(self.work, "config", range(1, 21))
        sides(self.work, "product", range(1, 13))
        write_json(self.work / "protocol-freeze.json", {"strata": {"config": {"frozen_after_rank": 4}, "product": {"frozen_after_rank": 2}}})

    def draw(self):
        return subprocess.run([sys.executable, "-B", str(HERE / "draw-calibration-sample.py"), "--topic", "demo", "--repo", str(self.repo), "--work", str(self.work)],
                              capture_output=True, text=True)

    def test_the_sample_is_ten_blind_post_freeze_rows_stratified_over_both_strata(self):
        result = self.draw()
        self.assertEqual(result.returncode, 0, result.stderr)
        sample = json.loads((self.work / "calibration-sample.json").read_text())
        rows = sample["rows"]
        self.assertEqual([sum(r["stratum"] == s for r in rows) for s in ("config", "product")], [5, 5])
        self.assertTrue(all(r["order_rank"] > {"config": 4, "product": 2}[r["stratum"]] for r in rows))
        self.assertEqual({r["stratum"] for r in rows}, {"config", "product"})
        self.assertTrue(any(r["order_rank"] % 3 == 0 for r in rows if r["stratum"] == "config") and any(r["order_rank"] % 3 for r in rows if r["stratum"] == "config"))
        self.assertEqual(set(rows[0]), {"stratum", "order_rank", "repo", "commit", "inputs_sha256", "user"})
        inputs = {r["order_rank"]: r for r in map(json.loads, (self.work / f"{rows[0]['stratum']}-screening-inputs.jsonl").read_text().splitlines())}
        canonical = json.dumps(inputs[rows[0]["order_rank"]], sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
        self.assertEqual(rows[0]["inputs_sha256"], hashlib.sha256(canonical).hexdigest())
        page = (self.work / "calibration-inputs.md").read_text()
        self.assertIn(f"skill text {rows[0]['order_rank']}", page)
        self.assertNotIn("scores", page)
        self.assertEqual(rows[0]["user"], {"Authority": None, "Methodology": None, "Objectivity": None, "Position": None, "decision": None})
        self.assertNotIn("scores", json.dumps(sample))
        first = (self.work / "calibration-sample.json").read_text()
        (self.work / "calibration-sample.json").unlink()
        self.draw()
        self.assertEqual((self.work / "calibration-sample.json").read_text(), first)

    def test_an_existing_sample_is_never_overwritten(self):
        self.draw()
        result = self.draw()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("already exists", result.stderr)

    def test_user_scores_are_compared_with_each_session(self):
        from study_calibration import calibration_agreement
        self.draw()
        sample = json.loads((self.work / "calibration-sample.json").read_text())
        for row in sample["rows"]:
            eligible = row["order_rank"] % 3 != 0
            row["user"] = {"Authority": 1 if eligible else 0, "Methodology": 1 if eligible else 0, "Objectivity": 1 if eligible else 0, "Position": 0 if eligible else 0,
                           "decision": "eligible" if eligible else "excluded: irrelevant"}
        out = calibration_agreement(sample, self.work)
        eligible_rows = sum(r["order_rank"] % 3 != 0 for r in sample["rows"])
        self.assertEqual(out["rows"], 10)
        self.assertEqual(out["A"], {"decisions": 10, "cells": 40 - eligible_rows})
        self.assertEqual(out["A"], out["B"])
        sample["rows"][0]["user"]["decision"] = None
        self.assertEqual(calibration_agreement(sample, self.work), {"rows": 9, "scored_of": 10})
        sample["rows"][1]["user"]["Methodology"] = 0.7
        with self.assertRaisesRegex(TopicError, "ratings are 1, 0.5 or 0"):
            calibration_agreement(sample, self.work)
        sample["rows"][1]["user"]["Methodology"] = 1
        sample["rows"][1]["user"]["decision"] = "maybe"
        with self.assertRaisesRegex(TopicError, "eligible or excluded"):
            calibration_agreement(sample, self.work)


if __name__ == "__main__":
    unittest.main()
