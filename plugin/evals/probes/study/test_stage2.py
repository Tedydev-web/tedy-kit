import hashlib
import json
import math
import re
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

    def plan(self, *extra):
        quiet(self.repo, "plan-stage2", "--work", str(self.work), *extra)
        return {s: json.loads((self.work / f"{s}-stage2.json").read_text()) for s in ("config", "product")}

    def repos(self, stratum):
        return {json.loads(line)["order_rank"]: json.loads(line)["repo"].lower() for line in (self.work / f"stage1-inputs-{stratum}-brief.jsonl").read_text().splitlines()}

    def stage1(self, stratum):
        return {json.loads(line)["order_rank"]: json.loads(line) for line in (self.work / f"stage1-{stratum}-brief-claude-sonnet-5-5.jsonl").read_text().splitlines()}

    def test_stage_2_screens_every_stage_1_pass_and_rows_without_text_pass_unread(self):
        with self.assertRaisesRegex(SystemExit, r"config: stage 1 has not screened ranks \[1, 2, 3"):
            self.plan()
        stage1_pooled(self.repo, self.work, self.judges)
        plan = self.plan()["config"]
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

    def test_when_passes_exceed_the_limit_stage_2_ranks_every_stratum_together_and_stops_on_pooled_recall_over_the_whole_standard(self):
        stage1_pooled(self.repo, self.work, self.judges)
        members = {m.lower() for m in json.loads((self.work / "qgs-adjudicated.json").read_text())["final"]}
        total = sum(len(p["passes"]) for p in self.plan().values())
        plans = self.plan("--limit", str(total - 1))
        stop = plans["config"]["stop"]
        self.assertEqual(stop, plans["product"]["stop"])
        self.assertEqual((stop["members"], stop["reachable"], stop["reached"]), (len(members), True, True))
        self.assertEqual(sum(len(p["order"]) for p in plans.values()), stop["depth"])
        self.assertTrue(all(p["order"] for p in plans.values()))
        found = {self.repos(s)[r] for s, p in plans.items() for r in p["order"]} & members
        self.assertEqual(stop["found"], len(found))
        self.assertGreaterEqual(len(found) / len(members), 0.8)
        self.assertLess(stop["depth"], total - 1)
        self.assertIn("passes of every stratum ranked together by their best facet rank", stop["rule"])
        tight = self.plan("--limit", "3")["config"]["stop"]
        self.assertEqual((tight["depth"], tight["reached"], tight["members"]), (3, False, len(members)))
        with self.assertRaisesRegex(SystemExit, "--limit must be a positive number of rows"):
            self.plan("--limit", "0")

    def test_when_the_losses_before_stage_2_make_the_target_unreachable_stage_2_screens_every_pass(self):
        stage1_pooled(self.repo, self.work, self.judges)
        path = self.work / "qgs-adjudicated.json"
        standard = json.loads(path.read_text())
        absent = [f"x/absent{i}" for i in range(len(standard["final"]))]
        path.write_text(json.dumps({**standard, "final": standard["final"] + absent}))
        plans = self.plan("--limit", "3")
        stop = plans["product"]["stop"]
        self.assertTrue(all(p["order"] == p["passes"] for p in plans.values()))
        self.assertEqual((stop["reachable"], stop["reached"], stop["members"]), (False, False, 2 * len(absent)))
        self.assertEqual(stop["depth"], sum(len(p["passes"]) for p in plans.values()))
        self.assertIn("unreachable", stop["rule"])

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
            elusion(load_topic(self.repo, "demo"), self.work, "config", OPUS)
        checks = self.work / "checks.json"
        checks.write_text(json.dumps({str(audit["far"][0]): "eligible"}))
        with self.assertRaisesRegex(SystemExit, "were not flagged by the screener; the user checks only the flagged rows"):
            call(self.repo, "import-audit-checks", *args, "--checks", str(checks))
        checks.write_text(json.dumps({str(missed): "eligible"}))
        quiet(self.repo, "import-audit-checks", *args, "--checks", str(checks))
        result = elusion(load_topic(self.repo, "demo"), self.work, "config", OPUS)
        n = len(audit["near"])
        self.assertEqual((result["flagged"], result["near"]["misses"], result["far"]["misses"]), ([missed], [missed], []))
        self.assertGreater(result["near"]["upper"], 1 / n)
        self.assertEqual(round(result["far"]["upper"], 4), round(1 - 0.05 ** (1 / len(audit["far"])), 4))
        self.assertEqual(result["near"]["at_most"], math.ceil(result["near"]["upper"] * audit["near_pool"]))

    def test_the_stage_1_audit_is_a_hash_ranked_draw_of_excludes_matching_facet_terms_and_elusion_redraws_it(self):
        stage1_pooled(self.repo, self.work, self.judges)
        from study_stage1_audit import elusion, sample
        topic = load_topic(self.repo, "demo")
        quiet(self.repo, "draw-stage1-audit", "--work", str(self.work), "--stratum", "config")
        path = self.work / "config-stage1-audit.json"
        audit = json.loads(path.read_text())
        inputs = {json.loads(line)["order_rank"]: json.loads(line) for line in (self.work / "stage1-inputs-config-brief.jsonl").read_text().splitlines()}
        excluded = sorted(r for r, v in self.stage1("config").items() if v["verdict"] == "no")
        facet = re.compile(r"(?<![a-z0-9])(tdd|test|guard|lint)(?![a-z0-9])", re.I)
        near = [r for r in excluded if facet.search(inputs[r]["repo"].split("/", 1)[1].replace("_", "-") + " " + inputs[r]["description"])]
        ranked = sorted(near, key=lambda r: hashlib.sha256(f"261020-demo:stage1-audit:config:near:{r}".encode()).hexdigest())
        self.assertEqual((audit["near"], audit["near_pool"]), (sorted(ranked[:200]), len(near)))
        wide = {**topic, "terms": topic["terms"] + ["web"]}
        self.assertEqual(sample(wide, self.work, "config"), audit)
        self.assertGreater(sample({**wide, "facets": {}}, self.work, "config")["near_pool"], audit["near_pool"])
        path.write_text(json.dumps({**audit, "near": audit["near"][:1], "far": audit["far"][:1]}))
        with self.assertRaisesRegex(TopicError, "config-stage1-audit.json is not the sample the stage-1 files give; the stage-1 audit is drawn once, by draw-stage1-audit.py"):
            elusion(topic, self.work, "config", OPUS)

    def test_a_stage_2_session_is_refused_without_the_stage_2_plan(self):
        stage1_pooled(self.repo, self.work, self.judges)
        quiet(self.repo, "fetch-screening-inputs", "--work", str(self.work), "--stratum", "config", "--through", "20", fetch=inputs_fetch())
        with self.assertRaisesRegex(SystemExit, "no config-stage2.json in .*; stage 2 screens the stage-1 passes plan-stage2.py lists"):
            call(self.repo, "run-screening-session", "--work", str(self.work), "--stratum", "config", "--side", "A", "--ranks", "1-20", "--today", TODAY, fetch=self.judges)
        self.plan()
        with self.assertRaisesRegex(SystemExit, "no stage-2 row of config lies between ranks 5000 and 5001"):
            call(self.repo, "run-screening-session", "--work", str(self.work), "--stratum", "config", "--side", "A", "--ranks", "5000-5001", fetch=self.judges)
        self.assertTrue(load_topic(self.repo, "demo"))


if __name__ == "__main__":
    unittest.main()
