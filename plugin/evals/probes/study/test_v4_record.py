import hashlib
import json
import re
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

    def test_the_config_pool_joined_count_is_the_prisma_config_pool_line_without_the_aggregators_the_product_ranking_removed(self):
        joined = int(re.search(r"- product channel from the config pool: (\d+) repositories joined", self.text).group(1))
        self.assertEqual((joined, int(re.search(r"^\| product \| identified: config-pool \| (\d+) \|$", self.text, re.M).group(1))), (23, 23))
        repo, folder = self.copy()
        channel = json.loads((folder / "config-pool-channel.json").read_text())
        credited = next(json.loads(line)["repo"] for line in (folder / "product-screening-order.jsonl").read_text().splitlines() if "config-pool" in json.loads(line)["channels"])
        (folder / "config-pool-channel.json").write_text(json.dumps({**channel, "joined": [r for r in channel["joined"] if r != credited]}))
        with self.assertRaisesRegex(TopicError, "product-screening-order.jsonl credits the config-pool channel with .*, which config-pool-channel.json does not list"):
            self.render(repo)

    def test_facets_count_included_rows_per_facet_from_the_problem_ids_the_stage_2_sessions_name(self):
        facets = section(self.text, "Facets")
        self.assertRegex(facets, r"- config: \d+ repositories included once each; counted per facet alpha \d+, beta \d+; overlap alpha\+beta 1; facets come from the problem ids "
                                 r"the stage-2 sessions name, at least one per included row\n")
        self.assertIn("| facets |", self.text)
        repo, folder = self.copy()
        rows = [json.loads(line) for line in (folder / "config-screen-B.jsonl").read_text().splitlines()]
        eligible = next(r for r in rows if r["decision"] == "eligible")
        for side in "AB":
            path = folder / f"config-screen-{side}.jsonl"
            changed = [{**r, "problems": []} if r["order_rank"] == eligible["order_rank"] else r for r in map(json.loads, path.read_text().splitlines())]
            path.write_text("".join(json.dumps(r) + "\n" for r in changed))
        with self.assertRaisesRegex(TopicError, rf"config: included rank {eligible['order_rank']} names no registry problem at stage 2; eligibility means addressing a registry "
                                                rf"problem"):
            self.render(repo)

    def test_stage_1_states_the_frozen_ladder_the_rung_used_the_rungs_tried_and_the_audit_bounds(self):
        stage1 = section(self.text, "Stage 1")
        self.assertIn("- chosen: rung 1 after 1 rungs tried", stage1)
        self.assertRegex(stage1, r"- rung 1 config: run 1 sensitivity \d+/\d+ \(95% CI 0\.\d\d-1\.00\), pass rate 0\.\d{3}; run 2 sensitivity \d+/\d+ \(95% CI .*\), "
                                 r"pass rate 0\.\d{3}\n")
        self.assertIn("- rung 1: run 1 66/66 positives passed, one-sided 95% lower bound 0.9556", stage1)
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
        with self.assertRaisesRegex(TopicError, "qgs-judge-A.jsonl: its 66 judgments are not all claude claude-opus-5-5 runs on the thin QGS inputs"):
            self.render(repo)
        repo, folder = self.copy()
        (folder / "snowball-screening-order.jsonl").write_text(json.dumps({"order_rank": 1001, "repo": "s/elsewhere"}) + "\n")
        (folder / "snowball-cut.json").write_text(json.dumps({"stratum": "config", "cut_row": None, "source": "none"}))
        with self.assertRaisesRegex(TopicError, r"snowballed repositories \['s/elsewhere'\] are not in the config stage-1 pool"):
            self.render(repo)

    def test_the_record_recomputes_the_rungs_tried_and_refuses_a_choice_made_on_other_labels(self):
        from study_v4_record import sensitivity_text
        repo, folder = self.copy()
        chosen = json.loads((folder / "stage1-rung.json").read_text())
        chosen["tried"][0]["runs"][0]["passed"] = 999
        (folder / "stage1-rung.json").write_text(json.dumps(chosen))
        with self.assertRaisesRegex(TopicError, "stage1-rung.json is not the rung choice the calibration files give"):
            self.render(repo)
        repo, folder = self.copy()
        chosen = json.loads((folder / "stage1-rung.json").read_text())
        (folder / "stage1-rung.json").write_text(json.dumps({**chosen, "labels_sha256": {"calibration": "0" * 64}}))
        with self.assertRaisesRegex(TopicError, "stage1-rung.json was chosen on other labels or another freeze than calibration-labels.json holds now"):
            self.render(repo)
        self.assertEqual(sensitivity_text({"positives": 0, "passed": 0, "interval": None}), "no positive")

    def test_the_record_redraws_the_cross_family_audit_sample(self):
        repo, folder = self.copy()
        sample = json.loads((folder / "audit-sample.json").read_text())
        pilot = min({json.loads(line)["order_rank"] for line in (folder / "config-screen-A.jsonl").read_text().splitlines()})
        self.assertNotIn(pilot, sample["config"])
        (folder / "audit-sample.json").write_text(json.dumps({**sample, "config": sorted(sample["config"][1:] + [pilot])}))
        with self.assertRaisesRegex(TopicError, "audit-sample.json is not the sample the stage-2 files give; the cross-family audit is drawn once, by draw-audit-sample.py"):
            self.render(repo)

    def test_the_record_redraws_each_calibration_batch_and_binds_the_labels_to_its_rows(self):
        repo, folder = self.copy()
        labels = json.loads((folder / "calibration-labels.json").read_text())
        (folder / "calibration-labels.json").write_text(json.dumps({**labels, "rows": labels["rows"][1:], "complete": labels["complete"] - 1}))
        with self.assertRaisesRegex(TopicError, "calibration-labels.json does not hold exactly the rows of calibration-set.json"):
            self.render(repo)
        repo, folder = self.copy()
        sample = json.loads((folder / "calibration-set.json").read_text())
        drawn = {r["order_rank"] for r in sample["rows"] if r["stratum"] == "config"}
        other = next(json.loads(line) for line in (folder / "config-screening-order.jsonl").read_text().splitlines() if json.loads(line)["order_rank"] not in drawn)
        first = next(i for i, r in enumerate(sample["rows"]) if r["stratum"] == "config")
        sample["rows"][first] = {**sample["rows"][first], "order_rank": other["order_rank"], "repo": other["repo"]}
        text = json.dumps(sample, indent=1, ensure_ascii=False) + "\n"
        (folder / "calibration-set.json").write_text(text)
        sha = hashlib.sha256(text.encode()).hexdigest()
        labels = json.loads((folder / "calibration-labels.json").read_text())
        labels["rows"][first] = {**labels["rows"][first], "order_rank": other["order_rank"], "repo": other["repo"]}
        (folder / "calibration-labels.json").write_text(json.dumps({**labels, "set_sha256": sha}))
        draw = json.loads((folder / "calibration-draw.json").read_text())
        (folder / "calibration-draw.json").write_text(json.dumps({**draw, "set_sha256": sha}))
        with self.assertRaisesRegex(TopicError, "calibration-set.json is not the set its seed, the pools and the recorded unreadable rows give"):
            self.render(repo)
        repo, folder = self.copy()
        draw = json.loads((folder / "calibration-draw.json").read_text())
        (folder / "calibration-draw.json").write_text(json.dumps({**draw, "set_sha256": "0" * 64}))
        with self.assertRaisesRegex(TopicError, "calibration-draw.json was written for another calibration set"):
            self.render(repo)
        repo, folder = self.copy()
        sample = json.loads((folder / "calibration-set.json").read_text())
        text = json.dumps({**sample, "rows_per_stratum": {"config": 59, "product": 60}}, indent=1, ensure_ascii=False) + "\n"
        (folder / "calibration-set.json").write_text(text)
        sha = hashlib.sha256(text.encode()).hexdigest()
        for name in ("calibration-labels.json", "calibration-draw.json"):
            (folder / name).write_text(json.dumps({**json.loads((folder / name).read_text()), "set_sha256": sha}))
        with self.assertRaisesRegex(TopicError, r"calibration-set.json holds \{'config': 59, 'product': 60\} rows per stratum; the calibration set holds 60 per stratum"):
            self.render(repo)

    def test_the_stage_1_audit_reading_counts_only_from_the_screener_on_the_frozen_packet_and_the_rows_it_was_given(self):
        key = "config-stage1-audit-claude-opus-5-5"
        message = f"{key}: the stage-1 audit reading is not the stage-2 screener claude-opus-5-5 on the full inputs under the frozen packet and criteria"
        for edit in (lambda e: e.update(model="gemini-3.8-flash-high", cli="agy"), lambda e: e["blocks"][0].update(shape="thin"),
                     lambda e: e["blocks"][0].update(packet_sha256="0" * 64), lambda e: e["blocks"][0].update(criteria_sha256="0" * 64)):
            repo, folder = self.copy()
            meta = json.loads((folder / "meta.json").read_text())
            edit(meta["sessions"][key])
            (folder / "meta.json").write_text(json.dumps(meta))
            with self.assertRaisesRegex(TopicError, message):
                self.render(repo)
        repo, folder = self.copy()
        meta = json.loads((folder / "meta.json").read_text())
        calibration = {str(r["order_rank"]) for r in json.loads((folder / "calibration-set.json").read_text())["rows"] if r["stratum"] == "config"}
        block = meta["sessions"][key]["blocks"][0]
        shared = sorted(set(block["row_sha256"]) & calibration)[0]
        block["row_sha256"][shared] = "a" * 64
        (folder / "meta.json").write_text(json.dumps(meta))
        with self.assertRaisesRegex(TopicError, rf"{key}: ranks \[{shared}\] were read on other inputs than the calibration rows of the same ranks hold"):
            self.render(repo)

    def test_every_judge_validation_run_must_be_the_roster_model_for_its_role(self):
        for key, change in (("judge-config-screening-A-claude-opus-5-5-run1", {"model": "claude-haiku-4-5"}),
                            ("judge-config-screening-B-claude-sonnet-5-5-run2", {"model": "claude-haiku-4-5"}),
                            ("judge-product-qgs-A-claude-opus-5-5-run1", {"cli": "agy"}),
                            ("judge-config-reader-claude-opus-5-5-run2", {"model": None})):
            with self.subTest(key=key):
                repo, folder = self.copy()
                meta = json.loads((folder / "meta.json").read_text())
                entry = {**meta["sessions"][key], **change}
                meta["sessions"][key] = {k: v for k, v in entry.items() if v is not None}
                (folder / "meta.json").write_text(json.dumps(meta))
                with self.assertRaisesRegex(TopicError, rf"^{key}: the run was \S+ \S+, not the roster's \S+ \S+ it validates; a validation run counts only for its own judge$"):
                    self.render(repo)

    def test_every_recorded_session_has_its_output_file_and_a_completed_cross_family_audit_never_reads_as_pending(self):
        def topic(repo, edit):
            path = repo / "docs/prior-art/topics/demo.json"
            path.write_text(json.dumps(edit(json.loads(path.read_text()))))
        foreign = r"^the sweep folder holds cross-family runs of gemini-3.8-flash-high, but the topic's cross_family is (none|gemini-9-pro); "
        for name, edit, message in (
                ("audit rows deleted", lambda repo, folder: (folder / "product-audit-gemini-3.8-flash-high.jsonl").unlink(),
                 r"^meta.json records sessions product-audit-gemini-3.8-flash-high whose output files are missing or empty in the sweep folder; "),
                ("audit sample deleted", lambda repo, folder: (folder / "audit-sample.json").unlink(),
                 r"^meta.json records the cross-family audit sessions config-audit-gemini-3.8-flash-high, product-audit-gemini-3.8-flash-high, but the sweep folder has no "
                 r"audit-sample.json they screened$"),
                ("cross_family removed", lambda repo, folder: topic(repo, lambda t: {k: v for k, v in t.items() if k != "cross_family"}), foreign),
                ("cross_family renamed", lambda repo, folder: topic(repo, lambda t: {**t, "cross_family": {**t["cross_family"], "model": "gemini-9-pro"}}), foreign),
                ("a run file without its session", lambda repo, folder: (folder / "judge-config-qgs-A-claude-haiku-4-5-run1.jsonl").write_text(""),
                 r"^judge-config-qgs-A-claude-haiku-4-5-run1.jsonl has no session in meta.json: its rows count only when a recorded run produced them$")):
            with self.subTest(name=name):
                repo, folder = self.copy()
                edit(repo, folder)
                with self.assertRaisesRegex(TopicError, message):
                    self.render(repo)

    def test_a_recorded_session_file_holds_exactly_the_rows_its_blocks_cover_and_an_empty_file_counts_as_missing(self):
        for key, body in (("product-audit-gemini-3.8-flash-high", ""), ("product-audit-gemini-3.8-flash-high", "\n"), ("config-audit-gemini-3.8-flash-high", ""),
                          ("qgs-judge-B", ""), ("judge-config-qgs-A-claude-opus-5-5-run1", "\n")):
            with self.subTest(key=key, body=body):
                repo, folder = self.copy()
                (folder / f"{key}.jsonl").write_text(body)
                with self.assertRaisesRegex(TopicError, rf"^meta.json records sessions {re.escape(key)} whose output files are missing or empty in the sweep folder; "):
                    self.render(repo)
        repo, folder = self.copy()
        path = folder / "qgs-reader.jsonl"
        path.write_text("".join(path.read_text().splitlines(keepends=True)[1:]))
        with self.assertRaisesRegex(TopicError, r"^qgs-reader.jsonl does not hold exactly the rows its recorded blocks cover \(rows outside its blocks: none; rows its blocks cover "
                                                r"that it lacks: \d+\); "):
            self.render(repo)

    def retire(self, repo, folder, key, reason="Gemini unreachable until the quota resets"):
        from study_fixtures import script
        common = ["--topic", "demo", "--repo", str(repo), "--work", str(folder), "--key", key, "--today", "2026-10-20"]
        for block in json.loads((folder / "meta.json").read_text())["sessions"][key]["blocks"]:
            script("drop-run").main([*common, "--ranks", f"{block['ranks'][0]}-{block['ranks'][-1]}", "--reason", "agy quota ran out mid-run"])
        if reason:
            script("retire-run").main([*common, "--reason", reason])

    def test_a_retired_session_with_no_blocks_names_no_cli_version_whether_one_or_every_agy_session_is_retired(self):
        pending = v4_sweep(audit=False)
        cases = ((pending, ["qgs-cross-gemini-3.8-flash-high"]),
                 (self.built, ["config-audit-gemini-3.8-flash-high", "product-audit-gemini-3.8-flash-high", "qgs-cross-gemini-3.8-flash-high"]))
        for source, keys in cases:
            with self.subTest(keys=keys):
                repo = Path(tempfile.mkdtemp(prefix="study-v4-retire-"))
                self.addCleanup(shutil.rmtree, repo, ignore_errors=True)
                shutil.copytree(source, repo, dirs_exist_ok=True)
                folder = repo / "docs/prior-art/sweeps" / SWEEP
                agy = [k for k, e in json.loads((folder / "meta.json").read_text())["sessions"].items() if e["cli"] == "agy"]
                self.assertEqual(sorted(agy), keys)
                for key in keys:
                    self.retire(repo, folder, key)
                self.assertIn("\n- CLI versions: claude 9.9.9 (fixture)\n", self.render(repo))

    def test_a_retired_cross_family_audit_reads_as_pending_with_its_reason_and_a_roster_session_cannot_be_retired(self):
        repo, folder = self.copy()
        self.retire(repo, folder, "product-audit-gemini-3.8-flash-high")
        text = self.render(repo)
        self.assertIn("- cross-family audit pending: product: 0 of 19 audit rows screened by gemini-3.8-flash-high; ", text)
        self.assertIn("- retired: product-audit-gemini-3.8-flash-high: Gemini unreachable until the quota resets (2026-10-20); its blocks were dropped and it was not "
                      "run again", text)
        self.assertNotIn("- product audit: ", text)
        repo, folder = self.copy()
        self.retire(repo, folder, "qgs-cross-gemini-3.8-flash-high")
        text = self.render(repo)
        self.assertIn("- cross-family QGS judge gemini-3.8-flash-high: no judgment kept", text)
        self.assertIn("- retired: qgs-cross-gemini-3.8-flash-high: Gemini unreachable until the quota resets (2026-10-20); ", text)
        repo, folder = self.copy()
        self.retire(repo, folder, "product-audit-gemini-3.8-flash-high", reason=None)
        with self.assertRaisesRegex(TopicError, "^meta.json records sessions product-audit-gemini-3.8-flash-high whose output files are missing or empty"):
            self.render(repo)
        repo, folder = self.copy()
        self.retire(repo, folder, "qgs-reader", reason=None)
        meta = json.loads((folder / "meta.json").read_text())
        (folder / "meta.json").write_text(json.dumps({**meta, "retired": [{"key": "qgs-reader", "reason": "no time", "date": "2026-10-20"}]}))
        with self.assertRaisesRegex(TopicError, "^qgs-reader is a roster session and is recorded as retired; production judges are run again after a drop, never retired$"):
            self.render(repo)

    def test_the_pilot_sessions_run_the_roster_session_a_and_session_b_options(self):
        for key, change in (("config-pilot-B-claude-sonnet-5-5", {"cli": "claudex"}), ("config-pilot-A", {"model": "claude-haiku-4-5"}), ("product-pilot-A", {"cli": "agy"})):
            with self.subTest(key=key):
                repo, folder = self.copy()
                meta = json.loads((folder / "meta.json").read_text())
                meta["sessions"][key].update(change)
                (folder / "meta.json").write_text(json.dumps(meta))
                with self.assertRaisesRegex(TopicError, rf"^{key}: the pilot session ran \S+ \S+, not the topic's (session A|session B option) \S+ \S+; a pilot counts only "
                                                        r"for the roster session it pilots$"):
                    self.render(repo)

    def test_the_snowball_rows_equal_the_pool_snowballed_rows_and_the_stage_1_inputs_once_each(self):
        def rows(folder):
            return (folder / "snowball-screening-order.jsonl").read_text().splitlines(keepends=True)
        for name, edit, held in (("a row deleted", lambda folder: (folder / "snowball-screening-order.jsonl").write_text("".join(rows(folder)[:4] + rows(folder)[5:])), "33 rows (33"),
                                 ("a row duplicated", lambda folder: (folder / "snowball-screening-order.jsonl").write_text("".join(rows(folder) + rows(folder)[:1])), "35 rows (34"),
                                 ("the file deleted", lambda folder: (folder / "snowball-screening-order.jsonl").unlink(), "0 rows (0")):
            with self.subTest(name=name):
                repo, folder = self.copy()
                edit(folder)
                with self.assertRaisesRegex(TopicError, rf"^snowball-screening-order.jsonl holds {re.escape(held)} distinct\), but the config pool holds 34 and the stage-1 inputs 34 "
                                                        r"snowballed rows; "):
                    self.render(repo)

    def test_a_ranked_pool_past_rank_1000_keeps_its_snowball_rows_numbered_after_it(self):
        large = v4_sweep(pad=1000)
        folder = large / "docs/prior-art/sweeps" / SWEEP
        order = [json.loads(line) for line in (folder / "config-screening-order.jsonl").read_text().splitlines()]
        ranked = [r["order_rank"] for r in order if r["channels"] != ["snowball"]]
        snowballed = [r["order_rank"] for r in order if r["channels"] == ["snowball"]]
        self.assertEqual((len(ranked) > 1000, len(snowballed), min(snowballed) > max(ranked)), (True, 34, True))
        audit = json.loads((folder / "config-stage1-audit.json").read_text())
        blocks = [b["ranks"] for b in json.loads((folder / "meta.json").read_text())["sessions"]["config-stage1-audit-claude-opus-5-5"]["blocks"]]
        self.assertEqual((sorted(r for b in blocks for r in b), len(blocks) > 1, max(map(len, blocks)) <= 100, len({len(b) for b in blocks}) > 1),
                         (sorted(audit["near"] + audit["far"]), True, True, True))
        self.assertIn("- snowball: 34 repositories from the aggregators joined the config pool (cut: none: two-stage screening reads the whole pool, so every snowballed "
                      "repository joins it); stage 1 read every one\n", self.render(large))

    def test_a_topic_flag_never_drops_the_config_pool_line_while_its_evidence_exists(self):
        def channels(edit):
            def change(repo, folder):
                path = repo / "docs/prior-art/topics/demo.json"
                topic = json.loads(path.read_text())
                topic["strata"]["product"]["channels"] = edit(topic["strata"]["product"]["channels"])
                path.write_text(json.dumps(topic))
            return change
        flag = (r"^the sweep folder holds the config-pool channel's evidence \(config-pool-channel.json or product rows credited with config-pool\), but the topic config "
                r"does not set strata.product.channels.config_pool; ")
        for name, edit, message in (("config_pool false", channels(lambda c: {**c, "config_pool": False}), flag),
                                    ("config_pool deleted", channels(lambda c: {k: v for k, v in c.items() if k != "config_pool"}), flag),
                                    ("channels emptied", channels(lambda c: {}), flag)):
            with self.subTest(name=name):
                repo, folder = self.copy()
                edit(repo, folder)
                with self.assertRaisesRegex(TopicError, message):
                    self.render(repo)

    def test_meta_drops_matches_the_copies_under_dropped_in_both_directions(self):
        repo, folder = self.copy()
        meta = json.loads((folder / "meta.json").read_text())
        (folder / "meta.json").write_text(json.dumps({**meta, "drops": []}))
        with self.assertRaisesRegex(TopicError, r"^dropped/qgs-judge-B-1-5-1: a dropped copy without its meta.json drops entry; "):
            self.render(repo)
        repo, folder = self.copy()
        (folder / "dropped/qgs-judge-A-1-5-1.rows.jsonl").write_text("")
        with self.assertRaisesRegex(TopicError, r"^dropped/qgs-judge-A-1-5-1: a dropped copy without its meta.json drops entry; "):
            self.render(repo)
        repo, folder = self.copy()
        (folder / "dropped/qgs-judge-B-1-5-1.block.json").unlink()
        with self.assertRaisesRegex(TopicError, r"^the drop of qgs-judge-B ranks \[1, 5\] has no copy of its block in the sweep folder"):
            self.render(repo)
        repo, folder = self.copy()
        meta = json.loads((folder / "meta.json").read_text())
        (folder / "meta.json").write_text(json.dumps({**meta, "drops": [{**meta["drops"][0], "reason": " "}]}))
        with self.assertRaisesRegex(TopicError, r"^the drop of qgs-judge-B ranks \[1, 5\] records no reason"):
            self.render(repo)

    def test_the_cross_family_qgs_judgments_carry_the_provenance_of_a_recorded_run(self):
        key = "qgs-cross-gemini-3.8-flash-high"
        entry = json.loads((self.built / "docs/prior-art/sweeps" / SWEEP / "meta.json").read_text())["sessions"][key]
        self.assertEqual((entry["cli"], entry["model"], entry["blocks"][0]["shape"]), ("agy", "gemini-3.8-flash-high", "thin"))
        outside = rf"^{key}.jsonl: its judgments are not all agy gemini-3.8-flash-high runs on the thin inputs under qgs-packet.md, covering exactly its rows$"

        def block(edit):
            def apply(folder):
                meta = json.loads((folder / "meta.json").read_text())
                edit(meta["sessions"][key]["blocks"][0])
                (folder / "meta.json").write_text(json.dumps(meta))
            return apply

        def drop_row(folder):
            path = folder / f"{key}.jsonl"
            path.write_text("".join(path.read_text().splitlines(keepends=True)[1:]))
        for name, edit, message in (("a row deleted", drop_row, rf"^{key}.jsonl does not hold exactly the rows its recorded blocks cover "),
                                    ("packet changed", block(lambda b: b.update(packet_sha256="0" * 64)), outside),
                                    ("shape changed", block(lambda b: b.update(shape="full")), outside)):
            with self.subTest(name=name):
                repo, folder = self.copy()
                edit(folder)
                with self.assertRaisesRegex(TopicError, message):
                    self.render(repo)

    def test_the_production_qgs_sessions_record_the_same_thin_input_hash_for_every_candidate_they_share(self):
        def change(key, edit):
            def apply(folder):
                meta = json.loads((folder / "meta.json").read_text())
                edit(next(b for b in meta["sessions"][key]["blocks"] if 1 in b["ranks"])["row_sha256"])
                (folder / "meta.json").write_text(json.dumps(meta))
            return apply
        for name, edit in (("qgs-judge-A hash changed", change("qgs-judge-A", lambda h: h.update({"1": "0" * 64}))),
                           ("qgs-judge-B hash deleted", change("qgs-judge-B", lambda h: h.pop("1"))),
                           ("qgs-reader hash changed", change("qgs-reader", lambda h: h.update({"1": "f" * 64})))):
            with self.subTest(name=name):
                repo, folder = self.copy()
                edit(folder)
                with self.assertRaisesRegex(TopicError, r"^the QGS sessions judged candidates 1 on different thin inputs, or recorded no input hash for them; "):
                    self.render(repo)

    def test_the_agy_threat_lists_every_session_that_ran_through_agy_whatever_its_threats_field_holds(self):
        repo, folder = self.copy()
        meta = json.loads((folder / "meta.json").read_text())
        meta["sessions"]["config-audit-gemini-3.8-flash-high"]["threats"] = []
        (folder / "meta.json").write_text(json.dumps(meta))
        self.assertIn("- agy MCP servers, hooks and user settings not excluded: config-audit-gemini-3.8-flash-high, product-audit-gemini-3.8-flash-high, qgs-cross-gemini-3.8-flash-high ran through agy",
                      self.render(repo))

    def test_every_session_names_the_roster_cli_as_well_as_the_model(self):
        for key, message in (("qgs-judge-A", r"qgs-judge-A.jsonl: its \d+ judgments are not all claude claude-opus-5-5 runs"),
                             ("judge-config-stage1-brief-claude-sonnet-5-5-run2", r"judge-config-stage1-brief-claude-sonnet-5-5-run2.jsonl has no claude claude-sonnet-5-5 session"),
                             ("stage1-config-brief-claude-sonnet-5-5", r"stage1-config-brief-claude-sonnet-5-5(.jsonl has no claude claude-sonnet-5-5 session|: the stage-1 pool run is not claude)"),
                             ("config-A", r"config-A ran claudex claude-opus-5-5, the freeze names claude claude-opus-5-5")):
            with self.subTest(key=key):
                repo, folder = self.copy()
                meta = json.loads((folder / "meta.json").read_text())
                meta["sessions"][key]["cli"] = "claudex"
                (folder / "meta.json").write_text(json.dumps(meta))
                with self.assertRaisesRegex(TopicError, message):
                    self.render(repo)

    def test_the_cross_family_audit_carries_the_frozen_packet_and_criteria_and_the_row_hashes_stage_2_screened(self):
        key = "config-audit-gemini-3.8-flash-high"
        frozen = "a block ran under a packet or criteria other than the frozen ones"
        for name, edit, message in (("packet", lambda b: b.update(packet_sha256="0" * 64), frozen),
                                    ("criteria", lambda b: b.update(criteria_sha256="0" * 64), frozen),
                                    ("row hashes emptied", lambda b: b.update(row_sha256={}), "has a block whose ranks lack a row_sha256 each"),
                                    ("a row hash changed", lambda b: b["row_sha256"].update({str(b["ranks"][0]): "0" * 64}), "were screened on other inputs than stage 2 screened")):
            with self.subTest(name=name):
                repo, folder = self.copy()
                meta = json.loads((folder / "meta.json").read_text())
                edit(meta["sessions"][key]["blocks"][0])
                (folder / "meta.json").write_text(json.dumps(meta))
                with self.assertRaisesRegex(TopicError, message):
                    self.render(repo)

    def test_the_cross_family_audit_must_be_the_topic_cross_family_model_outside_the_claude_family(self):
        repo, folder = self.copy()
        meta = json.loads((folder / "meta.json").read_text())
        meta["sessions"]["config-audit-gemini-3.8-flash-high"].update(cli="claude", model="claude-opus-5-5")
        (folder / "meta.json").write_text(json.dumps(meta))
        with self.assertRaisesRegex(TopicError, "config-audit-gemini-3.8-flash-high: the audit session ran claude claude-opus-5-5, not the topic's cross_family agy gemini-3.8-flash-high"):
            self.render(repo)
        repo, folder = self.copy()
        path = repo / "docs/prior-art/topics/demo.json"
        path.write_text(json.dumps({**json.loads(path.read_text()), "cross_family": {"cli": "claude", "model": "claude-haiku-5-5"}}))
        with self.assertRaisesRegex(TopicError, "the cross_family model claude-haiku-5-5 is a Claude model; the audit needs a model outside the Claude family"):
            self.render(repo)

    def test_a_missing_snowball_cut_file_and_a_screening_row_without_a_judged_score_are_refused(self):
        repo, folder = self.copy()
        (folder / "snowball-cut.json").unlink()
        with self.assertRaisesRegex(TopicError, "no snowball-cut.json in the sweep folder; under quality criteria v4 snowball-above-cut.py --all records cut_row null"):
            self.render(repo)
        repo, folder = self.copy()
        rows = [json.loads(line) for line in (folder / "config-screen-A.jsonl").read_text().splitlines()]
        del rows[0]["scores"]["Position"]
        (folder / "config-screen-A.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
        with self.assertRaisesRegex(TopicError, rf"config rank {rows[0]['order_rank']} \(session A\) lacks the judged score Position"):
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
        block = {"ranks": [1], "shape": "thin", "packet_sha256": "p" * 64, "row_sha256": {"1": "a" * 64}}
        for name in ("qgs-judge-A", "qgs-judge-B"):
            write_jsonl(folder / f"{name}.jsonl", [{"id": 1, "repo": "o/a", "verdict": "yes", "problems": ["X1"], "why": "w"}])
        sessions = {"qgs-judge-A": {**opus, "blocks": [block]}, "qgs-judge-B": {**sonnet, "blocks": [block]}}
        found = {j: {"strata": {"config": {"runs": [{"packets": ["p" * 64]}]}}} for j in ("qgs-A", "qgs-B", "reader")}
        lines = qgs_workflow(load_topic(repo, "demo"), folder, sessions, found)
        self.assertEqual(lines[-1], "- QGS reader: no candidate was queued for the reader")


class V4EscalatedRungRecordTest(unittest.TestCase):
    def test_held_out_labels_are_bound_to_the_pool_runs_made_after_them_and_label_decisions_are_validated(self):
        from study_calibration_set import labelled
        built = v4_sweep(escalate=True)
        folder = built / "docs/prior-art/sweeps" / SWEEP
        path = folder / "held-out-labels.json"
        original = path.read_text()
        labels = json.loads(original)
        next(r for r in labels["rows"] if r["user"]["decision"] == "eligible")["user"]["decision"] = "excluded: below-threshold"
        path.write_text(json.dumps(labels))
        with self.assertRaisesRegex(TopicError, r"^stage1-(config|product)-brief-claude-(opus|sonnet)-5-5: the stage-1 pool run was not made after the current held-out labels "
                                                r"\(held-out-labels.json\); "):
            render(built, load_topic(built, "demo"))
        labels = json.loads(original)
        labels["rows"][0]["user"]["decision"] = "eligiblex"
        path.write_text(json.dumps(labels))
        with self.assertRaisesRegex(TopicError, rf'^held-out-labels.json row {labels["rows"][0]["id"]} holds the decision "eligiblex", not eligible or excluded: <code>$'):
            labelled(folder, ("held-out",))

    def test_a_rung_above_the_first_is_confirmed_on_the_held_out_batch_and_its_own_bound_is_reported_apart(self):
        built = v4_sweep(escalate=True)
        text = render(built, load_topic(built, "demo"))[0]
        stage1 = section(text, "Stage 1")
        self.assertRegex(stage1, r"- rung 1: run 1 \d+/\d+ positives passed, .*; the runs differ on 1 of 120 rows; fails the rule")
        self.assertIn("- chosen: rung 2 after 2 rungs tried", stage1)
        self.assertRegex(stage1, r"- held-out confirmation: rung 2 passed (\d+)/\1 held-out positives, missed none; the batch's own one-sided lower bound 0\.\d{4}; "
                                 r"the pooled bound above was measured on the set the rung was chosen on")
        self.assertRegex(section(text, "Calibration"), r"- held-out config: \d+ rows \(stage-1 rung 2 was chosen above the first: the rows are held out to confirm it\)")
        folder = built / "docs/prior-art/sweeps" / SWEEP
        original = (folder / "stage1-rung.json").read_text()
        rung = json.loads(original)
        (folder / "stage1-rung.json").write_text(json.dumps({**rung, "date": "2026-10-21"}))
        with self.assertRaisesRegex(TopicError, "held-out-set.json was not drawn after the current stage1-rung.json"):
            render(built, load_topic(built, "demo"))
        path = built / "docs/prior-art/topics/demo.json"
        topic = json.loads(path.read_text())
        (folder / "stage1-rung.json").write_text(original)
        inside = json.loads((folder / "calibration-set.json").read_text())["rows"][0]["repo"]
        path.write_text(json.dumps({**topic, "stage1_examples": [{**topic["stage1_examples"][0], "repo": inside}] + topic["stage1_examples"][1:]}))
        with self.assertRaisesRegex(TopicError, rf"calibration-set.json holds stage-1 worked-example repositories \['{inside}'\]"):
            render(built, load_topic(built, "demo"))
        path.write_text(json.dumps({**topic, "stage1_examples": [{**topic["stage1_examples"][0], "why": "rewritten after the freeze"}] + topic["stage1_examples"][1:]}))
        with self.assertRaisesRegex(TopicError, "stage1-freeze.json froze other worked examples than the topic config's stage1_examples hold now"):
            render(built, load_topic(built, "demo"))


if __name__ == "__main__":
    unittest.main()
