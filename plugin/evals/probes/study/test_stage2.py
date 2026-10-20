import json
import unittest

from study_topic import TopicError, load_topic
from study_v4_fixture import (OPUS, TODAY, ScriptedJudges, calibrated_work, call, inputs_fetch, judged, quiet, stage1_audited, stage1_calibrated, stage1_pooled,
                              stage2_screened, topic_qgs, write_json)


class StageTwoTest(unittest.TestCase):
    def setUp(self):
        self.judges = ScriptedJudges()
        self.repo, self.work = calibrated_work(self.judges)
        judged(self.repo, self.work, self.judges)
        stage1_calibrated(self.repo, self.work, self.judges)
        topic_qgs(self.repo, self.work, self.judges)

    def plan(self, stratum, *extra):
        quiet(self.repo, "plan-stage2", "--work", str(self.work), "--stratum", stratum, *extra)
        return json.loads((self.work / f"{stratum}-stage2.json").read_text())

    def stage1(self, stratum):
        return {json.loads(line)["order_rank"]: json.loads(line) for line in (self.work / f"stage1-{stratum}-brief-claude-sonnet-5-5.jsonl").read_text().splitlines()}

    def test_stage_2_screens_every_stage_1_pass_and_rows_without_text_pass_unread(self):
        with self.assertRaisesRegex(SystemExit, r"config: stage 1 has not screened ranks \[1, 2, 3"):
            self.plan("config")
        stage1_pooled(self.repo, self.work, self.judges)
        plan = self.plan("config")
        inputs = [json.loads(line) for line in (self.work / "stage1-inputs-config-brief.jsonl").read_text().splitlines()]
        verdicts = self.stage1("config")
        silent = [r["order_rank"] for r in inputs if not r["description"]]
        self.assertTrue(silent)
        self.assertFalse(set(silent) & set(verdicts))
        self.assertEqual(plan["passes"], sorted(silent + [r for r, v in verdicts.items() if v["verdict"] != "no"]))
        self.assertEqual((plan["order"], plan["stop"], plan["rung"], plan["auto_passes"]), (plan["passes"], None, 1, len(silent)))
        stage2_screened(self.repo, self.work, self.judges)
        screened = {json.loads(line)["order_rank"] for line in (self.work / "config-screen-A.jsonl").read_text().splitlines()}
        self.assertEqual(screened, set(plan["order"]))
        excluded = [r for r, v in verdicts.items() if v["verdict"] == "no"]
        calibration = {r["order_rank"] for r in json.loads((self.work / "calibration-set.json").read_text())["rows"] if r["stratum"] == "config"}
        self.assertTrue(set(excluded) & calibration)
        self.assertFalse(set(excluded) & screened)

    def test_when_passes_exceed_the_limit_stage_2_ranks_them_by_facet_and_stops_on_the_recall_target(self):
        stage1_pooled(self.repo, self.work, self.judges)
        plan = self.plan("product", "--limit", "40")
        stop = plan["stop"]
        self.assertEqual((len(plan["order"]), stop["depth"], stop["reached"]), (stop["depth"],) * 2 + (True,))
        self.assertLessEqual(stop["depth"], 40)
        self.assertGreaterEqual(stop["found"] / stop["members"], 0.8)
        self.assertIn("passes ranked by their best facet rank", stop["rule"])
        tight = self.plan("product", "--limit", "3")["stop"]
        self.assertEqual((tight["depth"], tight["reached"]), (3, False))
        with self.assertRaisesRegex(SystemExit, "--limit must be a positive number of rows"):
            self.plan("product", "--limit", "0")

    def test_the_stage_1_audit_lists_disagreements_draws_near_and_far_excludes_and_bounds_their_elusion(self):
        stage1_pooled(self.repo, self.work, self.judges)
        from study_stage1_audit import elusion, read_audit
        args = ["--work", str(self.work), "--stratum", "config"]
        quiet(self.repo, "draw-stage1-audit", *args)
        audit = read_audit(self.work, "config")
        verdicts = self.stage1("config")
        excluded = {r for r, v in verdicts.items() if v["verdict"] == "no"}
        self.assertEqual((audit["disagreements"], audit["excluded"], audit["near_pool"] + audit["far_pool"]), ([], len(excluded), len(excluded)))
        self.assertTrue(set(audit["near"] + audit["far"]) <= excluded and audit["near"] and audit["far"])
        with self.assertRaisesRegex(SystemExit, "already exists; the stage-1 audit is drawn once"):
            call(self.repo, "draw-stage1-audit", *args)
        quiet(self.repo, "fetch-screening-inputs", *args, "--set", "stage1-audit", fetch=inputs_fetch())
        missed = audit["near"][0]
        self.judges.flip = {verdicts[missed]["repo"]}
        quiet(self.repo, "run-judge", *args, "--judge", "screening-A", "--set", "stage1-audit", "--today", TODAY, fetch=self.judges)
        self.judges.flip = set()
        with self.assertRaisesRegex(TopicError, rf"the user has not checked stage-1 audit ranks \[{missed}\] that the screener flagged"):
            elusion(self.work, "config", OPUS)
        checks = self.work / "checks.json"
        checks.write_text(json.dumps({str(audit["far"][0]): "eligible"}))
        with self.assertRaisesRegex(SystemExit, "were not flagged by the screener; the user checks only the flagged rows"):
            call(self.repo, "import-audit-checks", *args, "--checks", str(checks))
        checks.write_text(json.dumps({str(missed): "eligible"}))
        quiet(self.repo, "import-audit-checks", *args, "--checks", str(checks))
        result = elusion(self.work, "config", OPUS)
        n = len(audit["near"])
        self.assertEqual((result["flagged"], result["near"]["misses"], result["far"]["misses"]), ([missed], [missed], []))
        self.assertGreater(result["near"]["upper"], 1 / n)
        self.assertEqual(round(result["far"]["upper"], 4), round(1 - 0.05 ** (1 / len(audit["far"])), 4))

    def test_a_stage_2_session_is_refused_without_the_stage_2_plan(self):
        stage1_pooled(self.repo, self.work, self.judges)
        quiet(self.repo, "fetch-screening-inputs", "--work", str(self.work), "--stratum", "config", "--through", "20", fetch=inputs_fetch())
        with self.assertRaisesRegex(SystemExit, "no config-stage2.json in .*; stage 2 screens the stage-1 passes plan-stage2.py lists"):
            call(self.repo, "run-screening-session", "--work", str(self.work), "--stratum", "config", "--side", "A", "--ranks", "1-20", "--today", TODAY, fetch=self.judges)
        self.plan("config")
        with self.assertRaisesRegex(SystemExit, "no stage-2 row of config lies between ranks 5000 and 5001"):
            call(self.repo, "run-screening-session", "--work", str(self.work), "--stratum", "config", "--side", "A", "--ranks", "5000-5001", fetch=self.judges)
        self.assertTrue(load_topic(self.repo, "demo"))


if __name__ == "__main__":
    unittest.main()
