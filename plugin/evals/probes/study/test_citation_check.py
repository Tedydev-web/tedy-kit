import contextlib
import hashlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from study_agreement import upper_bound
from study_citation_check import drawn, file_head
from study_fixtures import FakeFetch, script, write_json
from study_reference_freeze import require_frozen
from study_topic import TopicError, load_topic
from study_v4_fixture import SECRET, SWEEP, TODAY, quiet
from test_reference_freeze import SKILL_TEXT, GEMINI, GPT_OSS, referenced_work

REGISTRY = "".join(f"| {p} | statement of problem {p} |\n" for p in ("X1", "X2", "X3", "X4"))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_key(row_id):
    return hashlib.sha256(f"{SWEEP}:verify:{row_id}".encode()).hexdigest()


class CitationCheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo, cls.work, cls.sample = referenced_work()
        (cls.repo / "docs/prior-art/problems-demo.md").write_text("# Problems\n\n| Id | Statement |\n|---|---|\n" + REGISTRY)
        quiet(cls.repo, "freeze-reference", "--work", str(cls.work), "--batch", "calibration", "--without-flaggers", "agy quota", "--today", TODAY)
        cls.labels = json.loads((cls.work / "calibration-labels.json").read_text())

    def copies(self):
        base = Path(tempfile.mkdtemp(prefix="study-citation-check-"))
        self.addCleanup(shutil.rmtree, base)
        repo, work = base / "repo", base / "work"
        shutil.copytree(self.repo, repo)
        shutil.copytree(self.work, work)
        return repo, work

    def run_script(self, name, repo, work, *extra, fetch=None):
        kwargs = {"fetch": fetch} if fetch is not None else {}
        with contextlib.redirect_stdout(io.StringIO()) as out:
            script(name).main(["--topic", "demo", "--repo", str(repo), "--work", str(work), *extra], **kwargs)
        return out.getvalue()

    def draw(self, repo, work):
        self.run_script("draw-citation-check", repo, work, fetch=FakeFetch())
        return (work / "citation-check.html").read_text()

    def ids(self):
        return drawn(SWEEP, self.labels["rows"])

    def answers(self, work, unsupported=(), **change):
        answers = {r["id"]: ("yes" if r["kind"] == "relevance-1" else "no") for r in self.ids()}
        for row in self.ids():
            if row["id"] in unsupported:
                answers[row["id"]] = "no" if row["kind"] == "relevance-1" else "yes"
        saved = {"sweep": SWEEP, "set_sha256": sha(work / "calibration-set.json"), "freeze_sha256": sha(work / "reference-freeze-calibration.json"), "answers": answers,
                 **change}
        path = work / "saved-citation-check.json"
        path.write_text(json.dumps(saved))
        return path

    def imported(self, repo, work, path):
        return self.run_script("import-citation-check", repo, work, "--answers", str(path))

    def refused(self, repo, work, path, text):
        with self.assertRaises(SystemExit) as caught:
            self.imported(repo, work, path)
        self.assertIn(text, str(caught.exception))

    def test_the_draw_is_stable_and_takes_per_stratum_ten_relevance_one_and_five_relevance_zero_rows_by_the_lowest_verify_hash(self):
        rows = self.ids()
        self.assertEqual(rows, drawn(SWEEP, list(reversed(self.labels["rows"]))))
        self.assertEqual(len(rows), 30)
        for stratum in ("config", "product"):
            for kind, value, count in (("relevance-1", 1, 10), ("relevance-0", 0, 5)):
                pool = sorted((r["id"] for r in self.labels["rows"] if r["stratum"] == stratum and r["user"]["Relevance"] == value), key=verify_key)
                self.assertEqual([r["id"] for r in rows if r["stratum"] == stratum and r["kind"] == kind], pool[:count])

    def test_a_short_stratum_gives_all_its_rows_and_relevance_one_half_is_in_no_group(self):
        rows = [{"id": f"calibration-config-{i}", "stratum": "config", "order_rank": i, "user": {"Relevance": v}} for i, v in enumerate((1, 1, 1, 0, 0.5, 0.5), 1)]
        picked = drawn(SWEEP, rows)
        self.assertEqual(sorted((r["kind"], r["id"]) for r in picked),
                         [("relevance-0", "calibration-config-4")] + [("relevance-1", f"calibration-config-{i}") for i in (1, 2, 3)])

    def test_the_page_shows_the_cited_files_the_anchor_and_the_problems_but_no_judge_or_session_answer(self):
        repo, work = self.copies()
        page = self.draw(repo, work)
        self.assertIn("<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'\">", page)
        self.assertIn('<html lang="vi">', page)
        self.assertEqual(page.count('<section class="row"'), 30)
        self.assertIn(f'data-freeze="{sha(work / "reference-freeze-calibration.json")}"', page)
        self.assertIn('"citation-check:" + FREEZE', page)
        self.assertIn("localStorage", page)
        self.assertIn('id="download"', page)
        self.assertIn(SKILL_TEXT.splitlines()[1], page)
        self.assertIn("statement of problem X1", page)
        self.assertIn("Relevance = 1", page)
        self.assertIn("Có tệp nào trong số này mang cơ chế cho một vấn đề được liệt kê không?", page)
        for leaked in ("a red test gates the commit", SECRET, "&quot;scores&quot;", '"scores"', "&quot;decision&quot;", '"decision"', "excluded", "Authority", "Methodology", GEMINI, GPT_OSS,
                       "claude-fable-5-1", "claude-opus-5-5", "readme:It guards"):
            self.assertNotIn(leaked, page)

    def test_a_cited_path_outside_the_read_files_is_read_once_at_the_pinned_commit(self):
        packet = {"repo": "o/demo", "sha": "e" * 40, "assets": [{"path": "skills/tdd/SKILL.md", "text": SKILL_TEXT}]}
        self.assertEqual(file_head(FakeFetch(), packet, "skills/tdd/SKILL.md"), SKILL_TEXT)
        fetch = FakeFetch([("contents/tests/hook.test.ts?ref=" + "e" * 40, "".join(f"line {i}\n" for i in range(1, 61)))])
        head = file_head(fetch, packet, "tests/hook.test.ts")
        self.assertEqual((head.splitlines()[-1], len(head.splitlines()), len(fetch.called("gh api"))), ("line 40", 40, 1))
        self.assertIn("không đọc được", file_head(FakeFetch([("contents/", ("", "exit 1: 404"))]), packet, "gone.md"))

    def test_one_unsupported_row_of_thirty_passes_and_the_runners_may_read_the_batch(self):
        repo, work = self.copies()
        first = self.ids()[0]["id"]
        self.imported(repo, work, self.answers(work, unsupported=[first]))
        check = json.loads((work / "citation-check.json").read_text())
        self.assertEqual((check["freeze_sha256"], check["n"], check["unsupported"], check["stopped"]), (sha(work / "reference-freeze-calibration.json"), 30, 1, False))
        self.assertEqual(round(check["upper_one_sided"], 3), 0.149)
        self.assertEqual(len(check["interval_two_sided"]), 2)
        self.assertEqual([r["id"] for r in check["rows"] if r["unsupported"]], [first])
        self.assertEqual(set(check["rows"][0]), {"id", "kind", "answer", "unsupported"})
        self.assertEqual(require_frozen(load_topic(repo, "demo"), work, ("calibration",)), {"calibration": sha(work / "reference-freeze-calibration.json")})

    def test_two_unsupported_rows_stop_the_method_and_the_runners_refuse(self):
        repo, work = self.copies()
        positive = next(r["id"] for r in self.ids() if r["kind"] == "relevance-1")
        negative = next(r["id"] for r in self.ids() if r["kind"] == "relevance-0")
        self.refused(repo, work, self.answers(work, unsupported=[positive, negative]), "method stopped: next step is the user's")
        check = json.loads((work / "citation-check.json").read_text())
        self.assertEqual((check["unsupported"], check["stopped"], round(check["upper_one_sided"], 3)), (2, True, 0.195))
        with self.assertRaisesRegex(TopicError, "citation-check.json stopped the method: 2 of 30 rows unsupported"):
            require_frozen(load_topic(repo, "demo"), work, ("calibration",))
        write_json(work / "citation-check.json", {**check, "stopped": False})
        with self.assertRaisesRegex(TopicError, "stopped the method"):
            require_frozen(load_topic(repo, "demo"), work, ("calibration",))

    def test_a_calibration_batch_without_a_check_is_refused(self):
        repo, work = self.copies()
        with self.assertRaisesRegex(TopicError, "no citation-check.json in .*; the user checks 30 reference citations"):
            require_frozen(load_topic(repo, "demo"), work, ("calibration",))

    def test_an_import_for_another_freeze_set_or_row_list_is_refused(self):
        repo, work = self.copies()
        self.refused(repo, work, self.answers(work, freeze_sha256="f" * 64), "was saved for another freeze")
        self.refused(repo, work, self.answers(work, set_sha256="f" * 64), "was saved for another freeze")
        answers = json.loads(self.answers(work).read_text())["answers"]
        dropped = dict(list(answers.items())[1:])
        self.refused(repo, work, self.answers(work, answers=dropped), "answers rows other than the 30 the seed draws")
        self.refused(repo, work, self.answers(work, answers={**answers, "calibration-config-999": "yes"}), "answers rows other than the 30 the seed draws")
        self.refused(repo, work, self.answers(work, answers={**answers, next(iter(answers)): "maybe"}), "is yes or no")
        self.assertFalse((work / "citation-check.json").exists())

    def test_a_check_is_imported_once(self):
        repo, work = self.copies()
        self.imported(repo, work, self.answers(work))
        self.refused(repo, work, self.answers(work), "citation-check.json already exists")

    def test_the_one_sided_upper_bounds_at_zero_one_and_two_of_thirty(self):
        self.assertEqual([round(upper_bound(k, 30), 3) for k in (0, 1, 2)], [0.095, 0.149, 0.195])


if __name__ == "__main__":
    unittest.main()
