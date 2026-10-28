import hashlib
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from study_fixtures import write_json
from study_stopped_record import deep_picks, render_stopped
from study_topic import TopicError

SWEEP = "261001-demo"
CRITERIA = "docs/prior-art/quality-criteria-v4.md"


def label(n, stratum, repo, problems, quality=(1, 1, 1, 1), decision="eligible"):
    a, m, o, p = quality
    return {"id": f"calibration-{stratum}-{n}", "stratum": stratum, "order_rank": n, "repo": repo,
            "user": {"Authority": a, "Methodology": m, "Objectivity": o, "Position": p, "Relevance": 1 if problems else 0, "problems": problems, "decision": decision}}


ROWS = [label(1, "config", "o/known", ["S1", "S2"], (1, 1, 0.5, 0.5)),
        label(2, "config", "o/kitchen", ["S1", "S2", "S3", "S4"], (1, 1, 1, 0.5)),
        label(3, "product", "o/small", ["S3"], (1, 1, 1, 1)),
        label(4, "product", "o/weak", ["S4"], (0.5, 0.5, 0.5, 0.5)),
        label(5, "config", "o/none", [], (0, 0, 0, 0), "excluded: irrelevant")]
STARS = {1: 5000, 2: 3, 3: 10, 4: 900, 5: 1}


