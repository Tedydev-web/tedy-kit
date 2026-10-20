import json
import unittest

from study_judges import reader_shares_family, validate
from study_topic import TopicError, load_topic
from study_v4_fixture import GEMINI, ScriptedJudges, call, eligible, frozen, inputs_fetch, judged, labelled, relevant, v4_repo, v4_work, write_json


class JudgeValidationTest(unittest.TestCase):
    def setUp(self):
        self.repo = v4_repo()
        self.work = v4_work(self.repo)
        self.judges = ScriptedJudges()
        self.sample = labelled(self.repo, self.work)
        frozen(self.repo, self.work, self.judges)

    def freeze(self):
        return json.loads((self.work / "protocol-freeze.json").read_text())

    def positives(self, stratum, test):
        return [r["repo"] for r in self.sample["rows"] if r["stratum"] == stratum and test(r["repo"])]

    def test_every_judge_runs_twice_and_qualifies_only_over_the_sensitivity_and_kappa_floors(self):
        judged(self.repo, self.work, self.judges, names=("screening-A", "qgs-A", "qgs-B", "reader"))
        judged(self.repo, self.work, self.judges, names=("screening-B",), strata=("product",))
        call(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "screening-B", "--set", "calibration", "--run", "1", "--today", "2026-10-20", fetch=self.judges)
        self.judges.flip = set(self.positives("config", eligible)[:2])
        call(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "screening-B", "--set", "calibration", "--run", "2", "--today", "2026-10-20", fetch=self.judges)
        out = validate(load_topic(self.repo, "demo"), self.work, self.freeze())
        self.assertEqual(sorted(out), ["qgs-A", "qgs-B", "reader", "screening-A", "screening-B"])
        self.assertTrue(all(entry["qualified"] for entry in out["screening-A"]["strata"].values()))
        b = out["screening-B"]["strata"]["config"]
        self.assertEqual((b["differ"], b["runs"][1]["fn"], b["runs"][0]["sensitivity"], b["qualified"]), (2, 2, 1.0, True))
        self.assertEqual(out["screening-B"]["model"], "claude-sonnet-5-5")
        self.assertEqual(out["qgs-A"]["strata"]["product"]["positives"], len(self.positives("product", relevant)))

    def test_a_judge_below_a_floor_does_not_qualify_and_its_sessions_and_standard_wait(self):
        judged(self.repo, self.work, self.judges, names=("screening-A", "qgs-A", "reader"))
        judged(self.repo, self.work, self.judges, names=("screening-B",), strata=("product",))
        self.judges.flip = set(self.positives("config", eligible)[:6])
        judged(self.repo, self.work, self.judges, names=("screening-B",), strata=("config",))
        self.judges.flip = set()
        b = validate(load_topic(self.repo, "demo"), self.work, self.freeze())["screening-B"]["strata"]["config"]
        self.assertFalse(b["qualified"])
        self.assertLess(b["runs"][0]["sensitivity"], 0.9)
        with self.assertRaisesRegex(SystemExit, r"screening-B \(claude-sonnet-5-5\) did not qualify as judges on the config calibration set"):
            call(self.repo, "run-screening-session", "--work", str(self.work), "--stratum", "config", "--side", "A", "--ranks", "1-9", "--today", "2026-10-20", fetch=self.judges)
        call(self.repo, "run-screening-session", "--work", str(self.work), "--stratum", "product", "--side", "A", "--ranks", "1-9", "--today", "2026-10-20", fetch=self.judges)
        call(self.repo, "fetch-screening-inputs", "--work", str(self.work), "--stratum", "config", "--set", "qgs", fetch=inputs_fetch())
        with self.assertRaisesRegex(SystemExit, r"qgs-B \(claude-sonnet-5-5\) did not qualify"):
            call(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "qgs-B", "--set", "qgs", fetch=self.judges)
        call(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "qgs-A", "--set", "qgs", "--rows", "1-5", fetch=self.judges)
        self.assertEqual(len((self.work / "config-qgs-judge-A.jsonl").read_text().splitlines()), 5)
        (self.work / "qgs-packet-config.md").write_text("qgs packet config, edited after the validation\n")
        with self.assertRaisesRegex(SystemExit, "qgs-packet-config.md is not the packet qgs-A was validated under"):
            call(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "qgs-A", "--set", "qgs", "--rows", "6-9", fetch=self.judges)

    def test_a_judge_run_too_long_for_one_prompt_is_split_into_blocks_and_validated_whole(self):
        for rows in ("1-30", "31-60"):
            call(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "qgs-A", "--set", "calibration", "--run", "1", "--rows", rows, "--today", "2026-10-20",
                 fetch=self.judges)
        with self.assertRaisesRegex(SystemExit, "already holds ranks"):
            call(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "qgs-A", "--set", "calibration", "--run", "1", "--rows", "25-35", fetch=self.judges)
        with self.assertRaisesRegex(SystemExit, "--rows 61-70 holds no row of the 60"):
            call(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "qgs-A", "--set", "calibration", "--run", "2", "--rows", "61-70", fetch=self.judges)
        call(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "qgs-A", "--set", "calibration", "--run", "2", "--today", "2026-10-20", fetch=self.judges)
        meta = json.loads((self.work / "meta.json").read_text())["sessions"]
        self.assertEqual([len(b["ranks"]) for b in meta["judge-config-qgs-A-claude-opus-5-5-run1"]["blocks"]], [30, 30])
        entry = validate(load_topic(self.repo, "demo"), self.work, self.freeze(), ("config",))["qgs-A"]["strata"]["config"]
        self.assertEqual((entry["qualified"], entry["differ"]), (True, 0))

    def test_a_run_on_other_inputs_or_without_labels_is_refused(self):
        judged(self.repo, self.work, self.judges, names=("qgs-A",), strata=("config",))
        meta = json.loads((self.work / "meta.json").read_text())
        key = "judge-config-qgs-A-claude-opus-5-5-run1"
        rank = str(meta["sessions"][key]["blocks"][0]["ranks"][0])
        meta["sessions"][key]["blocks"][0]["row_sha256"][rank] = "0" * 64
        write_json(self.work / "meta.json", meta)
        with self.assertRaisesRegex(TopicError, f"{key}: ranks \\[{rank}\\] were judged on other inputs than the calibration set holds"):
            validate(load_topic(self.repo, "demo"), self.work, self.freeze())
        labels = json.loads((self.work / "calibration-labels.json").read_text())
        labels["complete"] = 119
        write_json(self.work / "calibration-labels.json", labels)
        with self.assertRaisesRegex(TopicError, "the user labelled 119 of 120 calibration rows"):
            validate(load_topic(self.repo, "demo"), self.work, self.freeze())

    def test_the_reader_shares_the_qgs_judges_family_unless_the_roster_says_otherwise(self):
        topic = load_topic(self.repo, "demo")
        self.assertTrue(reader_shares_family(topic))
        self.assertFalse(reader_shares_family({**topic, "reader": GEMINI}))

    def test_the_audit_sample_is_screened_by_the_cross_family_model_under_the_frozen_protocol(self):
        with self.assertRaisesRegex(SystemExit, "pass --judge audit --set audit"):
            call(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "screening-A", "--set", "audit", fetch=self.judges)
        for stratum in ("config", "product"):
            for side in "AB":
                (self.work / f"{stratum}-screen-{side}.jsonl").write_text("".join(json.dumps({"order_rank": r}) + "\n" for r in range(1, 40)))
        call(self.repo, "draw-audit-sample", "--work", str(self.work))
        sample = json.loads((self.work / "audit-sample.json").read_text())
        self.assertEqual({s: len(r) for s, r in sample.items()}, {"config": 20, "product": 20})
        self.assertTrue(all(r > 2 for r in sample["config"]))
        call(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "audit", "--set", "audit", "--today", "2026-10-20", fetch=self.judges)
        rows = [json.loads(line) for line in (self.work / "config-audit-gemini-3.8-flash-high.jsonl").read_text().splitlines()]
        self.assertEqual([r["order_rank"] for r in rows], sample["config"])
        entry = json.loads((self.work / "meta.json").read_text())["sessions"]["config-audit-gemini-3.8-flash-high"]
        self.assertEqual((entry["cli"], entry["blocks"][0]["packet_sha256"]), ("agy", self.freeze()["strata"]["config"]["packet_sha256"]))


if __name__ == "__main__":
    unittest.main()
