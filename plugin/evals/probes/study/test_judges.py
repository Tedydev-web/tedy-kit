import json
import unittest

from study_judges import metrics, reader_shares_family, validate
from study_session import canonical_sha256, qgs_shape
from study_topic import TopicError, load_topic
from study_v4_fixture import (GEMINI, OPUS, TODAY, ScriptedJudges, calibrated_work, call, eligible, inputs_fetch, judged, quiet, relevant, stage1_calibrated, topic_qgs,
                              write_json)


class JudgeValidationTest(unittest.TestCase):
    def setUp(self):
        self.judges = ScriptedJudges()
        self.repo, self.work = calibrated_work(self.judges)
        self.sample = json.loads((self.work / "calibration-set.json").read_text())

    def freeze(self):
        return json.loads((self.work / "protocol-freeze.json").read_text())

    def validate(self, strata=("config", "product")):
        return validate(load_topic(self.repo, "demo"), self.work, self.freeze(), strata)

    def positives(self, stratum, test):
        return [r["repo"] for r in self.sample["rows"] if r["stratum"] == stratum and test(r["repo"])]

    def meta(self):
        return json.loads((self.work / "meta.json").read_text())["sessions"]

    def test_every_judge_runs_twice_on_its_production_shape_and_reports_sensitivity_specificity_kappa_and_label_agreement(self):
        judged(self.repo, self.work, self.judges)
        out = self.validate()
        self.assertEqual(sorted(out), ["qgs-A", "qgs-B", "reader", "screening-A", "screening-B"])
        self.assertTrue(all(entry["qualified"] for entry in out.values()))
        self.assertEqual((out["qgs-A"]["shape"], out["screening-A"]["shape"]), ("thin", "full"))
        run = out["screening-B"]["strata"]["config"]["runs"][0]
        self.assertEqual((run["sensitivity"], run["specificity"], run["kappa"], sorted(run["labels"])), (1.0, 1.0, 1.0, ["Authority", "Methodology", "Objectivity", "Position", "Relevance"]))
        self.assertEqual(run["labels"]["Relevance"]["rows"], 60)
        qgs = out["qgs-A"]["strata"]["product"]
        self.assertEqual((qgs["positives"], qgs["runs"][0]["labels"]["problems"]["agree"]), (len(self.positives("product", relevant)),) * 2)
        inputs = {json.loads(line)["order_rank"]: json.loads(line) for line in (self.work / "config-screening-inputs.jsonl").read_text().splitlines()}
        block = self.meta()["judge-config-qgs-A-claude-opus-5-5-run1"]["blocks"][0]
        rank = block["ranks"][0]
        self.assertEqual((block["shape"], block["row_sha256"][str(rank)]), ("thin", canonical_sha256(qgs_shape(inputs[rank]))))
        prompt = next(p for p in self.judges.prompts if "qgs packet" in p)
        self.assertNotIn('"files"', prompt)
        self.assertEqual(self.meta()["judge-config-screening-A-claude-opus-5-5-run1"]["blocks"][0]["shape"], "full")

    def test_a_judge_below_a_floor_does_not_qualify_and_kappa_is_compared_unrounded(self):
        judged(self.repo, self.work, self.judges, names=("screening-A", "qgs-A", "reader"))
        judged(self.repo, self.work, self.judges, names=("screening-B",), strata=("product",))
        self.judges.flip = set(self.positives("config", eligible)[:6])
        judged(self.repo, self.work, self.judges, names=("screening-B", "qgs-B"), strata=("config",))
        self.judges.flip = set()
        b = self.validate()["screening-B"]["strata"]["config"]
        self.assertFalse(b["qualified"])
        self.assertLess(b["runs"][0]["sensitivity"], 0.9)
        edge = metrics([(True, True)] * 6 + [(False, True)] * 7 + [(False, False)] * 90)
        self.assertEqual((round(edge["kappa"], 3), edge["sensitivity"], edge["passed"]), (0.6, 1.0, False))
        quiet(self.repo, "fetch-screening-inputs", "--work", str(self.work), "--set", "qgs", fetch=inputs_fetch())
        with self.assertRaisesRegex(SystemExit, r"qgs-B \(claude-sonnet-5-5\) on config, qgs-B \(claude-sonnet-5-5\) on product did not qualify on the calibration rows"):
            call(self.repo, "run-judge", "--work", str(self.work), "--judge", "qgs-B", "--set", "qgs", fetch=self.judges)

    def test_a_qgs_judge_validated_on_rich_inputs_or_under_another_packet_is_refused(self):
        judged(self.repo, self.work, self.judges, names=("qgs-A",))
        sessions = json.loads((self.work / "meta.json").read_text())
        key = "judge-config-qgs-A-claude-opus-5-5-run1"
        sessions["sessions"][key]["blocks"][0]["shape"] = "full"
        write_json(self.work / "meta.json", sessions)
        with self.assertRaisesRegex(TopicError, f"{key}: blocks ran on the input shape \\['full'\\], not the thin shape its production runs read"):
            self.validate()
        sessions["sessions"][key]["blocks"][0]["shape"] = "thin"
        rank = str(sessions["sessions"][key]["blocks"][0]["ranks"][0])
        sessions["sessions"][key]["blocks"][0]["row_sha256"][rank] = next(r["inputs_sha256"] for r in self.sample["rows"] if str(r["order_rank"]) == rank)
        write_json(self.work / "meta.json", sessions)
        with self.assertRaisesRegex(TopicError, f"{key}: ranks \\[{rank}\\] were judged on other inputs than the calibration rows hold in the thin shape"):
            self.validate()

    def test_qgs_judging_runs_once_per_topic_only_after_validation_and_under_the_validated_packet(self):
        with self.assertRaisesRegex(SystemExit, "--set qgs judges the topic's candidates and takes no --stratum"):
            call(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "qgs-A", "--set", "qgs", fetch=self.judges)
        judged(self.repo, self.work, self.judges, names=("qgs-A",))
        quiet(self.repo, "fetch-screening-inputs", "--work", str(self.work), "--set", "qgs", fetch=inputs_fetch())
        call(self.repo, "run-judge", "--work", str(self.work), "--judge", "qgs-A", "--set", "qgs", "--rows", "1-5", "--today", TODAY, fetch=self.judges)
        entry = self.meta()["qgs-judge-A"]
        self.assertEqual((len(entry["blocks"][0]["ranks"]), entry["blocks"][0]["shape"], entry["model"]), (5, "thin", OPUS["model"]))
        (self.work / "qgs-packet.md").write_text("qgs packet, edited after the validation\n")
        with self.assertRaisesRegex(SystemExit, "qgs-packet.md is not the packet qgs-A was validated under"):
            call(self.repo, "run-judge", "--work", str(self.work), "--judge", "qgs-A", "--set", "qgs", "--rows", "6-9", fetch=self.judges)

    def test_a_judge_run_too_long_for_one_prompt_is_split_into_blocks_and_validated_whole(self):
        for rows in ("1-30", "31-60"):
            quiet(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "qgs-A", "--set", "calibration", "--run", "1", "--rows", rows, "--today", TODAY,
                  fetch=self.judges)
        with self.assertRaisesRegex(SystemExit, "already holds ranks"):
            call(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "qgs-A", "--set", "calibration", "--run", "1", "--rows", "25-35", fetch=self.judges)
        with self.assertRaisesRegex(SystemExit, "--rows 61-70 holds no row of the 60"):
            call(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "qgs-A", "--set", "calibration", "--run", "2", "--rows", "61-70", fetch=self.judges)
        quiet(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "qgs-A", "--set", "calibration", "--run", "2", "--today", TODAY, fetch=self.judges)
        self.assertEqual([len(b["ranks"]) for b in self.meta()["judge-config-qgs-A-claude-opus-5-5-run1"]["blocks"]], [30, 30])
        entry = self.validate(("config",))["qgs-A"]["strata"]["config"]
        self.assertEqual((entry["qualified"], entry["differ"]), (True, 0))

    def test_validation_needs_every_label_and_the_reader_family_threat_follows_the_roster(self):
        labels = json.loads((self.work / "calibration-labels.json").read_text())
        labels["complete"] = 119
        write_json(self.work / "calibration-labels.json", labels)
        with self.assertRaisesRegex(TopicError, "the user labelled 119 of 120 calibration rows"):
            self.validate()
        topic = load_topic(self.repo, "demo")
        self.assertTrue(reader_shares_family(topic))
        self.assertFalse(reader_shares_family({**topic, "reader": GEMINI}))

    def test_the_cross_family_audit_sample_is_drawn_only_after_stage_2_ends(self):
        judged(self.repo, self.work, self.judges)
        stage1_calibrated(self.repo, self.work, self.judges)
        topic_qgs(self.repo, self.work, self.judges)
        with self.assertRaisesRegex(SystemExit, "no config-stage2.json in .*; the audit sample is drawn after stage 2 ends"):
            call(self.repo, "draw-audit-sample", "--work", str(self.work))
        with self.assertRaisesRegex(SystemExit, "pass --judge audit --set audit"):
            call(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "screening-A", "--set", "audit", fetch=self.judges)


if __name__ == "__main__":
    unittest.main()
