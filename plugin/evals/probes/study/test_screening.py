import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from study_fixtures import HERE, script, screen_row, topic_repo, write_json, write_jsonl
from study_sweep_record import MechanismTable
from study_topic import TopicError, load_topic, sweep_folder

KIT = HERE.parents[3]

class Base(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo()
        self.addCleanup(shutil.rmtree, self.repo)
        self.topic = load_topic(self.repo, "demo")
        self.folder = sweep_folder(self.repo, self.topic)


class CompareTest(Base):
    def test_agreement_and_chapman_over_the_rows_both_sessions_screened(self):
        out = script("compare-screening-sessions").compare(self.folder, "config", None)
        self.assertEqual((out["rows"], out["judged_cells"], out["identical"], out["agreement"]), (4, 20, 19, 0.95))
        self.assertEqual(out["differing_by_criterion"], {"Authority": 1})
        self.assertEqual(out["mechanisms"].get("chapman_lower_bound"), 1.0)
        self.assertNotIn("chapman", out["mechanisms"])
        self.assertIn("not independent", out["mechanisms"].get("chapman_note", ""))
        self.assertFalse(out["mechanisms"]["third_reader_needed"])
        self.assertEqual(script("compare-screening-sessions").compare(self.folder, "config", 2)["rows"], 2)

    def test_kappa_per_judged_criterion_leaves_out_the_computed_date_and_adds_eligibility(self):
        out = script("compare-screening-sessions").compare(self.folder, "config", None)
        self.assertEqual(out.get("kappa"), {"Authority": 0.556, "Methodology": 1.0, "Objectivity": 1.0, "Position": 1.0})
        self.assertEqual((out.get("eligibility_kappa"), out.get("eligibility_differ")), (1.0, 0))

    def test_kappa_on_the_dev_sweep_matches_the_recomputed_audit_figures(self):
        compare = script("compare-screening-sessions")
        folder = sweep_folder(KIT, load_topic(KIT, "dev"))
        config, product = compare.compare(folder, "config", None), compare.compare(folder, "product", 70)
        self.assertEqual({c: round(k, 2) for c, k in config["kappa"].items() if c != "Authority"}, {"Methodology": 0.49, "Objectivity": 0.79, "Position": 0.74})
        self.assertEqual({c: round(k, 2) for c, k in product["kappa"].items() if c != "Authority"}, {"Methodology": 0.42, "Objectivity": 0.46, "Position": 0.40})

    def test_disjoint_lists_call_for_a_third_reader(self):
        write_jsonl(self.folder / "config-screen-B.jsonl", [screen_row(r, f"o/{r}", 1, [f"b{r}"]) for r in (1, 2, 3, 5)])
        write_jsonl(self.folder / "config-screen-A.jsonl", [screen_row(r, f"o/{r}", 1, [f"a{r}"]) for r in (1, 2, 3, 5)])
        out = script("compare-screening-sessions").compare(self.folder, "config", None)
        self.assertEqual((out["mechanisms"]["union"], out["mechanisms"]["chapman_lower_bound"], out["mechanisms"]["third_reader_needed"]), (8, 24.0, True))

    def test_the_effort_bound_stop_skips_forced_rows_and_needs_a_dry_block(self):
        compare = script("compare-screening-sessions")
        ranks = [r for r in range(1, 82)]
        firsts = {5: {"a"}, 55: {"c"}, 63: {"b"}}
        self.assertEqual(compare.stop_row(compare.block_yields(ranks, firsts, {32})), 81)
        self.assertEqual(compare.stop_row(compare.block_yields(ranks, firsts, set())), 80)
        self.assertIsNone(compare.stop_row(compare.block_yields(ranks[:71], firsts, {32})))

    def test_an_exhausted_pool_stops_at_its_last_unforced_row(self):
        compare = script("compare-screening-sessions")
        self.assertEqual(compare.effort_stop([1, 2, 3, 5], {}, {5}, [1, 2, 3, 5]), (3, "pool exhausted"))
        self.assertEqual(compare.effort_stop([1, 2, 3], {}, set(), [1, 2, 3, 4]), (None, "not reached"))
        ranks = list(range(1, 82))
        self.assertEqual(compare.effort_stop(ranks, {5: {"a"}, 55: {"c"}, 63: {"b"}}, set(), ranks + [82]), (80, "effort bound"))

    def test_the_toolchain_writes_the_stop_row_into_the_topic_config(self):
        path = self.repo / "docs/prior-art/topics/demo.json"
        result = subprocess.run([sys.executable, "-B", str(HERE / "compare-screening-sessions.py"), "--topic", "demo", "--repo", str(self.repo), "--stratum", "config", "--write-stop"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(path.read_text())["strata"]["config"]["stop_row"], 3)
        self.assertIn("stop_row 3 (pool exhausted) written", result.stdout)

    def test_writing_the_stop_row_keeps_the_hand_formatting(self):
        from study_topic import write_stop_row
        path = self.repo / "docs/prior-art/topics/demo.json"
        path.write_text('{\n  "sweep": "261001-demo",\n  "terms": ["tdd", "test"],\n  "strata": {\n    "config": {\n      "stop_row": null,\n      "forced_repos": ["o/forced"]\n    },\n'
                        '    "local": {"stop_row": null, "forced_repos": []}\n  }\n}\n')
        write_stop_row(load_topic(self.repo, "demo"), "local", 7)
        self.assertEqual(path.read_text().splitlines()[5:], ['      "stop_row": null,', '      "forced_repos": ["o/forced"]', "    },", '    "local": {"stop_row": 7, "forced_repos": []}', "  }", "}"])
        write_json(path, {"sweep": "261001-demo", "terms": ["tdd"], "strata": {"config": {"forced_repos": []}}})
        write_stop_row(load_topic(self.repo, "demo"), "config", 4)
        self.assertEqual(json.loads(path.read_text())["strata"]["config"], {"stop_row": 4, "forced_repos": []})

    def test_the_snowball_cut_before_screening_is_the_effort_bound(self):
        snowball = script("snowball-above-cut")
        self.assertEqual(snowball.planned_cut({**self.topic, "strata": {"config": {"stop_row": None}}}), 60)
        self.assertEqual(snowball.planned_cut({**self.topic, "strata": {"config": {"stop_row": 101}}}), 101)

    def test_no_shared_rows_is_refused(self):
        write_jsonl(self.folder / "config-screen-B.jsonl", [])
        with self.assertRaisesRegex(TopicError, "share no screened config row"):
            script("compare-screening-sessions").compare(self.folder, "config", None)


class ExportTest(Base):
    def setUp(self):
        super().setUp()
        self.work = Path(tempfile.mkdtemp(prefix="study-work-"))
        self.addCleanup(shutil.rmtree, self.work)
        shutil.rmtree(self.folder)
        write_jsonl(self.work / "config-screen-A.jsonl", [{"order_rank": 1, "repo": "o/a", "sha": "b" * 40, "note": "blob " + "c" * 40}])
        write_jsonl(self.work / "config-screening-order.jsonl", [{"order_rank": 1, "repo": "o/a", "via": ["x"], "forced": False}])
        write_json(self.work / "meta.json", {"title": "t"})

    def test_rows_are_pinned_and_long_hashes_cut(self):
        (self.work / "config-screen-A-mechanisms.md").write_text(f"gate: see {self.repo}/docs/prior-art/x.md\n")
        out, counts = script("export-sweep-data").export(self.topic, self.repo, self.work)
        row = json.loads((out / "config-screen-A.jsonl").read_text())
        self.assertEqual(row, {"order_rank": 1, "repo": "o/a", "note": "blob " + "c" * 12, "commit": "https://github.com/o/a/commit/" + "b" * 40})
        self.assertEqual(json.loads((out / "config-screening-order.jsonl").read_text()), {"order_rank": 1, "repo": "o/a", "forced": False})
        self.assertEqual((out / "config-screen-A-mechanisms.md").read_text(), "gate: see docs/prior-art/x.md\n")
        self.assertEqual(counts["meta.json"], "copied")

    def test_the_method_evidence_is_exported_and_fetched_source_text_is_not(self):
        write_json(self.work / "protocol-freeze.json", {"strata": {}})
        write_json(self.work / "calibration-sample.json", {"rows": []})
        write_json(self.work / "config-qgs-adjudicated.json", {"final": []})
        write_jsonl(self.work / "config-qgs-judge-A.jsonl", [{"id": 1}])
        write_jsonl(self.work / "config-pilot-B-gemini-3.8-flash-high.jsonl", [{"order_rank": 1, "repo": "o/a", "sha": "b" * 40}])
        (self.work / "config-pilot-A-mechanisms.md").write_text("gate: g\n")
        write_jsonl(self.work / "config-screening-inputs.jsonl", [{"order_rank": 1, "files": [{"text": "copied source"}]}])
        (self.work / "prompts").mkdir()
        (self.work / "prompts/config-screen-A-1-5.md").write_text("copied source")
        out, counts = script("export-sweep-data").export(self.topic, self.repo, self.work)
        for name in ("protocol-freeze.json", "calibration-sample.json", "config-qgs-adjudicated.json", "config-qgs-judge-A.jsonl", "config-pilot-A-mechanisms.md"):
            self.assertTrue((out / name).is_file(), name)
        self.assertEqual(json.loads((out / "config-pilot-B-gemini-3.8-flash-high.jsonl").read_text())["commit"], "https://github.com/o/a/commit/" + "b" * 40)
        self.assertFalse((out / "config-screening-inputs.jsonl").exists())
        self.assertFalse((out / "prompts").exists())

    def test_digests_survive_the_export_and_only_loose_hashes_are_cut(self):
        clean = script("export-sweep-data").clean
        value = {"sessions": {"config-A": {"packet_sha256": "a" * 64, "blocks": [{"row_sha256": {"1": "b" * 64}}]}}, "note": "blob " + "c" * 40, "digest": "d" * 64}
        self.assertEqual(clean(value), {"sessions": {"config-A": {"packet_sha256": "a" * 64, "blocks": [{"row_sha256": {"1": "b" * 64}}]}}, "note": "blob " + "c" * 12, "digest": "d" * 64})

    def test_a_home_path_left_in_text_is_refused(self):
        (self.work / "screening-packet-config.md").write_text("read " + "/".join(["", "home", "someone", "notes.md"]) + "\n")
        with self.assertRaisesRegex(TopicError, "still holds a home path"):
            script("export-sweep-data").export(self.topic, self.repo, self.work)


class PickTest(unittest.TestCase):
    def test_greedy_picks_the_largest_new_gain_after_the_cards(self):
        table = MechanismTable({"aliases": {}, "class": {"c:k": "K1"}, "default": "new"})
        rows = [{"rank": 1, "repo": "o/card", "decision": "study", "session_mechs": {"c:a"}, "issues": set()},
                {"rank": 2, "repo": "o/big", "decision": "eligible", "session_mechs": {"c:a", "c:b", "c:c"}, "issues": set()},
                {"rank": 3, "repo": "o/small", "decision": "study (below-threshold: 4)", "session_mechs": {"c:b", "c:k"}, "issues": {"#1"}},
                {"rank": 4, "repo": "o/out", "decision": "excluded: irrelevant", "session_mechs": {"c:z"}, "issues": set()}]
        steps = list(script("pick-deep-study").greedy({"config": rows}, table, ["o/card"], 2))
        self.assertEqual([(b["repo"], g) for b, g in steps[:-1]], [("o/big", ["c:b", "c:c"]), ("o/small", [])])
        self.assertEqual({k: steps[-1][0][k] for k in ("eligible", "new_total", "covered")}, {"eligible": 3, "new_total": 3, "covered": 3})

    def test_cards_are_read_from_frontmatter_and_the_template_is_ignored(self):
        repo = Path(tempfile.mkdtemp(prefix="study-cards-"))
        self.addCleanup(shutil.rmtree, repo)
        (repo / "docs/prior-art").mkdir(parents=True)
        (repo / "docs/prior-art/card.md").write_text("---\nname: o/card\n---\n")
        (repo / "docs/prior-art/procedure.md").write_text("---\nname: <owner/repo>\n---\n")
        (repo / "docs/prior-art/notes.md").write_text("# notes\n")
        self.assertEqual(script("pick-deep-study").card_sources(repo), ["o/card"])


if __name__ == "__main__":
    unittest.main()
