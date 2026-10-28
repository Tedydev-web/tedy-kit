import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from study_fixtures import HERE, screen_row, script, topic_repo, write_json, write_jsonl
from study_session_prompt import REPLY_FORMAT, ROWS_NOTE, TEMPLATE_SHA256
from study_topic import load_topic, sweep_folder

CRITERIA = "docs/prior-art/quality-criteria-v2.md"
B = {"cli": "agy", "model": "gemini-3.8-flash-high"}
ALSO = {"cli": "agy", "model": "gpt-oss-120b-medium"}
FALLBACK = {"cli": "claude", "model": "claude-sonnet-4-6", "effort": "high"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


class FreezeTest(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo(strata={"config": {"stop_row": 3, "forced_repos": ["o/forced"], "channels": {}}})
        self.work = Path(tempfile.mkdtemp(prefix="study-freeze-"))
        for path in (self.repo, self.work):
            self.addCleanup(shutil.rmtree, path)
        topic = json.loads((self.repo / "docs/prior-art/topics/demo.json").read_text())
        topic["pilot_rows"] = 2
        topic["strata"]["local"] = {"stop_row": None, "forced_repos": []}
        topic["sessions"] = {"A": {"cli": "claude", "model": "claude-opus-5-5", "effort": "high"}, "B": {**B, "fallback": FALLBACK, "pilot_also": [ALSO]}}
        write_json(self.repo / "docs/prior-art/topics/demo.json", topic)
        write_jsonl(self.work / "config-screening-order.jsonl", [{"order_rank": r, "repo": f"o/{r}", "forced": r == 2} for r in (1, 2, 3, 4, 5)])
        (self.work / "screening-packet-config.md").write_text("packet\n")
        write_jsonl(self.work / "config-pilot-A.jsonl", [screen_row(r, f"o/{r}", 1, ["gate"]) for r in (1, 3)])
        write_jsonl(self.work / "config-pilot-B-gemini-3.8-flash-high.jsonl", [screen_row(1, "o/1", 1, ["gate"]), screen_row(3, "o/3", 0, [])])
        write_jsonl(self.work / "config-pilot-B-gpt-oss-120b-medium.jsonl", [screen_row(r, f"o/{r}", 1, ["gate"]) for r in (1, 3)])
        self.pilot_meta(sha(b"packet\n"))

    def pilot_meta(self, packet, criteria=None, b_model="gemini-3.8-flash-high", **block):
        criteria = criteria or sha((self.repo / CRITERIA).read_bytes())
        entry = lambda cli, **extra: {"cli": cli, "model": "m", "effort": "e", "isolation": f"{cli} flags",
                                      "blocks": [{"ranks": [1, 3], "packet_sha256": packet, "criteria_sha256": criteria, "cli_version": f"{cli} 1.0", **extra}]}
        write_json(self.work / "meta.json", {"sessions": {"config-pilot-A": entry("claude"), f"config-pilot-B-{b_model}": entry("claude" if "claude" in b_model else "agy", **block)}})

    def run_freeze(self, *extra):
        return subprocess.run([sys.executable, "-B", str(HERE / "freeze-protocol.py"), "--topic", "demo", "--repo", str(self.repo), "--work", str(self.work),
                               "--criteria", CRITERIA, "--today", "2026-10-20", *extra], capture_output=True, text=True)

    def frozen(self):
        return json.loads((self.work / "protocol-freeze.json").read_text())

    def test_the_freeze_pins_full_criteria_and_packet_digests_and_the_real_pilot_size(self):
        result = self.run_freeze()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.frozen()["strata"]["config"], {"frozen_after_rank": 3, "pilot_rows": 2, "packet": "screening-packet-config.md",
                                                             "criteria_sha256": sha((self.repo / CRITERIA).read_bytes()), "packet_sha256": sha(b"packet\n"),
                                                             "template_sha256": TEMPLATE_SHA256, "date": "2026-10-20"})
        self.assertEqual(list(self.frozen()["strata"]), ["config"])

    def test_the_template_digest_covers_the_row_note_and_the_reply_format(self):
        self.assertEqual(TEMPLATE_SHA256, sha((ROWS_NOTE + "\n\n" + REPLY_FORMAT).encode()))

    def test_session_b_is_the_configured_model_even_when_another_agrees_more_with_a(self):
        self.assertEqual(self.run_freeze().returncode, 0)
        session_b = self.frozen()["session_b"]
        self.assertEqual((session_b["chosen"], session_b["rule"]), (B, "the topic config's session B"))
        self.assertEqual({m: p["agreement"] for m, p in session_b["pilot"].items()}, {"gemini-3.8-flash-high": 0.5, "gpt-oss-120b-medium": 1.0})
        self.assertEqual(self.frozen()["session_a"], {"cli": "claude", "model": "claude-opus-5-5", "effort": "high"})

    def test_without_the_configured_b_pilot_the_fallback_is_frozen_with_its_reason(self):
        (self.work / "config-pilot-B-gemini-3.8-flash-high.jsonl").rename(self.work / "config-pilot-B-claude-sonnet-4-6.jsonl")
        self.pilot_meta(sha(b"packet\n"), b_model="claude-sonnet-4-6")
        self.assertIn("the fallback claude-sonnet-4-6 screened the pilot without a recorded reason", self.run_freeze().stderr)
        self.pilot_meta(sha(b"packet\n"), b_model="claude-sonnet-4-6", fallback_reason="agy was not on PATH when this pilot ran")
        self.assertEqual(self.run_freeze().returncode, 0)
        self.assertEqual(self.frozen()["session_b"]["chosen"], FALLBACK)
        self.assertEqual(self.frozen()["session_b"]["rule"], "the topic config's fallback: agy was not on PATH when this pilot ran")

    def test_pilot_files_must_cover_every_pilot_rank(self):
        write_jsonl(self.work / "config-pilot-A.jsonl", [screen_row(1, "o/1", 1, ["gate"])])
        result = self.run_freeze()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must both cover pilot ranks [1, 3]", result.stderr)

    def test_a_packet_revised_after_the_pilot_needs_the_amendment_recorded(self):
        self.pilot_meta(sha(b"packet, pilot draft\n"))
        result = self.run_freeze()
        self.assertIn("pass --amendment", result.stderr)
        self.assertEqual(self.run_freeze("--amendment", "tightened the Position anchor").returncode, 0)
        self.assertEqual(self.frozen()["amendment"], {"pilot_packet_sha256": [sha(b"packet, pilot draft\n")], "pilot_criteria_sha256": [sha((self.repo / CRITERIA).read_bytes())],
                                                      "changed": True, "what": "tightened the Position anchor"})
        self.assertEqual((self.frozen()["cli_versions"], self.frozen()["isolation"]), ({"claude": "claude 1.0", "agy": "agy 1.0"}, {"claude": "claude flags", "agy": "agy flags"}))

    def test_a_pilot_run_under_other_criteria_needs_the_amendment_recorded(self):
        self.pilot_meta(sha(b"packet\n"), criteria="0" * 64)
        self.assertIn("the packet or the criteria changed after the pilot; pass --amendment", self.run_freeze().stderr)
        self.assertEqual(self.run_freeze("--amendment", "criteria v3 replaced v2").returncode, 0)
        self.assertEqual(self.frozen()["amendment"]["pilot_criteria_sha256"], ["0" * 64])

    def test_the_freeze_is_never_rewritten_once_a_screen_block_ran(self):
        self.assertEqual(self.run_freeze().returncode, 0)
        meta = json.loads((self.work / "meta.json").read_text())
        meta["sessions"]["config-A"] = {"blocks": [{"ranks": [4]}]}
        write_json(self.work / "meta.json", meta)
        self.assertIn("screen sessions already ran (config-A); the freeze is never rewritten", self.run_freeze().stderr)
        self.pilot_meta(sha(b"packet\n"))
        write_jsonl(self.work / "config-screen-B.jsonl", [])
        self.assertIn("screen sessions already ran (config-screen-B.jsonl)", self.run_freeze().stderr)

    def test_reference_stage1_and_calibration_judge_runs_before_the_freeze_are_not_screen_sessions(self):
        meta = json.loads((self.work / "meta.json").read_text())
        for key in ("reference-calibration-config", "judge-config-stage1-brief-claude-sonnet-5-5-run1", "citation-check-claude-opus-5-5"):
            meta["sessions"][key] = {"blocks": [{"ranks": [4]}]}
        write_json(self.work / "meta.json", meta)
        self.assertEqual(self.run_freeze().returncode, 0)

    def test_a_pilot_block_without_session_files_is_refused(self):
        (self.work / "config-pilot-A.jsonl").unlink()
        self.assertIn("config-pilot-A.jsonl", self.run_freeze().stderr)

    def test_a_missing_packet_is_refused(self):
        (self.work / "screening-packet-config.md").unlink()
        self.assertIn("screening-packet-config.md", self.run_freeze().stderr)

    def test_the_comparison_measures_agreement_on_post_freeze_rows_only(self):
        folder = sweep_folder(self.repo, load_topic(self.repo, "demo"))
        write_json(folder / "protocol-freeze.json", {"strata": {"config": {"frozen_after_rank": 2, "criteria_sha256": "c" * 64, "packet_sha256": "f" * 64}}})
        out = script("compare-screening-sessions").compare(folder, "config", None)
        self.assertEqual(out.get("freeze"), {"after_rank": 2, "criteria_sha256": "c" * 64, "packet_sha256": "f" * 64, "pilot_rows_left_out": 2})
        self.assertEqual((out["rows"], out["judged_cells"], out["identical"], out["agreement"]), (2, 8, 7, 0.875))
        self.assertEqual(out["with_date"]["agreement"], 0.9)
        self.assertEqual((out["decision_agreement"], out["kappa"]["Authority"]), (2, 0.0))

    def test_the_comparison_says_when_no_freeze_limits_its_rows(self):
        folder = sweep_folder(self.repo, load_topic(self.repo, "demo"))
        out = script("compare-screening-sessions").compare(folder, "config", None)
        self.assertEqual(out["freeze"], {"none": f"no protocol-freeze.json in {folder}: agreement covers every row both sessions screened, the pilot included; pass --folder <work> once frozen"})


if __name__ == "__main__":
    unittest.main()
