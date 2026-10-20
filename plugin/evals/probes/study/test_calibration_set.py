import hashlib
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path

from study_fixtures import script, write_json, write_jsonl
from study_session import canonical_sha256, qgs_shape
from study_v4_fixture import CRITERIA, SECRET, SWEEP, TODAY, drawn_and_labelled, inputs_fetch, quiet, screening_row, user_labels, v4_repo, v4_work


def draw(repo, work, *extra, today=TODAY):
    script("draw-calibration-set").main(["--topic", "demo", "--repo", str(repo), "--work", str(work), "--criteria", CRITERIA, "--today", today, *extra], fetch=inputs_fetch())


class CalibrationSetTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo = v4_repo()
        cls.work = v4_work(cls.repo)
        order = [json.loads(line) for line in (cls.work / "config-screening-order.jsonl").read_text().splitlines()]
        write_jsonl(cls.work / "config-screen-A.jsonl", [screening_row(r) for r in order[:5]])
        write_json(cls.work / "meta.json", {"sessions": {"judge-config-screening-A-claude-opus-5-5-run1": {"blocks": [{"note": SECRET}]}}})
        draw(cls.repo, cls.work)
        cls.sample = json.loads((cls.work / "calibration-set.json").read_text())
        cls.page = (cls.work / "calibration.html").read_text()

    def labels_file(self, labels, set_sha=None):
        path = Path(tempfile.mkdtemp(prefix="study-labels-")) / "calibration-labels-261020-demo.json"
        self.addCleanup(shutil.rmtree, path.parent)
        sha = set_sha or hashlib.sha256((self.work / "calibration-set.json").read_bytes()).hexdigest()
        path.write_text(json.dumps({"sweep": SWEEP, "set_sha256": sha, "labels": labels}))
        return path

    def importing(self, path, work=None):
        script("import-calibration-labels").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(work or self.work), "--labels", str(path)])

    def frozen(self, work):
        quiet(self.repo, "freeze-stage1", "--work", str(work), "--today", TODAY)

    def test_sixty_rows_per_stratum_half_likely_positives_even_over_the_facets_in_a_shuffled_order(self):
        rows = self.sample["rows"]
        self.assertEqual([sum(r["stratum"] == s for r in rows) for s in ("config", "product")], [60, 60])
        self.assertEqual(set(rows[0]), {"id", "stratum", "order_rank", "repo", "commit", "inputs_sha256", "qgs_sha256"})
        self.assertEqual(len({r["id"] for r in rows}), 120)
        self.assertTrue(rows[0]["id"].startswith("calibration-"))
        drawn = json.loads((self.work / "calibration-draw.json").read_text())["rows"]
        by_id = {d["id"]: d for d in drawn}
        for stratum in ("config", "product"):
            mine = [by_id[r["id"]] for r in rows if r["stratum"] == stratum]
            self.assertEqual([sum(d["facet"] == f for d in mine) for f in ("alpha", "beta")], [30, 30])
            self.assertEqual(sum(d["class"] != "random" for d in mine), 30)
            classes = [d["class"] != "random" for d in mine]
            self.assertNotEqual(classes, sorted(classes, reverse=True))
        inputs = {r["order_rank"]: r for r in map(json.loads, (self.work / "config-screening-inputs.jsonl").read_text().splitlines())}
        first = next(r for r in rows if r["stratum"] == "config")
        self.assertEqual((first["inputs_sha256"], first["qgs_sha256"]), (canonical_sha256(inputs[first["order_rank"]]), canonical_sha256(qgs_shape(inputs[first["order_rank"]]))))
        self.assertEqual((self.sample["criteria"], self.sample["rows_per_stratum"], self.sample["batch"]), (CRITERIA, {"config": 60, "product": 60}, "calibration"))

    def test_the_set_is_drawn_only_after_the_stage1_inputs_exist_seeded_and_never_redrawn(self):
        with self.assertRaisesRegex(SystemExit, "calibration-set.json already exists"):
            draw(self.repo, self.work)
        again = v4_work(self.repo)
        draw(self.repo, again)
        self.assertEqual((again / "calibration-set.json").read_text(), (self.work / "calibration-set.json").read_text())
        late = v4_work(self.repo)
        with self.assertRaisesRegex(SystemExit, r"the sweep 261020-demo is not named for the draw date 2026-10-22; name the v4 sweep <yymmdd>-<topic> at the calibration draw"):
            draw(self.repo, late, today="2026-10-22")
        self.assertEqual(self.sample["drawn"], TODAY)
        early = v4_work(self.repo)
        (early / "stage1-inputs-product-brief.jsonl").unlink()
        with self.assertRaisesRegex(SystemExit, "no stage1-inputs-product-brief.jsonl in .*; the calibration set is drawn after the stage-1 inputs exist"):
            draw(self.repo, early)

    def test_the_draw_orders_rows_by_sha256_under_the_seed_records_unreadable_rows_and_replays_without_fetching(self):
        from study_calibration_set import redraw
        from study_topic import load_topic
        drawn = json.loads((self.work / "calibration-draw.json").read_text())
        self.assertEqual(drawn["set_sha256"], hashlib.sha256((self.work / "calibration-set.json").read_bytes()).hexdigest())
        self.assertEqual(set(drawn["skipped"]), {"config", "product"})
        config = [r["order_rank"] for r in self.sample["rows"] if r["stratum"] == "config"]
        self.assertEqual(config, sorted(config, key=lambda r: hashlib.sha256(f"261020-demo:calibration:config:order:{r}".encode()).hexdigest()))
        topic = load_topic(self.repo, "demo")
        rows, provenance = redraw(topic, self.work, "calibration")
        self.assertEqual(rows, [{k: r[k] for k in ("id", "stratum", "order_rank", "repo")} for r in self.sample["rows"]])
        self.assertEqual(provenance, drawn["rows"])
        copy = Path(tempfile.mkdtemp(prefix="study-redraw-"))
        self.addCleanup(shutil.rmtree, copy, ignore_errors=True)
        shutil.copytree(self.work, copy, dirs_exist_ok=True)
        write_json(copy / "calibration-draw.json", {**drawn, "skipped": {**drawn["skipped"], "config": sorted(drawn["skipped"]["config"] + [config[0]])}})
        self.assertNotIn(config[0], [r["order_rank"] for r in redraw(topic, copy, "calibration")[0]])

    def test_repositories_used_as_stage1_worked_examples_are_never_drawn(self):
        repo = v4_repo()
        path = repo / "docs/prior-art/topics/demo.json"
        topic = json.loads(path.read_text())
        drawn = {r["repo"] for r in self.sample["rows"]}
        used = sorted(drawn)[:6]
        topic["stage1_examples"] = [{**e, "repo": r} for e, r in zip(topic["stage1_examples"], used)]
        write_json(path, topic)
        work = v4_work(repo)
        draw(repo, work)
        again = {r["repo"] for r in json.loads((work / "calibration-set.json").read_text())["rows"]}
        self.assertFalse(again & set(used))
        self.assertEqual(len(again), 120)

    def test_the_page_is_self_contained_vietnamese_and_shows_inputs_anchors_and_problem_ids_only(self):
        self.assertIn("<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'\">", self.page)
        self.assertIsNone(re.search(r"<(?:script|link|img|iframe|object|embed|audio|video|source)\b[^>]*\b(?:src|href)=", self.page))
        for banned in ("fetch(", "XMLHttpRequest", "@import", "url(", "http://", "<a "):
            self.assertNotIn(banned, self.page.replace("&lt;img src=https://example.com/x.png", ""))
        for text in ("Bộ hiệu chuẩn", "Đủ điều kiện", "Loại", "Tải nhãn về (JSON)", "Mở file nhãn đã lưu", "Date do công cụ tính sẵn", "Vấn đề (mã trong danh mục)",
                     "Novelty = 1 khi dòng có ít nhất một cơ chế: khi hiệu chuẩn, mọi cơ chế đều được tính là mới"):
            self.assertIn(text, self.page)
        for criterion in ("Authority", "Methodology", "Objectivity", "Position", "Relevance"):
            self.assertIn(f"<h3>{criterion}</h3>", self.page)
        first = self.sample["rows"][0]["id"]
        self.assertEqual(re.findall(rf'name="{first}\|problems" value="(X\d)"', self.page), ["X1", "X2", "X3", "X4"])
        self.assertIn("The vendor (Anthropic), or the repository ships a released product", self.page)
        self.assertIn("&lt;img src=https://example.com/x.png onerror=alert(1)&gt;", self.page)
        self.assertIn("computed by the toolchain: pushed 2026-09-01, 49 days before the sweep date 2026-10-20", self.page)
        self.assertEqual(self.page.count('<section class="row"'), 120)
        for leak in (SECRET, "qgs candidate", "top-ranked", "random", "facet_rank", "calibration-draw"):
            self.assertNotIn(leak, self.page)

    def test_labels_are_imported_only_after_the_stage1_freeze_for_this_set_and_with_valid_values(self):
        labels = user_labels(self.sample)
        work = Path(tempfile.mkdtemp(prefix="study-labels-work-"))
        self.addCleanup(shutil.rmtree, work)
        shutil.copytree(self.work, work, dirs_exist_ok=True)
        with self.assertRaisesRegex(SystemExit, "no stage1-freeze.json in .*; freeze the stage-1 ladder with freeze-stage1.py before any calibration label is read"):
            self.importing(self.labels_file(labels), work)
        self.frozen(work)
        with self.assertRaisesRegex(SystemExit, "was saved for another calibration set"):
            self.importing(self.labels_file(labels, set_sha="0" * 64), work)
        first = self.sample["rows"][0]["id"]
        eligible = next(k for k, v in labels.items() if v["decision"] == "eligible")
        for key, change, message in ((first, {"Relevance": True}, "ratings are 1, 0.5 or 0"), (first, {"Methodology": 0.7}, "ratings are 1, 0.5 or 0"),
                                     (first, {"decision": "maybe"}, "eligible or excluded: <code>"), (first, {"decision": "excluded: lazy"}, "eligible or excluded: <code>"),
                                     (eligible, {"Relevance": 0, "problems": []}, "eligible needs Relevance 1, the label gives 0"),
                                     (eligible, {"problems": []}, "Relevance 1 names the problem it carries a mechanism for; tick at least one problem id"),
                                     (eligible, {"problems": ["X9"]}, r"problems \['X9'\] are not a list of the topic's problem ids")):
            with self.assertRaisesRegex(SystemExit, message):
                self.importing(self.labels_file({**labels, key: {**labels[key], **change}}), work)
        with self.assertRaisesRegex(SystemExit, "names rows the set does not hold"):
            self.importing(self.labels_file({**labels, "calibration-config-999": labels[first]}), work)
        partial = dict(labels)
        partial[first] = {k: v for k, v in labels[first].items() if k != "Position"}
        self.importing(self.labels_file(partial), work)
        kept = json.loads((work / "calibration-labels.json").read_text())
        self.assertEqual((kept["complete"], len(kept["rows"])), (119, 120))
        self.importing(self.labels_file(labels), work)
        kept = json.loads((work / "calibration-labels.json").read_text())
        self.assertEqual((kept["complete"], kept["rows"][0]["user"], kept["batch"]), (120, labels[first], "calibration"))
        self.assertEqual(kept["stage1_freeze_sha256"], hashlib.sha256((work / "stage1-freeze.json").read_bytes()).hexdigest())

    def fresh(self):
        work = v4_work(self.repo)
        self.frozen(work)
        return work

    def test_too_few_positives_pooled_fires_the_top_up_draw_of_enriched_rows_that_join_the_pooled_bound(self):
        work = self.fresh()
        with self.assertRaisesRegex(SystemExit, "no calibration-labels.json"):
            draw(self.repo, work, "--top-up", "30")
        sample = drawn_and_labelled(self.repo, work)
        labels = user_labels(sample)
        few = {k: v if n < 40 or v["decision"] != "eligible" else {**v, "decision": "excluded: below-threshold"} for n, (k, v) in enumerate(labels.items())}
        quiet(self.repo, "import-calibration-labels", "--work", str(work), "--labels", str(self.labels_into(work, few)))
        with self.assertRaisesRegex(SystemExit, "a top-up batch holds 30 to 40 rows, not 50"):
            draw(self.repo, work, "--top-up", "50")
        top = drawn_and_labelled(self.repo, work, top_up=30)
        self.assertEqual((top["batch"], top["purpose"], top["rows_per_stratum"]), ("top-up", f"fewer than 59 positives pooled ({self.positives(few)}): the rows join the pooled bound",
                                                                                    {"config": 15, "product": 15}))
        drawn = json.loads((work / "top-up-draw.json").read_text())["rows"]
        self.assertEqual((len(drawn), sum(d["class"] == "random" for d in drawn)), (30, 0))
        self.assertFalse({(r["stratum"], r["order_rank"]) for r in top["rows"]} & {(r["stratum"], r["order_rank"]) for r in sample["rows"]})
        self.assertIn("Lô bổ sung", (work / "top-up.html").read_text())
        from study_calibration_set import labelled
        self.assertEqual(len(labelled(work, ("calibration", "top-up"))), 150)

    def test_a_rung_above_the_first_fires_the_held_out_draw_and_no_trigger_refuses_any_top_up(self):
        work = self.fresh()
        drawn_and_labelled(self.repo, work)
        with self.assertRaisesRegex(SystemExit, r"no top-up trigger fired: the labels hold \d+ positives pooled \(at least 59\) and no stage-1 rung is chosen yet"):
            draw(self.repo, work, "--top-up", "30")
        write_json(work / "stage1-rung.json", {"rung": 1})
        with self.assertRaisesRegex(SystemExit, "no top-up trigger fired: .* and rung 1 was chosen"):
            draw(self.repo, work, "--top-up", "30")
        write_json(work / "stage1-rung.json", {"rung": 3})
        held = drawn_and_labelled(self.repo, work, top_up=40)
        self.assertEqual((held["batch"], held["purpose"], len(held["rows"])), ("held-out", "stage-1 rung 3 was chosen above the first: the rows are held out to confirm it", 40))
        self.assertIn("Lô kiểm chứng giữ riêng", (work / "held-out.html").read_text())

    def labels_into(self, work, labels):
        path = work / "saved.json"
        path.write_text(json.dumps({"sweep": SWEEP, "set_sha256": hashlib.sha256((work / "calibration-set.json").read_bytes()).hexdigest(), "labels": labels}))
        return path

    @staticmethod
    def positives(labels):
        return sum(v["decision"] == "eligible" for v in labels.values())


if __name__ == "__main__":
    unittest.main()
