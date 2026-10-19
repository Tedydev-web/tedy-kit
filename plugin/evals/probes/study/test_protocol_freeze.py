import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from study_fixtures import HERE, screen_row, script, topic_repo, write_json, write_jsonl
from study_topic import load_topic, sweep_folder


class FreezeTest(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo(strata={"config": {"stop_row": 3, "forced_repos": ["o/forced"], "channels": {}}})
        self.work = Path(tempfile.mkdtemp(prefix="study-freeze-"))
        for path in (self.repo, self.work):
            self.addCleanup(shutil.rmtree, path)
        topic = json.loads((self.repo / "docs/prior-art/topics/demo.json").read_text())
        topic["pilot_rows"] = 2
        topic["strata"]["local"] = {"stop_row": None, "forced_repos": []}
        topic["sessions"] = {"A": {"cli": "claude", "model": "claude-opus-5-5", "effort": "high"},
                             "B": {"candidates": [{"cli": "agy", "model": "gemini-3.8-flash-high"}, {"cli": "agy", "model": "gpt-oss-120b-medium"}],
                                   "fallback": {"cli": "claude", "model": "claude-sonnet-4-6", "effort": "high"}}}
        write_json(self.repo / "docs/prior-art/topics/demo.json", topic)
        write_jsonl(self.work / "config-screening-order.jsonl", [{"order_rank": r, "repo": f"o/{r}", "forced": r == 2} for r in (1, 2, 3, 4, 5)])
        (self.work / "screening-packet-config.md").write_text("packet\n")
        write_jsonl(self.work / "config-pilot-A.jsonl", [screen_row(r, f"o/{r}", 1, ["gate"]) for r in (1, 3)])
        write_jsonl(self.work / "config-pilot-B-gemini-3.8-flash-high.jsonl", [screen_row(1, "o/1", 1, ["gate"]), screen_row(3, "o/3", 0, [])])
        write_jsonl(self.work / "config-pilot-B-gpt-oss-120b-medium.jsonl", [screen_row(r, f"o/{r}", 1, ["gate"]) for r in (1, 3)])

    def run_freeze(self):
        return subprocess.run([sys.executable, "-B", str(HERE / "freeze-protocol.py"), "--topic", "demo", "--repo", str(self.repo), "--work", str(self.work),
                               "--criteria", "docs/prior-art/quality-criteria-v2.md", "--today", "2026-10-20"], capture_output=True, text=True)

    def test_the_freeze_pins_the_protocol_after_the_pilot_block_and_picks_session_b_by_pilot_agreement(self):
        result = self.run_freeze()
        self.assertEqual(result.returncode, 0, result.stderr)
        freeze = json.loads((self.work / "protocol-freeze.json").read_text())
        protocol = hashlib.sha256(b"criteria\n" + b"packet\n").hexdigest()[:16]
        self.assertEqual(freeze["strata"]["config"], {"frozen_after_rank": 3, "packet": "screening-packet-config.md", "protocol_sha256": protocol, "date": "2026-10-20"})
        self.assertEqual((freeze["pilot_rows"], freeze["criteria"]), (2, "docs/prior-art/quality-criteria-v2.md"))
        self.assertEqual(list(freeze["strata"]), ["config"])
        self.assertEqual(freeze["session_b"]["chosen"], {"cli": "agy", "model": "gpt-oss-120b-medium"})
        self.assertEqual({m: p["agreement"] for m, p in freeze["session_b"]["pilot"].items()}, {"gemini-3.8-flash-high": 0.5, "gpt-oss-120b-medium": 1.0})

    def test_a_pilot_block_without_session_files_is_refused(self):
        (self.work / "config-pilot-A.jsonl").unlink()
        result = self.run_freeze()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("config-pilot-A.jsonl", result.stderr)

    def test_a_missing_packet_is_refused(self):
        (self.work / "screening-packet-config.md").unlink()
        result = self.run_freeze()
        self.assertIn("screening-packet-config.md", result.stderr)

    def test_the_comparison_measures_agreement_on_post_freeze_rows_only(self):
        folder = sweep_folder(self.repo, load_topic(self.repo, "demo"))
        write_json(folder / "protocol-freeze.json", {"pilot_rows": 2, "strata": {"config": {"frozen_after_rank": 2, "protocol_sha256": "f" * 16}}})
        out = script("compare-screening-sessions").compare(folder, "config", None)
        self.assertEqual(out.get("freeze"), {"after_rank": 2, "protocol_sha256": "f" * 16, "pilot_rows_left_out": 2})
        self.assertEqual((out["rows"], out["judged_cells"], out["identical"], out["agreement"]), (2, 10, 9, 0.9))
        self.assertEqual(out["kappa"]["Authority"], 0.0)


if __name__ == "__main__":
    unittest.main()
