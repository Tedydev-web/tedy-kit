import json
import shutil
import tempfile
import unittest
from pathlib import Path

from study_sweep_record import render
from study_topic import TopicError, load_topic
from study_v4_fixture import SWEEP, v4_sweep


def section(text, heading):
    return text.split(f"## {heading}\n\n", 1)[1].split("\n## ", 1)[0]


class V4RecordTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.built = v4_sweep()
        cls.text = render(cls.built, load_topic(cls.built, "demo"))[0]

    def copy(self):
        repo = Path(tempfile.mkdtemp(prefix="study-v4-copy-"))
        self.addCleanup(shutil.rmtree, repo, ignore_errors=True)
        shutil.copytree(self.built, repo, dirs_exist_ok=True)
        return repo, repo / "docs/prior-art/sweeps" / SWEEP

    def render(self, repo):
        return render(repo, load_topic(repo, "demo"))[0]

    def test_the_fixture_runs_the_config_pool_channel_the_snowball_and_the_qgs_extraction_through_the_toolchain(self):
        folder = self.built / "docs/prior-art/sweeps" / SWEEP
        candidates = [json.loads(line) for line in (folder / "qgs-candidates.jsonl").read_text().splitlines()]
        self.assertEqual((candidates[0]["list"], candidates[0]["heading"]), ("l/awesome-claude", "Kits"))
        self.assertIn("](https://github.com/", candidates[0]["line"])
        snow = [json.loads(line) for line in (folder / "snowball-screening-order.jsonl").read_text().splitlines()]
        self.assertTrue(snow and all(r["channels"] == ["snowball"] for r in snow))
        self.assertEqual(json.loads((folder / "snowball-cut.json").read_text())["cut_row"], None)
        product = [json.loads(line) for line in (folder / "product-screening-order.jsonl").read_text().splitlines()]
        joined = json.loads((folder / "config-pool-channel.json").read_text())["joined"]
        self.assertTrue({r["repo"] for r in product if "config-pool" in r["channels"]} <= set(joined))

    def test_prisma_is_computed_from_the_files_and_no_typed_recall_text_is_printed(self):
        prisma = section(self.text, "PRISMA")
        for row in ("| config | identified: github-code-search | 99 |", "| config | identified: snowball | 34 |", "| config | duplicates across channels | 0 |",
                    "| config | stage-1 screened | 133 |", "| config | stage-1 no from claude-sonnet-5-5 | 35 |", "| config | excluded by automation (union rule) | 35 |",
                    "| product | identified: config-pool | 23 |", "| product | identified: repo | 99 |", "| product | duplicates across channels | 6 |"):
            self.assertIn(row, prisma)
        self.assertRegex(prisma, r"\| config \| stage 2: eligible \| \d+ \|")
        meta = json.loads((self.built / "docs/prior-art/sweeps" / SWEEP / "meta.json").read_text())
        self.assertNotIn("recall", meta)
        self.assertNotIn("prisma", meta)

    def test_recall_is_pooled_over_the_deduplicated_standard_and_per_facet_split_into_in_pool_and_stage_1_pass_rates(self):
        recall = section(self.text, "Recall")
        self.assertRegex(recall, r"- pooled topic recall \d+/47 \(0\.\d{3}, 95% CI 0\.\d\d-\d\.\d\d\) of the 47 deduplicated standard members, screened by both stage-2 "
                                 r"sessions; in-pool rate 46/47 \(0\.979, 95% CI 0\.89-1\.00\); stage-1 pass rate of in-pool members 46/46 ")
        self.assertRegex(recall, r"- facet alpha: recall \d+/\d+ .* of the \d+ members labelled for it; in-pool rate .*; stage-1 pass rate .*; reported, no pass or fail")
        self.assertIn("- QGS recall is an upper estimate: the QGS judges are the stage-1 models", recall)

    def test_the_config_pool_channel_and_the_members_outside_every_pool_are_counted(self):
        self.assertRegex(section(self.text, "Recall"), r"- product channel from the config pool: \d+ repositories joined the product pool before stage 1; they recover \d+ of "
                                                       r"the \d+ standard members the QGS judges labelled product; 1 of those members remain outside every pool")
        self.assertIn("- discovery gap: 1 standard members labelled product are in no pool: o/outside1", section(self.text, "Threats"))

    def test_facets_count_included_rows_per_facet_with_their_overlap_from_the_stage_1_labels(self):
        facets = section(self.text, "Facets")
        self.assertRegex(facets, r"- config: \d+ repositories included once each; counted per facet alpha \d+, beta \d+; overlap alpha\+beta 1; facets come from the stage-1 "
                                 r"problem labels")
        self.assertIn("| facets |", self.text)

    def test_stage_1_states_the_frozen_ladder_the_rung_used_the_rungs_tried_and_the_audit_bounds(self):
        stage1 = section(self.text, "Stage 1")
        self.assertIn("- chosen: rung 1 after 1 rungs tried", stage1)
        self.assertIn("- rung 1: run 1 71/71 positives passed, one-sided 95% lower bound 0.9587", stage1)
        self.assertRegex(stage1, r"- config stage-1 audit: 0 model disagreements .*; near excludes \d+ of \d+ read, 0 confirmed eligible, upper elusion bound 0\.\d+, at most \d+ of the \d+ eligible; far excludes .*; the stage-2 screener flagged 1 and the user checked every flagged row")

    def test_the_standard_lists_drops_and_the_cross_family_join_and_the_audit_follows_stage_2(self):
        judges = section(self.text, "Judges")
        self.assertIn("dropped 1; dropped 63 o/missing7 (the repository is gone (HTTP 404), 2026-10-20)", judges)
        self.assertIn("- cross-family QGS judge gemini-3.8-flash-high: 12 candidates judged, joined by repository name", judges)
        self.assertRegex(judges, r"- config audit: 20 rows drawn after stage 2 ended and screened again by gemini-3\.8-flash-high")
        self.assertIn("- QGS qgs-B: claude-sonnet-5-5 judged 66 candidates on the thin inputs it was validated on", judges)

    def test_the_stage_2_stop_is_pooled_over_every_stratum_and_the_whole_deduplicated_standard(self):
        for stratum in ("config", "product"):
            self.assertRegex(section(self.text, f"Stratum: {stratum}"), r"stop: stage 2 ranked the stage-1 passes of every stratum together by facet and stopped at pooled "
                                                                         r"depth 42 \(limit 150\); this stratum screens \d+ of its \d+ passes; pooled recall at the stop "
                                                                         r"38/47 \(0\.809, 95% CI .*\) of the 47 deduplicated standard members; target reached")
        self.assertIn("- stage 2 stopped before every stage-1 pass: config screened 22 of 98 passes", section(self.text, "Threats"))

    def test_an_unreachable_target_screens_every_pass_and_the_record_states_the_threat(self):
        from study_v4_fixture import quiet
        from study_v4_record import stage2_threats, v4_stop
        repo, folder = self.copy()
        path = folder / "qgs-adjudicated.json"
        standard = json.loads(path.read_text())
        path.write_text(json.dumps({**standard, "final": standard["final"] + [f"x/absent{i}" for i in range(423)]}))
        quiet(repo, "plan-stage2", "--work", str(folder), "--limit", "150")
        topic, faceted = load_topic(repo, "demo"), {}
        for stratum in ("config", "product"):
            plan = json.loads((folder / f"{stratum}-stage2.json").read_text())
            self.assertEqual(plan["order"], plan["passes"])
            text, faceted[stratum] = v4_stop(topic, folder, stratum, plan["order"])
            self.assertIn(f"stop: stage 2 screened every one of the {len(plan['passes'])} stage-1 passes", text)
            self.assertIn("only 46 of the 470 deduplicated standard members passed stage 1 in any stratum, and the 0.80 pooled recall target needs 376", text)
        self.assertEqual(stage2_threats(["config", "product"], faceted), ["- pooled recall target unreachable at stage 2: 46 of the 470 deduplicated standard members "
                                                                          "passed stage 1 and 376 are needed; stage 2 screened every pass"])

    def test_the_record_refuses_a_hand_edited_plan_an_unvalidated_qgs_run_or_a_snowball_row_outside_the_pool(self):
        repo, folder = self.copy()
        plan = json.loads((folder / "config-stage2.json").read_text())
        (folder / "config-stage2.json").write_text(json.dumps({**plan, "order": plan["order"][:-1]}))
        with self.assertRaisesRegex(TopicError, "config-stage2.json is not the plan the stage-1 files give"):
            self.render(repo)
        repo, folder = self.copy()
        meta = json.loads((folder / "meta.json").read_text())
        meta["sessions"]["qgs-judge-A"]["blocks"][0]["shape"] = "full"
        (folder / "meta.json").write_text(json.dumps(meta))
        with self.assertRaisesRegex(TopicError, "qgs-judge-A.jsonl: its 66 judgments are not all claude-opus-5-5 runs on the thin QGS inputs"):
            self.render(repo)
        repo, folder = self.copy()
        (folder / "snowball-screening-order.jsonl").write_text(json.dumps({"order_rank": 1001, "repo": "s/elsewhere"}) + "\n")
        (folder / "snowball-cut.json").write_text(json.dumps({"stratum": "config", "cut_row": None, "source": "none"}))
        with self.assertRaisesRegex(TopicError, r"snowballed repositories \['s/elsewhere'\] are not in the config stage-1 pool"):
            self.render(repo)

    def test_a_snowball_with_a_cut_is_refused_under_v4(self):
        repo, folder = self.copy()
        cut = json.loads((folder / "snowball-cut.json").read_text())
        (folder / "snowball-cut.json").write_text(json.dumps({**cut, "cut_row": 200, "source": "the effort bound 200"}))
        with self.assertRaisesRegex(TopicError, "snowball-cut.json cuts the snowball at row 200; quality criteria v4 refuses a snowball cut"):
            self.render(repo)


