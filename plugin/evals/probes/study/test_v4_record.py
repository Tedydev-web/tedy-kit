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

    def test_prisma_is_computed_from_the_files_and_no_typed_recall_text_is_printed(self):
        prisma = section(self.text, "PRISMA")
        for row in ("| config | identified: code | 99 |", "| config | identified: repo | 25 |", "| config | duplicates across channels | 25 |", "| config | stage-1 screened | 99 |",
                    "| config | stage-1 no from claude-sonnet-5-5 | 27 |", "| config | excluded by automation (union rule) | 27 |", "| config | stage-2 assessed | 72 |",
                    "| product | identified: config-pool | 21 |", "| product | stage-1 passes not assessed (stage-2 stop) | 52 |"):
            self.assertIn(row, prisma)
        self.assertRegex(prisma, r"\| config \| stage 2: eligible \| \d+ \|")
        meta = json.loads((self.built / "docs/prior-art/sweeps" / SWEEP / "meta.json").read_text())
        self.assertNotIn("recall", meta)
        self.assertNotIn("prisma", meta)

    def test_recall_is_pooled_over_the_deduplicated_standard_and_per_facet_split_into_in_pool_and_stage_1_pass_rates(self):
        recall = section(self.text, "Recall")
        self.assertRegex(recall, r"- pooled topic recall 40/45 \(0\.889, 95% CI 0\.76-0\.96\) of the 45 deduplicated standard members, screened by both stage-2 sessions; "
                                 r"in-pool rate 44/45 \(0\.978, 95% CI 0\.88-1\.00\); stage-1 pass rate of in-pool members 44/44 .*; meets the 0\.80 target")
        self.assertRegex(recall, r"- facet alpha: recall \d+/24 .* of the 24 members labelled for it; in-pool rate .*; stage-1 pass rate .*; reported, no pass or fail")
        self.assertIn("- QGS recall is an upper estimate: the QGS judges are the stage-1 models", recall)

    def test_the_config_pool_channel_and_the_members_outside_every_pool_are_counted(self):
        self.assertIn("- product channel from the config pool: 2 repositories joined the product pool before stage 1; they recover 2 of the 23 standard members that pass "
                      "the product filter; 1 of those members remain outside every pool", section(self.text, "Recall"))
        self.assertIn("- discovery gap: 1 standard members that pass the product filter are in no pool: o/outside1", section(self.text, "Threats"))

    def test_facets_count_included_rows_per_facet_with_their_overlap_from_the_stage_1_labels(self):
        facets = section(self.text, "Facets")
        self.assertRegex(facets, r"- config: \d+ repositories included once each; counted per facet alpha \d+, beta \d+; overlap alpha\+beta 1; facets come from the stage-1 "
                                 r"problem labels")
        self.assertIn("| facets |", self.text)

    def test_stage_1_states_the_frozen_ladder_the_rung_used_the_rungs_tried_and_the_audit_bounds(self):
        stage1 = section(self.text, "Stage 1")
        self.assertIn("- chosen: rung 1 after 1 rungs tried", stage1)
        self.assertIn("- rung 1: run 1 71/71 positives passed, one-sided 95% lower bound 0.9587", stage1)
        self.assertRegex(stage1, r"- config stage-1 audit: 0 model disagreements .*; near excludes \d+ of \d+ read, 0 confirmed eligible, upper elusion bound 0\.\d+; far excludes")
        self.assertIn("stop: stage 2 ranked the 72 stage-1 passes by facet and stopped at depth 20 (limit 60)", self.text)
        self.assertIn("- stage 2 stopped before every stage-1 pass: product screened 20 of 72 passes", section(self.text, "Threats"))

    def test_the_standard_lists_drops_and_the_cross_family_join_and_the_audit_follows_stage_2(self):
        judges = section(self.text, "Judges")
        self.assertIn("dropped 1; dropped 63 o/missing7 (the repository is gone (HTTP 404), 2026-10-20)", judges)
        self.assertIn("- cross-family QGS judge gemini-3.8-flash-high: 12 candidates judged, joined by repository name", judges)
        self.assertRegex(judges, r"- config audit: 20 rows drawn after stage 2 ended and screened again by gemini-3\.8-flash-high")
        self.assertIn("- QGS qgs-B: claude-sonnet-5-5 judged 63 candidates on the thin inputs it was validated on", judges)

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
        with self.assertRaisesRegex(TopicError, "qgs-judge-A.jsonl: its 63 judgments are not all claude-opus-5-5 runs on the thin QGS inputs"):
            self.render(repo)
        repo, folder = self.copy()
        (folder / "snowball-screening-order.jsonl").write_text(json.dumps({"order_rank": 1001, "repo": "s/elsewhere"}) + "\n")
        (folder / "snowball-cut.json").write_text(json.dumps({"stratum": "config", "cut_row": None, "source": "none"}))
        with self.assertRaisesRegex(TopicError, r"snowballed repositories \['s/elsewhere'\] are not in the config stage-1 pool"):
            self.render(repo)


if __name__ == "__main__":
    unittest.main()
