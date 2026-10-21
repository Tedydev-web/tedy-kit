import hashlib
import json
import re
import shutil
import tempfile
import unittest
from datetime import date
from pathlib import Path

from study_fixtures import script, write_json, write_jsonl
from study_session import canonical_sha256, qgs_shape
from study_topic import TopicError, load_topic
from study_v4_fixture import CRITERIA, SECRET, SWEEP, TODAY, drawn_and_labelled, inputs_fetch, quiet, screening_row, user_labels, v4_repo, v4_work


def draw(repo, work, *extra, today=TODAY):
    script("draw-calibration-set").main(["--topic", "demo", "--repo", str(repo), "--work", str(work), "--criteria", CRITERIA, "--today", today, *extra], fetch=inputs_fetch())


ELIGIBILITY = {"vi": "Câu hỏi <b>giám khảo</b>.\nCâu thứ hai.", "en": "The judges' <b>question</b>.\nThe second line."}


def drawn_work(**topic_fields):
    repo = v4_repo()
    if topic_fields:
        path = repo / "docs/prior-art/topics/demo.json"
        write_json(path, {**json.loads(path.read_text()), **topic_fields})
    work = v4_work(repo)
    order = [json.loads(line) for line in (work / "config-screening-order.jsonl").read_text().splitlines()]
    write_jsonl(work / "config-screen-A.jsonl", [screening_row(r) for r in order[:5]])
    write_json(work / "meta.json", {"sessions": {"judge-config-screening-A-claude-opus-5-5-run1": {"blocks": [{"note": SECRET}]}}})
    draw(repo, work)
    return repo, work


class CalibrationSetTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo, cls.work = drawn_work()
        cls.sample = json.loads((cls.work / "calibration-set.json").read_text())
        cls.page = (cls.work / "calibration.html").read_text()

    def labels_file(self, labels, set_sha=None, extra=None):
        path = Path(tempfile.mkdtemp(prefix="study-labels-")) / "calibration-labels-261020-demo.json"
        self.addCleanup(shutil.rmtree, path.parent)
        sha = set_sha or hashlib.sha256((self.work / "calibration-set.json").read_bytes()).hexdigest()
        path.write_text(json.dumps({"sweep": SWEEP, "set_sha256": sha, "labels": labels, **(extra or {})}))
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

    def test_the_page_counts_a_row_as_labelled_exactly_when_the_import_would_keep_it_complete(self):
        import subprocess
        from study_calibration_set import FIELDS, checked_label
        from study_topic import TopicError
        full = {"Authority": 1, "Methodology": 1, "Objectivity": 1, "Position": 1, "Relevance": 1, "problems": ["X1"], "decision": "eligible"}
        cases = [full, {**full, "Relevance": 0.5}, {**full, "problems": []}, {**full, "Relevance": 0.5, "decision": "excluded: below-threshold", "problems": []},
                 {k: v for k, v in full.items() if k != "problems"}, {**{k: v for k, v in full.items() if k != "problems"}, "Relevance": 0, "decision": "excluded: irrelevant"},
                 {**full, "Relevance": 0, "decision": "eligible", "problems": []}, {k: v for k, v in full.items() if k != "decision"}]

        def imported(label):
            try:
                kept = checked_label("row", label, ["X1", "X2", "X3", "X4"])
            except TopicError:
                return False
            return all(f in kept for f in FIELDS)

        script_text = re.search(r"<script>(.*)</script>", self.page, re.S).group(1)
        functions = "\n".join(re.findall(r"^  const (?:FIELDS|valid|complete) = .*$", script_text, re.M))
        code = f"{functions}\nconsole.log(JSON.stringify({json.dumps(cases)}.map((label) => complete(label))));"
        page = json.loads(subprocess.run(["node", "-e", code], capture_output=True, text=True, check=True).stdout)
        self.assertEqual(page, [imported(c) for c in cases])
        self.assertEqual(page, [True, False, False, True, False, True, False, False])

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

    def test_a_topic_without_an_eligibility_definition_renders_the_page_byte_identical_to_before_the_field(self):
        self.assertEqual(hashlib.sha256(self.page.encode()).hexdigest(), "e1b1037c5e9afefa2fbfd83155e2c35e66c8d3ad93f01506ae332458032fd6ea")
        self.assertNotIn('id="eligibility"', self.page)

    def test_removing_the_highlight_note_style_and_marks_gives_back_the_page_byte_identical_to_before_the_highlight(self):
        bare = re.sub(r"<p>Tô sáng theo [^<]*</p>", "", self.page, count=1).replace(".hit{background:#ffe08a;font-weight:600}", "")
        bare = re.sub(r'<span class="hit">([^<]*)</span>', r"\1", bare).replace("<details open><summary>Danh sách thư mục gốc", "<details><summary>Danh sách thư mục gốc")
        bare = re.sub(r' data-highlight="[0-9a-f]{64}"', "", bare, count=1).replace(" highlight_sha256: document.body.dataset.highlight,", "")
        self.assertEqual(hashlib.sha256(bare.encode()).hexdigest(), "07a08fa6bc8cdc3e94eef0aa5d4d4a78b19dfefd6fb6ed6ad8111eb333a5ac13")

    def test_the_topic_eligibility_definition_tops_the_page_escaped_and_leaves_the_set_and_the_draw_unchanged(self):
        _, work = drawn_work(eligibility=ELIGIBILITY)
        for name in ("calibration-set.json", "calibration-draw.json"):
            self.assertEqual((work / name).read_bytes(), (self.work / name).read_bytes())
        page = (work / "calibration.html").read_text()
        start, end = page.index('<aside id="eligibility"'), page.index("</aside>\n") + len("</aside>\n")
        self.assertEqual(page[:start] + page[end:], self.page)
        self.assertLess(page.index("</header>"), start)
        self.assertLess(end, page.index('<section class="row"'))
        block = page[start:end]
        for text in ("Định nghĩa đủ điều kiện của giám khảo stage-1", "<p>Câu hỏi &lt;b&gt;giám khảo&lt;/b&gt;.</p>", "<p>Câu thứ hai.</p>",
                     '<div lang="en">', "<p>The judges&#x27; &lt;b&gt;question&lt;/b&gt;.</p>", "<p>The second line.</p>"):
            self.assertIn(text, block)
        self.assertNotIn("<b>", block)

    def test_listing_entries_matching_the_frozen_pattern_list_are_highlighted_escaped_and_open_the_listing(self):
        from study_calibration_set import row_section
        anchor = {c: {"1": "a", "0.5": "b", "0": "c"} for c in ("Authority", "Methodology", "Objectivity", "Position", "Relevance")}

        def listing(names):
            section = row_section(1, 1, "k", "config", {"repo": "o/r", "listing": names}, anchor, date(2026, 10, 20), [])
            return re.search(r"<details( open)?><summary>Danh sách thư mục gốc</summary><pre>(.*?)</pre></details>", section, re.S).groups()

        self.assertEqual(listing([".github", "src", "<b>x</b>", "CONTRIBUTING.md", "eslint.config.js", "docs"]),
                         (" open", '<span class="hit">.github</span>, src, &lt;b&gt;x&lt;/b&gt;, <span class="hit">CONTRIBUTING.md</span>, '
                                   '<span class="hit">eslint.config.js</span>, docs'))
        self.assertEqual(listing(["src", "docs", "README.md"]), (None, "src, docs, README.md"))
        self.assertEqual(listing([]), (None, ""))

    def test_the_pattern_list_is_frozen_lowercase_and_its_sha256_is_the_newline_joined_list(self):
        from study_calibration_set import HIGHLIGHT_PATTERNS, highlight_sha256
        self.assertEqual(highlight_sha256(), hashlib.sha256(("\n".join(HIGHLIGHT_PATTERNS) + "\n").encode()).hexdigest())
        self.assertIsInstance(HIGHLIGHT_PATTERNS, tuple)
        self.assertEqual([p for p in HIGHLIGHT_PATTERNS if p != p.lower() or "/" in p], [])
        self.assertEqual(len(set(HIGHLIGHT_PATTERNS)), len(HIGHLIGHT_PATTERNS))
        self.assertNotIn("skills", HIGHLIGHT_PATTERNS)
        self.assertTrue({"skill.md", ".claude", ".claude-plugin"} <= set(HIGHLIGHT_PATTERNS))
        self.assertEqual(highlight_sha256(), "a0b78ed86b8a7fa25451a757db477ee0d1d372f219af8dd1fc0c14dcd577d304")

    def test_the_page_saves_the_pattern_list_sha256_with_the_labels_it_downloads(self):
        from study_calibration_set import highlight_sha256
        self.assertIn(f'data-highlight="{highlight_sha256()}"', re.search(r"<body [^>]*>", self.page).group(0))
        self.assertIn("JSON.stringify({ sweep: SWEEP, batch: BATCH, set_sha256: SET, highlight_sha256: document.body.dataset.highlight, labels }, null, 1)", self.page)

    def test_the_import_keeps_a_valid_pattern_list_sha256_and_refuses_a_malformed_one(self):
        from study_calibration_set import highlight_sha256
        labels = user_labels(self.sample)
        work = Path(tempfile.mkdtemp(prefix="study-labels-work-"))
        self.addCleanup(shutil.rmtree, work)
        shutil.copytree(self.work, work, dirs_exist_ok=True)
        self.frozen(work)
        for bad in ("A" * 64, "0" * 63, 7, None):
            with self.assertRaisesRegex(SystemExit, r"highlight_sha256 .* is not a sha256 of 64 lowercase hex characters"):
                self.importing(self.labels_file(labels, extra={"highlight_sha256": bad}), work)
        for sha in (highlight_sha256(), "0" * 64):
            self.importing(self.labels_file(labels, extra={"highlight_sha256": sha}), work)
            self.assertEqual(json.loads((work / "calibration-labels.json").read_text())["highlight_sha256"], sha)
        self.importing(self.labels_file(labels), work)
        self.assertNotIn("highlight_sha256", json.loads((work / "calibration-labels.json").read_text()))
        from study_calibration_set import labelled
        kept = json.loads((work / "calibration-labels.json").read_text())
        (work / "calibration-labels.json").write_text(json.dumps({**kept, "highlight_sha256": "x"}))
        with self.assertRaisesRegex(TopicError, r"calibration-labels.json holds highlight_sha256 'x', not a sha256 of 64 lowercase hex characters"):
            labelled(work)

    def test_the_page_header_states_the_pattern_list_sha256_and_that_a_highlight_is_no_verdict(self):
        from study_calibration_set import highlight_sha256
        header = self.page[self.page.index("<header>"):self.page.index("</header>")]
        sha = highlight_sha256()
        self.assertIn(f"Tô sáng theo một danh sách mẫu đường dẫn cố định (không dùng AI), sha256 {sha}; tô sáng không phải là kết luận, và không có tô sáng không có nghĩa là "
                      "không có cơ chế.", header)
        self.assertIn(f"Highlighted by a fixed path pattern list (no AI), sha256 {sha}; a highlight is not a verdict, and missing highlights do not mean no mechanism.", header)

    def test_the_pattern_list_leaves_the_set_the_draw_and_the_saved_progress_key_unchanged(self):
        from unittest import mock
        set_sha = hashlib.sha256((self.work / "calibration-set.json").read_bytes()).hexdigest()

        def key_parts(page):
            return re.search(r'<body data-set="([0-9a-f]{64})"', page).group(1), re.search(r"^  const SET = .*KEY = (.*);$", page, re.M).group(1)

        self.assertEqual(key_parts(self.page), (set_sha, '"calibration:" + SET'))
        for patterns in ((), ("src",)):
            with mock.patch("study_calibration_set.HIGHLIGHT_PATTERNS", patterns):
                _, work = drawn_work()
            for name in ("calibration-set.json", "calibration-draw.json"):
                self.assertEqual((work / name).read_bytes(), (self.work / name).read_bytes())
            page = (work / "calibration.html").read_text()
            self.assertNotEqual(page, self.page)
            self.assertEqual(key_parts(page), key_parts(self.page))

    def copied_work(self):
        work = Path(tempfile.mkdtemp(prefix="study-rebuild-"))
        self.addCleanup(shutil.rmtree, work, ignore_errors=True)
        shutil.copytree(self.work, work, dirs_exist_ok=True)
        return work

    def test_rebuild_page_writes_only_the_page_from_the_drawn_set_and_its_pinned_inputs(self):
        work = self.copied_work()
        (work / "calibration.html").write_text("stale page")
        before = {p.relative_to(work): p.read_bytes() for p in work.rglob("*") if p.is_file() and p.name != "calibration.html"}
        draw(self.repo, work, "--rebuild-page")
        self.assertEqual({p.relative_to(work): p.read_bytes() for p in work.rglob("*") if p.is_file() and p.name != "calibration.html"}, before)
        self.assertEqual((work / "calibration.html").read_text(), self.page)

    def test_rebuild_page_refuses_a_set_without_its_draw_other_inputs_other_criteria_or_another_sweep(self):
        work = self.copied_work()
        with self.assertRaisesRegex(SystemExit, r"no top-up-set.json in .*; a page is rebuilt only for a drawn batch"):
            draw(self.repo, work, "--rebuild-page", "top-up")
        with self.assertRaisesRegex(SystemExit, "--rebuild-page rewrites the page of a drawn batch; it takes no --top-up"):
            draw(self.repo, work, "--rebuild-page", "--top-up", "30")
        drawn = (work / "calibration-draw.json").read_text()
        write_json(work / "calibration-draw.json", {**json.loads(drawn), "set_sha256": "0" * 64})
        with self.assertRaisesRegex(SystemExit, "calibration-draw.json was written for another calibration set; the draw records the hash of the set it wrote"):
            draw(self.repo, work, "--rebuild-page")
        (work / "calibration-draw.json").write_text(drawn)
        name = "config-screening-inputs.jsonl"
        inputs = (work / name).read_text()
        first = next(r for r in self.sample["rows"] if r["stratum"] == "config")
        rows = [json.loads(line) for line in inputs.splitlines()]
        write_jsonl(work / name, [{**r, "readme": "changed"} if r["order_rank"] == first["order_rank"] else r for r in rows])
        with self.assertRaisesRegex(SystemExit, rf"{first['id']}: {name} no longer holds the inputs the set pinned for rank {first['order_rank']}"):
            draw(self.repo, work, "--rebuild-page")
        (work / name).write_text(inputs)
        repo = v4_repo()
        (repo / CRITERIA).write_text((repo / CRITERIA).read_text() + "\nchanged\n")
        with self.assertRaisesRegex(SystemExit, f"{CRITERIA} is not the criteria file calibration-set.json was drawn under"):
            draw(repo, work, "--rebuild-page")
        path = repo / "docs/prior-art/topics/demo.json"
        write_json(path, {**json.loads(path.read_text()), "sweep": "261021-demo"})
        with self.assertRaisesRegex(SystemExit, "calibration-set.json belongs to sweep 261020-demo, not 261021-demo"):
            draw(repo, work, "--rebuild-page")
        self.assertEqual((work / "calibration.html").read_text(), self.page)

    def test_the_topic_validator_accepts_an_eligibility_definition_only_as_vietnamese_and_english_texts(self):
        repo = v4_repo()
        path = repo / "docs/prior-art/topics/demo.json"
        topic = json.loads(path.read_text())
        write_json(path, {**topic, "eligibility": ELIGIBILITY})
        self.assertEqual(load_topic(repo, "demo:alpha")["eligibility"], ELIGIBILITY)
        for bad in ("text", {"vi": "x"}, {"vi": "x", "en": ""}, {"vi": "x", "en": "y", "note": "z"}, {"vi": 1, "en": "y"}):
            write_json(path, {**topic, "eligibility": bad})
            with self.assertRaisesRegex(TopicError, "eligibility must hold exactly vi and en, each a non-empty string"):
                load_topic(repo, "demo")

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

    def test_the_top_up_trigger_is_recorded_at_the_draw_and_an_untriggered_top_up_is_refused(self):
        from study_calibration_set import calibration_checks
        from study_topic import TopicError, load_topic
        work = self.fresh()
        labels = user_labels(drawn_and_labelled(self.repo, work))
        few = {k: v if n < 40 or v["decision"] != "eligible" else {**v, "decision": "excluded: below-threshold"} for n, (k, v) in enumerate(labels.items())}
        quiet(self.repo, "import-calibration-labels", "--work", str(work), "--labels", str(self.labels_into(work, few)))
        top = drawn_and_labelled(self.repo, work, top_up=30)
        self.assertEqual(top["trigger"], {"positives": self.positives(few),
                                          "labels_sha256": {"calibration": hashlib.sha256((work / "calibration-labels.json").read_bytes()).hexdigest()}})
        calibration_checks(load_topic(self.repo, "demo"), work)
        quiet(self.repo, "import-calibration-labels", "--work", str(work), "--labels", str(self.labels_into(work, labels)))
        with self.assertRaisesRegex(TopicError, r"^top-up-set.json was drawn when no trigger held: no top-up trigger fired: the labels hold \d+ positives pooled \(at least 59\)"):
            calibration_checks(load_topic(self.repo, "demo"), work)

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
        self.assertEqual((held["trigger"]["rung"], set(held["trigger"]["labels_sha256"])), (3, {"calibration"}))
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