class QgsWorkflowTest(unittest.TestCase):
    def test_an_empty_reader_queue_needs_no_reader_session(self):
        from study_fixtures import topic_repo, write_json, write_jsonl
        from study_v4_record import qgs_workflow
        repo = topic_repo()
        path = repo / "docs/prior-art/topics/demo.json"
        opus, sonnet = {"cli": "claude", "model": "claude-opus-5-5"}, {"cli": "claude", "model": "claude-sonnet-5-5"}
        write_json(path, {**json.loads(path.read_text()), "qgs_judges": {"A": opus, "B": sonnet}, "reader": opus})
        folder = Path(tempfile.mkdtemp(prefix="study-reader-"))
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        write_jsonl(folder / "qgs-candidates.jsonl", [{"id": 1, "repo": "o/a"}])
        block = {"ranks": [1], "shape": "thin", "packet_sha256": "p" * 64}
        for name in ("qgs-judge-A", "qgs-judge-B"):
            write_jsonl(folder / f"{name}.jsonl", [{"id": 1, "repo": "o/a", "verdict": "yes", "problems": ["X1"], "why": "w"}])
        sessions = {"qgs-judge-A": {"model": opus["model"], "blocks": [block]}, "qgs-judge-B": {"model": sonnet["model"], "blocks": [block]}}
        found = {j: {"strata": {"config": {"runs": [{"packets": ["p" * 64]}]}}} for j in ("qgs-A", "qgs-B", "reader")}
        lines = qgs_workflow(load_topic(repo, "demo"), folder, sessions, found)
        self.assertEqual(lines[-1], "- QGS reader: no candidate was queued for the reader")


class V4EscalatedRungRecordTest(unittest.TestCase):
    def test_a_rung_above_the_first_is_confirmed_on_the_held_out_batch_and_its_own_bound_is_reported_apart(self):
        built = v4_sweep(escalate=True)
        text = render(built, load_topic(built, "demo"))[0]
        stage1 = section(text, "Stage 1")
        self.assertRegex(stage1, r"- rung 1: run 1 \d+/\d+ positives passed, .*; the runs differ on 1 of 120 rows; fails the rule")
        self.assertIn("- chosen: rung 2 after 2 rungs tried", stage1)
        self.assertRegex(stage1, r"- held-out confirmation: rung 2 passed (\d+)/\1 held-out positives, missed none; the batch's own one-sided lower bound 0\.\d{4}; "
                                 r"the pooled bound above was measured on the set the rung was chosen on")
        self.assertRegex(section(text, "Calibration"), r"- held-out config: \d+ rows \(stage-1 rung 2 was chosen above the first: the rows are held out to confirm it\)")


if __name__ == "__main__":
    unittest.main()