class StoppedRecordTest(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp(prefix="study-stopped-"))
        self.addCleanup(shutil.rmtree, self.repo)
        (self.repo / "docs/prior-art").mkdir(parents=True)
        (self.repo / CRITERIA).write_text("criteria v4: a topic sweep may stop at the scale checkpoint\n")
        write_json(self.repo / "docs/prior-art/topics/demo.json", {"sweep": SWEEP, "terms": ["x"], "strata": {}})
        self.folder = self.repo / "docs/prior-art/sweeps" / SWEEP
        write_json(self.folder / "meta.json", {"title": "Sweep demo", "role": "demo", "date": "2026-10-01", "criteria": CRITERIA, "inventory_digest": "0" * 16,
                                               "problems": ["S1", "S2", "S3", "S4"]})
        write_json(self.folder / "calibration-set.json", {"batch": "calibration", "rows": [{k: r[k] for k in ("id", "stratum", "order_rank", "repo")} for r in ROWS]})
        write_json(self.folder / "calibration-labels.json", {"batch": "calibration", "rows": ROWS})
        self.freeze()
        write_json(self.folder / "deep-study.json", {
            "rows": [{"batch": "calibration", "stratum": r["stratum"], "rank": r["order_rank"], "repo": r["repo"], "commit": f"https://github.com/{r['repo']}/commit/{'c' * 40}",
                      "stars": STARS[r["order_rank"]]} for r in ROWS],
            "supplement": [{"repo": "o/extra", "stratum": "product", "commit": f"https://github.com/o/extra/commit/{'d' * 40}", "problems": ["S4"],
                            "reason": "known guard outside the drawn rows; eligible against the v4 anchors at file:line in its card"}]})
        write_json(self.folder / "stop.json", {"date": "2026-10-28", "decision": "the user chose deep reading of the reference-eligible sources",
                                               "threats": ["stage 1 uncertified at every rung"]})
        write_json(self.folder / "surface-map.json", {"considered": {"PreToolUse": ["o/known guard"]}, "not relevant": {"Stop": "no picked mechanism acts there"}})

    def freeze(self):
        sha = lambda name: hashlib.sha256((self.folder / name).read_bytes()).hexdigest()
        write_json(self.folder / "reference-freeze-calibration.json", {"batch": "calibration", "set_sha256": sha("calibration-set.json"),
                                                                       "labels_sha256": sha("calibration-labels.json")})

    def render(self):
        return render_stopped(self.repo, {"name": "demo", "sweep": SWEEP})[0]

    def test_picks_take_known_and_sound_sources_first_then_fill_coverage_from_strong_ones(self):
        picks = deep_picks([{"repo": r["repo"], "stars": STARS[r["order_rank"]], **r["user"]} for r in ROWS if r["user"]["decision"] == "eligible"])
        self.assertEqual([(p["repo"], p["pass"], p["adds"]) for p in picks], [("o/known", 1, ["S1", "S2"]), ("o/kitchen", 2, ["S1", "S2", "S3", "S4"]),
                                                                              ("o/small", 2, ["S3"])])

    def test_the_record_states_the_stop_the_picks_the_supplement_and_every_drawn_row(self):
        text = self.render()
        self.assertIn("- Status: stopped at the scale checkpoint on 2026-10-28: the user chose deep reading of the reference-eligible sources", text)
        self.assertIn(f"- Criteria: {CRITERIA} sha256[:16] `{hashlib.sha256((self.repo / CRITERIA).read_bytes()).hexdigest()[:16]}`", text)
        self.assertIn("| 1 | o/known | https://github.com/o/known/commit/" + "c" * 40 + " | A1 M1 O0.5 P0.5 R1 | study | S1, S2 | pass 1: adds S1, S2 |", text)
        self.assertIn("| 4 | o/weak | https://github.com/o/weak/commit/" + "c" * 40 + " | A0.5 M0.5 O0.5 P0.5 R1 | eligible | S4 | reference-eligible; adds no problem held by fewer than 2 picks |", text)
        self.assertIn("| 5 | o/none | https://github.com/o/none/commit/" + "c" * 40 + " | A0 M0 O0 P0 R0 | excluded: irrelevant | - | reference label, frozen in reference-freeze-calibration.json |", text)
        self.assertIn("| supplement | o/extra | https://github.com/o/extra/commit/" + "d" * 40 + " | - | study | S4 | supplement, not reference-labelled: known guard outside", text)
        self.assertIn("stop: stopped at the scale checkpoint on 2026-10-28; 3 drawn rows labelled by the reference, 2 eligible, 2 studied", text)
        self.assertIn("- problems held by 2 or more studied sources: S1, S2, S3, S4; by one: none; by none: none", text)
        self.assertIn("- considered: PreToolUse: o/known guard", text)
        self.assertIn("- not relevant: Stop: no picked mechanism acts there", text)
        self.assertIn("- stage 1 uncertified at every rung", text)
        self.assertEqual(text, self.render())

    def test_labels_changed_after_their_freeze_are_refused(self):
        rows = json.loads((self.folder / "calibration-labels.json").read_text())
        rows["rows"][3]["user"]["Authority"] = 1
        write_json(self.folder / "calibration-labels.json", rows)
        with self.assertRaisesRegex(TopicError, "calibration-labels.json is not the file reference-freeze-calibration.json froze"):
            self.render()

    def test_a_stop_without_the_criteria_row_or_a_supplement_without_a_reason_is_refused(self):
        study = json.loads((self.folder / "deep-study.json").read_text())
        study["supplement"][0]["reason"] = " "
        write_json(self.folder / "deep-study.json", study)
        with self.assertRaisesRegex(TopicError, "supplement o/extra needs a reason"):
            self.render()
        (self.repo / CRITERIA).write_text("criteria v4\n")
        with self.assertRaisesRegex(TopicError, "names no stop at the scale checkpoint"):
            self.render()

    def test_stop_sweep_copies_the_frozen_batches_and_writes_the_rows_with_their_pinned_commits(self):
        from study_fixtures import script, write_jsonl
        work = Path(tempfile.mkdtemp(prefix="study-stop-work-"))
        self.addCleanup(shutil.rmtree, work)
        for name in ("calibration-set.json", "calibration-labels.json", "reference-freeze-calibration.json"):
            shutil.copyfile(self.folder / name, work / name)
        for stratum in ("config", "product"):
            write_jsonl(work / f"reference-inputs-{stratum}.jsonl", [{"order_rank": r["order_rank"], "repo": r["repo"], "sha": "e" * 40, "facts": {"stars": STARS[r["order_rank"]]}}
                                                                    for r in ROWS if r["stratum"] == stratum])
        (self.repo / "docs/prior-art/claude-code-surfaces.md").write_text("- llms.txt: sha256[:16] of the sorted unique list: `abcdef0123456789`\n")
        topic = {"name": "demo", "sweep": "261002-demo", "problems": ["S1", "S2", "S3", "S4"]}
        folder, batches = script("stop-sweep").stop(topic, self.repo, work, "Sweep demo", CRITERIA, "deep reading", [], ["threat"], "2026-10-28")
        study = json.loads((folder / "deep-study.json").read_text())
        self.assertEqual((batches, study["rows"][0]["commit"], study["rows"][0]["stars"]), (["calibration"], "https://github.com/o/known/commit/" + "e" * 40, 5000))
        self.assertEqual(json.loads((folder / "meta.json").read_text())["inventory_digest"], "abcdef0123456789")
        with self.assertRaisesRegex(TopicError, "supplement o/x must hold exactly"):
            script("stop-sweep").stop(topic, self.repo, work, "t", CRITERIA, "d", [{"repo": "o/x", "reason": "r"}], [], "2026-10-28")

    def test_the_record_renderer_takes_the_stopped_branch(self):
        from study_sweep_record import render
        self.assertEqual(render(self.repo, {"name": "demo", "sweep": SWEEP})[0], self.render())


if __name__ == "__main__":
    unittest.main()
