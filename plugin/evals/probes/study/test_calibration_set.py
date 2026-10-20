import hashlib
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path

from study_fixtures import script, write_json, write_jsonl
from study_session import canonical_sha256
from study_v4_fixture import CRITERIA, SECRET, SWEEP, inputs_fetch, screening_row, user_labels, v4_repo, v4_work


def draw(repo, work, *extra):
    script("draw-calibration-set").main(["--topic", "demo", "--repo", str(repo), "--work", str(work), "--criteria", CRITERIA, *extra], fetch=inputs_fetch())


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

    def importing(self, path):
        script("import-calibration-labels").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--labels", str(path)])

    def test_sixty_rows_per_stratum_half_likely_positives_even_over_the_facets_in_a_shuffled_order(self):
        rows = self.sample["rows"]
        self.assertEqual([sum(r["stratum"] == s for r in rows) for s in ("config", "product")], [60, 60])
        self.assertEqual(set(rows[0]), {"id", "stratum", "order_rank", "repo", "commit", "inputs_sha256", "facets"})
        self.assertEqual(len({r["id"] for r in rows}), 120)
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
        self.assertEqual(first["inputs_sha256"], canonical_sha256(inputs[first["order_rank"]]))
        self.assertEqual((self.sample["criteria"], self.sample["size_per_stratum"]), (CRITERIA, 60))

    def test_the_draw_is_seeded_and_never_redrawn(self):
        with self.assertRaisesRegex(SystemExit, "calibration-set.json already exists"):
            draw(self.repo, self.work)
        again = v4_work(self.repo)
        draw(self.repo, again)
        self.assertEqual((again / "calibration-set.json").read_text(), (self.work / "calibration-set.json").read_text())

    def test_the_page_is_self_contained_vietnamese_and_shows_inputs_and_anchors_only(self):
        self.assertIn("<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'\">", self.page)
        self.assertIsNone(re.search(r"<(?:script|link|img|iframe|object|embed|audio|video|source)\b[^>]*\b(?:src|href)=", self.page))
        for banned in ("fetch(", "XMLHttpRequest", "@import", "url(", "http://", "<a "):
            self.assertNotIn(banned, self.page.replace("&lt;img src=https://example.com/x.png", ""))
        for text in ("Bộ hiệu chuẩn", "Đủ điều kiện", "Loại", "Tải nhãn về (JSON)", "Mở file nhãn đã lưu", "Date do công cụ tính sẵn",
                     "Novelty = 1 khi dòng có ít nhất một cơ chế: khi hiệu chuẩn, mọi cơ chế đều được tính là mới"):
            self.assertIn(text, self.page)
        for criterion in ("Authority", "Methodology", "Objectivity", "Position", "Relevance"):
            self.assertIn(f"<h3>{criterion}</h3>", self.page)
        self.assertIn("The vendor (Anthropic), or the repository ships a released product", self.page)
        self.assertIn("Derived: at least one mechanism for the problem is coded from the source&#x27;s own files", self.page)
        self.assertIn("&lt;img src=https://example.com/x.png onerror=alert(1)&gt;", self.page)
        self.assertIn("computed by the toolchain: pushed 2026-09-01, 49 days before the sweep date 2026-10-20", self.page)
        self.assertEqual(self.page.count('<section class="row"'), 120)
        for leak in (SECRET, "qgs candidate", "top-ranked", "random", "facet_rank", "calibration-draw"):
            self.assertNotIn(leak, self.page)

    def test_labels_are_imported_only_for_this_set_and_with_valid_values(self):
        labels = user_labels(self.sample)
        with self.assertRaisesRegex(SystemExit, "was saved for another calibration set"):
            self.importing(self.labels_file(labels, set_sha="0" * 64))
        first = self.sample["rows"][0]["id"]
        for field, value, message in (("Relevance", True, "ratings are 1, 0.5 or 0"), ("Methodology", 0.7, "ratings are 1, 0.5 or 0"),
                                      ("decision", "maybe", "eligible or excluded: <code>"), ("decision", "excluded: lazy", "eligible or excluded: <code>")):
            with self.assertRaisesRegex(SystemExit, message):
                self.importing(self.labels_file({**labels, first: {**labels[first], field: value}}))
        with self.assertRaisesRegex(SystemExit, "names rows the set does not hold"):
            self.importing(self.labels_file({**labels, "config-999": labels[first]}))
        partial = dict(labels)
        partial[first] = {k: v for k, v in labels[first].items() if k != "Position"}
        self.importing(self.labels_file(partial))
        kept = json.loads((self.work / "calibration-labels.json").read_text())
        self.assertEqual((kept["complete"], len(kept["rows"])), (119, 120))
        self.importing(self.labels_file(labels))
        kept = json.loads((self.work / "calibration-labels.json").read_text())
        self.assertEqual(kept["complete"], 120)
        self.assertEqual(kept["rows"][0]["user"], labels[first])
        self.assertEqual(kept["set_sha256"], hashlib.sha256((self.work / "calibration-set.json").read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
