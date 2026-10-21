import contextlib
import hashlib
import io
import json
import unittest

import test_reference_labels as base
from study_calibration_set import pinned_inputs
from study_fixtures import script, write_json, write_jsonl
from study_protocol import FREEZE_FILE
from study_reference_labels import checked_notes, row_label
from study_reference_packet import bundle_text
from study_rubric_worksheet import rubric_rows, write_worksheet
from study_topic import TopicError, load_topic
from study_v4_fixture import CRITERIA, PROBLEMS, TODAY, quiet
from test_calibration_set import drawn_work

TRIGGER, RECORD_ONLY = "gemini-3.8-flash-high", "gpt-oss-120b-medium"
PAID = "fact:prefilled.paid_tier_cues"
FORKED = "readme:Forked from upstream/demo."
GHOST = "path:skills/ghost/SKILL.md"
NAMES = ("Authority", "Methodology", "Objectivity", "Position", "Relevance")


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


class RubricRowsTest(unittest.TestCase):
    def test_the_flags_file_is_read_through_its_rubric_rows_only(self):
        flags = {"flaggers": {TRIGGER: {"role": "rubric_trigger"}}, "rubric_rows": [{"id": "calibration-config-1", "stratum": "config", "order_rank": 4,
                                                                                     "criteria": ["Objectivity", "problems", "Objectivity"], "fields": "kept apart"}]}
        self.assertEqual(rubric_rows(flags), [{"id": "calibration-config-1", "stratum": "config", "order_rank": 4, "criteria": ["Objectivity", "problems"]}])

    def test_a_malformed_rubric_row_is_refused(self):
        for flags in ({}, {"rubric_rows": {}}, {"rubric_rows": [{"id": "x", "stratum": "config", "order_rank": 1}]},
                      {"rubric_rows": [{"id": "x", "stratum": "config", "order_rank": 1, "criteria": []}]},
                      {"rubric_rows": [{"id": "x", "stratum": "config", "order_rank": 1, "criteria": ["Date"]}]}):
            with self.assertRaisesRegex(TopicError, "rubric_rows"):
                rubric_rows(flags)


class DecisionNoteTest(unittest.TestCase):
    def test_a_decision_note_passes_the_note_check(self):
        lines = ["# criteria", "**Aggregators.** An aggregator is a list."]
        checked_notes([{"line": 2, "quote": lines[1], "criterion": "decision", "cue": "objectivity:pricing"}], lines, [])

    def test_a_decision_rerun_replaces_the_decision_and_its_cite(self):
        rerun = base.reply(decision="excluded: copy", decision_cite=FORKED)
        label, record = row_label("row", base.reply(), {"decision": ("reference-calibration-config-notes-1", rerun)}, base.packet(), 0)
        self.assertEqual((label["decision"], record["cites"]["decision"], record["rerun"]), ("excluded: copy", FORKED, {"decision": "reference-calibration-config-notes-1"}))
        label, record = row_label("row", base.reply(decision="excluded: copy", decision_cite=FORKED), {"decision": ("k", base.reply())}, base.packet(), 0)
        self.assertEqual(label["decision"], "eligible")
        self.assertNotIn("decision", record["cites"])


class WorksheetTest(unittest.TestCase):
    copies = base.ReferenceLabelsTest.copies
    session = base.ReferenceLabelsTest.session
    row_reply = base.ReferenceLabelsTest.row_reply

    @classmethod
    def setUpClass(cls):
        cls.repo, cls.work = drawn_work()
        quiet(cls.repo, "freeze-stage1", "--work", str(cls.work), "--today", TODAY)
        registry = "| Id | Problem | Area |\n|---|---|---|\n" + "".join(f"| {p} | statement of {p} | area |\n" for p in PROBLEMS)
        (cls.repo / "docs/prior-art/problems-demo.md").write_text(registry)
        topic = cls.repo / "docs/prior-art/topics/demo.json"
        write_json(topic, {**json.loads(topic.read_text()), "reference": base.REFERENCE, "eligibility": {"vi": "-", "en": "The judges' question."}})
        cls.sample = json.loads((cls.work / "calibration-set.json").read_text())
        cls.held = pinned_inputs(cls.work, cls.sample)
        cls.rows = cls.sample["rows"]

    def referenced(self, work, paid=()):
        self.packets = {}
        for stratum in ("config", "product"):
            rows = [(n, r) for n, r in enumerate(self.rows) if r["stratum"] == stratum]
            packets = {}
            for n, r in rows:
                packet = {**base.packet(r["order_rank"], r["repo"]), "facts": self.held[r["id"]].get("facts", {})}
                packet["prefilled"] = {**packet["prefilled"], "paid_tier_cues": ["3: A paid hosted tier."] if n in paid else []}
                packets[r["order_rank"]] = packet
            write_jsonl(work / f"reference-inputs-{stratum}.jsonl", list(packets.values()))
            self.session(work, f"reference-calibration-{stratum}", [self.row_reply(n, r) for n, r in rows], packets)
            self.packets[stratum] = packets

    def differing(self, n, scores=None, mechanisms=None, **change):
        row = self.row_reply(n, self.rows[n], **change)
        if mechanisms is not None:
            row["mechanisms"] = [dict(m) for m in mechanisms]
        for name, (value, cite) in (scores or {}).items():
            row["scores"][name] = {"v": value, "cite": cite}
        return row

    def flagged(self, work, flagger, rubric, model=TRIGGER):
        for stratum in ("config", "product"):
            made = [flagger.get(n) or self.row_reply(n, r) for n, r in enumerate(self.rows) if r["stratum"] == stratum]
            write_jsonl(work / f"reference-calibration-{stratum}-flagger-{model}.jsonl", made)
        rows = [{"id": self.rows[n]["id"], "stratum": self.rows[n]["stratum"], "order_rank": self.rows[n]["order_rank"], "criteria": criteria} for n, criteria in rubric]
        write_json(work / "reference-flags-calibration.json", {"rubric_rows": rows})

    def worksheet(self, repo, work):
        return write_worksheet(load_topic(repo, "demo"), repo, work, "calibration", CRITERIA)

    def refused(self, repo, work, text):
        with self.assertRaises(TopicError) as caught:
            self.worksheet(repo, work)
        self.assertIn(text, str(caught.exception))

    def line(self, repo, start, section=True):
        lines = (repo / CRITERIA).read_text().splitlines()
        begin = next(i for i, text in enumerate(lines) if text.startswith("## GitHub assets")) if section else 0
        number = next(i for i, text in enumerate(lines[begin:], begin + 1) if text.startswith(start))
        return number, lines[number - 1]

    def objectivity_split(self, repo, work):
        self.referenced(work)
        zero = {"Objectivity": (0, FORKED)}
        self.flagged(work, {0: self.differing(0, zero), 2: self.differing(2, zero), 4: self.differing(4, {"Methodology": (0, FORKED)})},
                     [(0, ["Objectivity"]), (2, ["Objectivity"]), (4, ["Methodology"])])

    def test_flagged_rows_group_by_criterion_and_the_two_anchor_readings(self):
        repo, work = self.copies()
        self.referenced(work)
        zero = {"Objectivity": (0, FORKED)}
        flagger = {0: self.differing(0, zero), 2: self.differing(2, zero), 4: self.differing(4, {"Methodology": (0, FORKED)}),
                   61: self.differing(61, {"Relevance": (1, base.SKILL)}, mechanisms=(base.GATE,)), 6: self.differing(6, {"Position": (0, FORKED)})}
        self.flagged(work, flagger, [(0, ["Objectivity"]), (2, ["Objectivity"]), (4, ["Methodology"]), (61, ["Relevance", "problems"])])
        sheet = self.worksheet(repo, work)
        self.assertEqual([(q["id"], q["rows"]) for q in sheet["questions"]],
                         [("Objectivity-1-0", [self.rows[0]["id"], self.rows[2]["id"]]), ("Methodology-1-0", [self.rows[4]["id"]]), ("Relevance-0-1", [self.rows[61]["id"]])])
        first = sheet["questions"][0]
        number, text = self.line(repo, "| Objectivity |")
        example = min((self.rows[0], self.rows[2]), key=lambda r: r["order_rank"])
        self.assertEqual((first["line"], first["quote"], first["example"]), (number, text, example["id"]))
        self.assertEqual(first["readings"]["A"], {"by": "reference", "value": 1, "anchor": text.split(" | ")[1], "reasons": [base.SKILL]})
        self.assertEqual(first["readings"]["B"], {"by": TRIGGER, "value": 0, "anchor": text.split(" | ")[3][:-2], "reasons": [FORKED]})
        relevance = sheet["questions"][2]["readings"]["B"]
        self.assertEqual(relevance["reasons"], [base.SKILL, "X1 at skills/tdd/SKILL.md: a red test gates the commit"])
        self.assertEqual(first["recommended"], "A")
        self.assertEqual(sheet["rules"], [])
        page = (work / "rubric-questions-calibration.md").read_text()
        self.assertNotIn(self.rows[6]["id"], page)
        for part in ("`Objectivity-1-0`", "`Methodology-1-0`", "`Relevance-0-1`", text, FORKED, "Recommended: A", "a red test gates the commit"):
            self.assertIn(part, page)
        self.assertIn(f"anchors_sha256 now: {sha(bundle_text(repo, load_topic(repo, 'demo'), CRITERIA))}", page)
        self.assertIn(f"criteria_sha256 now: {hashlib.sha256((repo / CRITERIA).read_bytes()).hexdigest()}", page)
        self.assertFalse((work / "rubric-outcomes-calibration.json").exists())

    def test_the_reference_cite_failing_on_the_example_recommends_the_flagger_reading(self):
        repo, work = self.copies()
        self.referenced(work)
        rows = [self.row_reply(n, r) for n, r in enumerate(self.rows) if r["stratum"] == "config"]
        rows[0]["scores"]["Objectivity"]["cite"] = GHOST
        self.session(work, "reference-calibration-config", rows, self.packets["config"])
        self.flagged(work, {0: self.differing(0, {"Objectivity": (0, FORKED)})}, [(0, ["Objectivity"])])
        self.assertEqual(self.worksheet(repo, work)["questions"][0]["recommended"], "B")

    def test_only_rubric_trigger_flaggers_are_read(self):
        repo, work = self.copies()
        self.referenced(work)
        self.flagged(work, {0: self.differing(0, {"Objectivity": (0, FORKED)})}, [(0, ["Objectivity"])], model=RECORD_ONLY)
        self.refused(repo, work, "no rubric-trigger flagger differs")

    def test_a_paid_tier_objectivity_row_is_applied_by_rule_and_reruns_every_row_its_cue_selects(self):
        repo, work = self.copies()
        self.referenced(work, paid=(0, 8, 64))
        self.flagged(work, {0: self.differing(0, {"Objectivity": (0, FORKED)}), 2: self.differing(2, {"Objectivity": (0, FORKED)})},
                     [(0, ["Objectivity"]), (2, ["Objectivity"])])
        sheet = self.worksheet(repo, work)
        number, text = self.line(repo, "| Objectivity |")
        self.assertIn("a hosted cloud or a paid tier", text)
        self.assertEqual(sheet["rules"], [{"criterion": "Objectivity", "rows": [self.rows[0]["id"]], "note": {"line": number, "quote": text, "criterion": "Objectivity", "cue": PAID},
                                           "rerun": sorted(self.rows[n]["id"] for n in (0, 8, 64)), "notes": []}])
        self.assertEqual([(q["id"], q["rows"]) for q in sheet["questions"]], [("Objectivity-1-0", [self.rows[2]["id"]])])

    def test_the_worksheet_is_refused_after_the_protocol_freeze(self):
        repo, work = self.copies()
        self.objectivity_split(repo, work)
        write_json(work / FREEZE_FILE, {})
        self.refused(repo, work, "protocol freeze")
        self.assertFalse((work / "rubric-questions-calibration.md").exists())

    def test_the_worksheet_is_refused_once_the_batch_is_frozen_and_keeps_its_outcomes(self):
        repo, work = self.copies()
        self.objectivity_split(repo, work)
        write_json(work / "rubric-outcomes-calibration.json", {"rows": []})
        write_json(work / "reference-freeze-calibration.json", {})
        self.refused(repo, work, "reference-freeze-calibration.json")
        self.assertEqual(json.loads((work / "rubric-outcomes-calibration.json").read_text()), {"rows": []})
        self.assertFalse((work / "rubric-questions-calibration.md").exists())
        (work / "reference-freeze-calibration.json").unlink()
        write_json(work / "reference-freeze-top-up.json", {})
        self.worksheet(repo, work)
        self.assertTrue((work / "rubric-questions-calibration.md").exists())

    def test_anchors_sha256_changes_on_an_anchor_cell_and_not_on_an_amendment_row(self):
        repo, work = self.copies()
        self.objectivity_split(repo, work)
        now = self.worksheet(repo, work)["anchors_sha256"]["after"]
        criteria = (repo / CRITERIA).read_text()
        number, text = self.line(repo, "| 2026-10-21 | Each batch's labels are frozen", section=False)
        (repo / CRITERIA).write_text(criteria.replace(text, text.replace("Discrepant-resolution bias", "Discrepant resolution bias")))
        self.assertEqual(self.worksheet(repo, work)["anchors_sha256"]["after"], now)
        _, row = self.line(repo, "| Methodology |")
        (repo / CRITERIA).write_text(criteria.replace(row, row.replace("| Prose only |", "| Prose only, nothing else |")))
        self.assertNotEqual(self.worksheet(repo, work)["anchors_sha256"]["after"], now)

    def test_a_wording_that_breaks_the_one_line_row_is_refused(self):
        repo, work = self.copies()
        self.objectivity_split(repo, work)
        write_json(work / "rubric-wordings-calibration.json", {"Objectivity-1-0": {"cue": "objectivity:pricing", "A": "Linked issues count.\nEven closed ones.", "B": "Issues alone do not."}})
        self.refused(repo, work, "Objectivity-1-0 wording A")
        write_json(work / "rubric-wordings-calibration.json", {"Objectivity-1-0": {"cue": "objectivity:pricing", "A": "Linked issues | count.", "B": "Issues alone do not."}})
        self.refused(repo, work, "Objectivity-1-0 wording A")
        write_json(work / "rubric-wordings-calibration.json", {"Objectivity-9-9": {"cue": "objectivity:pricing", "A": "a", "B": "b"}})
        self.refused(repo, work, "Objectivity-9-9")
        write_json(work / "rubric-wordings-calibration.json", {"Objectivity-1-0": {"cue": "objectivity:cheap", "A": "a", "B": "b"}})
        self.refused(repo, work, "objectivity:cheap")

    def test_wordings_render_the_patch_the_note_and_the_rerun_scope(self):
        repo, work = self.copies()
        self.objectivity_split(repo, work)
        write_json(work / "rubric-wordings-calibration.json", {"Objectivity-1-0": {"cue": "objectivity:pricing", "A": "A linked issue counts.", "B": "Issues alone do not count."}})
        question = self.worksheet(repo, work)["questions"][0]
        number, text = self.line(repo, "| Objectivity |")
        after = text.replace(" | Nothing sold but no such artefact.", " A linked issue counts. | Nothing sold but no such artefact.", 1)
        self.assertEqual(question["options"]["A"]["note"], {"line": number, "quote": after, "criterion": "Objectivity", "cue": "objectivity:pricing"})
        self.assertTrue(question["options"]["B"]["note"]["quote"].endswith("| Marketing for a paid product Issues alone do not count. |"))
        self.assertEqual(question["options"]["A"]["anchors_sha256"], sha(bundle_text(repo, load_topic(repo, "demo"), CRITERIA).replace(text, after)))
        self.assertEqual(question["options"]["A"]["rerun"], [])
        page = (work / "rubric-questions-calibration.md").read_text()
        for part in (f"-{text}", f"+{after}", f"@@ -{number},1 +{number},1 @@", json.dumps(question["options"]["A"]["note"], ensure_ascii=False)):
            self.assertIn(part, page)

    def test_outcomes_are_written_only_when_every_question_is_chosen_applied_and_noted(self):
        repo, work = self.copies()
        self.referenced(work, paid=(4, 9))
        write_json(work / "rubric-outcomes-calibration.json", {"rows": "stale"})
        self.flagged(work, {0: self.differing(0, {"Objectivity": (0, FORKED)}), 4: self.differing(4, {"Objectivity": (0, FORKED), "Position": (0, FORKED)}),
                            6: self.differing(6, {"Methodology": (0, FORKED)}), 8: self.differing(8, decision="excluded: aggregator", decision_cite=FORKED),
                            10: self.differing(10)},
                     [(0, ["Objectivity"]), (4, ["Objectivity", "Position"]), (6, ["Methodology", "eligibility"]), (8, ["eligibility"]), (10, ["problems"])])
        wordings = {"Objectivity-1-0": {"cue": "objectivity:pricing", "A": "A linked issue counts.", "B": "Issues alone do not count."},
                    "Position-1-0": {"cue": PAID, "A": "Naming one alternative counts.", "B": "A stated difference is needed."},
                    "Methodology-1-0": {"cue": PAID, "A": "Hook tests count.", "B": "Hook tests do not count."},
                    "decision-none-aggregator": {"cue": PAID, "A": "A kit with its own assets is no aggregator.", "B": "A list of kits is one."}}
        write_json(work / "rubric-wordings-calibration.json", wordings)
        before = self.worksheet(repo, work)
        self.assertFalse((work / "rubric-outcomes-calibration.json").exists())
        self.assertEqual([q["id"] for q in before["questions"]], ["Methodology-1-0", "Objectivity-1-0", "Position-1-0", "decision-none-aggregator"])
        aggregators, _ = self.line(repo, "**Aggregators.**", section=False)
        self.assertEqual(before["questions"][3]["line"], aggregators)
        self.assertEqual(before["contested"], [{"id": self.rows[10]["id"], "part": "problems", "reason": "the problem ids differ under the same Relevance; no criteria line anchors them"}])
        criteria = (repo / CRITERIA).read_text()
        notes = [before["rules"][0]["note"]]
        for question in before["questions"]:
            chosen = "B" if question["id"] == "Position-1-0" else "A"
            wordings[question["id"]]["chosen"] = chosen
            option = question["options"][chosen]
            criteria = criteria.replace(question["quote"], option["note"]["quote"])
        (repo / CRITERIA).write_text(criteria)
        write_json(work / "rubric-wordings-calibration.json", wordings)
        pending = self.worksheet(repo, work)
        self.assertFalse((work / "rubric-outcomes-calibration.json").exists())
        self.assertTrue(pending["pending"])
        lines = criteria.splitlines()
        notes = [{**notes[0], "quote": lines[notes[0]["line"] - 1]}]
        notes += [{"line": q["line"], "quote": lines[q["line"] - 1], "criterion": q["criterion"], "cue": wordings[q["id"]]["cue"]} for q in pending["questions"]]
        write_json(work / "reference-notes-calibration.json", notes)
        done = self.worksheet(repo, work)
        self.assertEqual(done["pending"], [])
        self.assertEqual(done["anchors_sha256"]["before"], before["anchors_sha256"]["after"])
        self.assertEqual(done["anchors_sha256"]["after"], sha(bundle_text(repo, load_topic(repo, "demo"), CRITERIA)))
        self.assertNotEqual(done["anchors_sha256"]["before"], done["anchors_sha256"]["after"])
        outcomes = {r["id"]: r for r in json.loads((work / "rubric-outcomes-calibration.json").read_text())["rows"]}
        self.assertEqual(sorted(outcomes), sorted(self.rows[n]["id"] for n in (0, 4, 6, 8, 10)))
        row = outcomes[self.rows[4]["id"]]
        self.assertEqual((row["outcome"], row["question"], row["notes"]), ("asked", "Position-1-0", [1, 4]))
        self.assertEqual(row["criteria"], {"Objectivity": {"outcome": "rule", "question": None}, "Position": {"outcome": "asked", "question": "Position-1-0"}})
        self.assertEqual({k: outcomes[self.rows[0]["id"]][k] for k in ("outcome", "question", "notes")}, {"outcome": "asked", "question": "Objectivity-1-0", "notes": []})
        self.assertEqual(outcomes[self.rows[6]["id"]]["criteria"], {"Methodology": {"outcome": "asked", "question": "Methodology-1-0"}})
        self.assertEqual(outcomes[self.rows[8]["id"]]["criteria"], {"decision": {"outcome": "asked", "question": "decision-none-aggregator"}})
        self.assertEqual({k: outcomes[self.rows[10]["id"]][k] for k in ("outcome", "question", "notes")}, {"outcome": "contested", "question": None, "notes": []})
        with self.assertRaises(TopicError):
            checked_notes([{**notes[0], "quote": "stale"}], lines, [])

    def test_questions_past_the_cap_of_five_are_contested(self):
        repo, work = self.copies()
        self.referenced(work)
        flagger = {2 * k: self.differing(2 * k, {name: (0, FORKED)}) for k, name in enumerate(NAMES)}
        flagger[1] = self.differing(1, {"Relevance": (1, base.SKILL)}, mechanisms=(base.GATE,))
        self.flagged(work, flagger, [(2 * k, [name]) for k, name in enumerate(NAMES)] + [(1, ["Relevance"])])
        sheet = self.worksheet(repo, work)
        self.assertEqual([q["id"] for q in sheet["questions"]], ["Authority-1-0", "Methodology-1-0", "Objectivity-1-0", "Position-1-0", "Relevance-0-1"])
        self.assertEqual(sheet["contested"], [{"id": self.rows[8]["id"], "part": "Relevance", "reason": "beyond the 5-question cap"}])

    def test_a_copy_code_question_edits_the_copy_cell_of_the_novelty_row(self):
        repo, work = self.copies()
        self.referenced(work)
        self.flagged(work, {12: self.differing(12, decision="excluded: copy", decision_cite=FORKED)}, [(12, ["eligibility"])])
        write_json(work / "rubric-wordings-calibration.json", {"decision-none-copy": {"cue": PAID, "A": "A fork with its own hooks is no copy.", "B": "A fork is a copy."}})
        question = self.worksheet(repo, work)["questions"][0]
        number, text = self.line(repo, "| Novelty for the kit |")
        self.assertEqual((question["id"], question["criterion"], question["line"], question["quote"]), ("decision-none-copy", "decision", number, text))
        quote = question["options"]["A"]["note"]["quote"]
        self.assertEqual(quote.split(" | ")[:3], text.split(" | ")[:3])
        self.assertTrue(quote.split(" | ")[3].startswith("A copy of another source"))
        self.assertTrue(quote.endswith(" A fork with its own hooks is no copy. |"))

    def test_a_decision_note_reruns_the_decision_on_the_rows_its_cue_selects(self):
        repo, work = self.copies()
        self.referenced(work, paid=(0, 61))
        number, text = self.line(repo, "| Novelty for the kit |")
        write_json(work / "reference-notes-calibration.json", [{"line": number, "quote": text, "criterion": "decision", "cue": PAID}])
        rows = self.rows
        self.session(work, "reference-calibration-config-notes-1", [base.reply(rows[0]["order_rank"], rows[0]["repo"], decision="excluded: copy", decision_cite=FORKED)],
                     self.packets["config"])
        self.session(work, "reference-calibration-product-notes-1", [base.reply(rows[61]["order_rank"], rows[61]["repo"], decision="excluded: copy", decision_cite=FORKED)],
                     self.packets["product"])
        with contextlib.redirect_stdout(io.StringIO()):
            script("derive-reference-labels").main(["--topic", "demo", "--repo", str(repo), "--work", str(work), "--criteria", CRITERIA, "--batch", "calibration"])
        labels = {r["id"]: r["user"] for r in json.loads((work / "calibration-labels.json").read_text())["rows"]}
        self.assertEqual([labels[rows[n]["id"]]["decision"] for n in (0, 61, 2, 1)], ["excluded: copy", "excluded: copy", "eligible", "excluded: irrelevant"])
        self.assertEqual([labels[rows[n]["id"]]["Relevance"] for n in (0, 61)], [1, 0])
        cites = {r["id"]: r for r in json.loads((work / "calibration-reference-cites.json").read_text())["rows"]}
        self.assertEqual((cites[rows[0]["id"]]["rerun"], cites[rows[0]["id"]]["cites"]["decision"]), ({"decision": "reference-calibration-config-notes-1"}, FORKED))
        self.assertEqual(cites[rows[61]["id"]]["rerun"], {"decision": "reference-calibration-product-notes-1"})
        self.assertNotIn("rerun", cites[rows[2]["id"]])

    def test_the_cli_writes_the_worksheet_and_names_the_next_step(self):
        repo, work = self.copies()
        self.objectivity_split(repo, work)
        with contextlib.redirect_stdout(io.StringIO()) as out:
            script("derive-reference-labels").main(["--topic", "demo", "--repo", str(repo), "--work", str(work), "--criteria", CRITERIA, "--worksheet"])
        self.assertIn("rubric-questions-calibration.md: 2 questions, 0 rows applied by rule, 0 rows contested", out.getvalue())
        self.assertFalse((work / "calibration-labels.json").exists())
        write_json(work / FREEZE_FILE, {})
        with self.assertRaises(SystemExit) as caught:
            script("derive-reference-labels").main(["--topic", "demo", "--repo", str(repo), "--work", str(work), "--criteria", CRITERIA, "--worksheet"])
        self.assertIn("protocol freeze", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
