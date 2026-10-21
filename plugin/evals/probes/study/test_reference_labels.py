import contextlib
import hashlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from study_calibration_set import pinned_inputs
from study_fixtures import script, write_json, write_jsonl
from study_session import canonical_sha256
from study_topic import TopicError
from study_reference_labels import checked_notes, checked_reply, row_label
from study_v4_fixture import CRITERIA, PROBLEMS, TODAY, quiet, saved_labels
from test_calibration_set import drawn_work

REFERENCE = {"cli": "claude", "model": "claude-fable-5-1", "effort": "max"}
TREE = ["README.md", "docs/README.md", "skills/tdd/SKILL.md", "src/hook.ts", "tests/hook.test.ts"]
README = "# Demo\nIt guards a   tdd\nloop before every commit.\nForked from upstream/demo."
SKILL = "path:skills/tdd/SKILL.md"
GATE = {"problem": "X1", "path": "skills/tdd/SKILL.md", "why": "a red test gates the commit"}


def packet(rank=1, repo="o/demo", readme=README):
    return {"order_rank": rank, "repo": repo, "sha": "e" * 40, "facts": {"pushed": "2026-09-01"}, "evidence": {"releases": 2}, "readme": readme, "tree": TREE,
            "prefilled": {"released": True, "changelog": None, "paid_tier_cues": []}, "truncated": {}}


def reply(rank=1, repo="o/demo", values=(1, 1, 1, 1, 1), cites=(SKILL,) * 5, mechanisms=(GATE,), decision="eligible", decision_cite="readme:It guards a tdd loop"):
    names = ("Authority", "Methodology", "Objectivity", "Position", "Relevance")
    return {"order_rank": rank, "repo": repo, "scores": {n: {"v": v, "cite": c} for n, v, c in zip(names, values, cites)}, "mechanisms": [dict(m) for m in mechanisms],
            "decision": decision, "decision_cite": decision_cite}


def labelled(first, chosen=None, held=None, date=0):
    return row_label("row", first, chosen or {}, held or packet(), date)


class ReplyMappingTest(unittest.TestCase):
    def test_a_path_cite_missing_from_the_tree_scores_zero_and_flags_the_row(self):
        label, record = labelled(reply(cites=("path:skills/ghost/SKILL.md", SKILL, SKILL, SKILL, SKILL)))
        self.assertEqual(label["Authority"], 0)
        self.assertEqual(label["Methodology"], 1)
        self.assertIn("citation failed: Authority path:skills/ghost/SKILL.md", record["flags"])
        self.assertEqual(record["cites"]["Authority"], "path:skills/ghost/SKILL.md")

    def test_a_readme_cite_matches_after_normalising_whitespace_and_a_fact_cite_needs_a_present_field(self):
        cites = ("readme:It guards a tdd loop before", "readme:It guards nothing", "fact:prefilled.released", "fact:prefilled.changelog", "fact:facts.pushed")
        label, record = labelled(reply(cites=cites))
        self.assertEqual([label[c] for c in ("Authority", "Methodology", "Objectivity", "Position", "Relevance")], [1, 0, 1, 0, 1])
        self.assertEqual(sorted(f.split(" ")[2] for f in record["flags"]), ["Methodology", "Position"])

    def test_a_mechanism_only_in_a_readme_caps_relevance_at_one_half(self):
        readme_only = [{"problem": "X1", "path": "README.md", "why": "the readme says so"}, {"problem": "X2", "path": "docs/README.md", "why": "so do the docs"}]
        label, record = labelled(reply(mechanisms=readme_only))
        self.assertEqual((label["Relevance"], label["problems"], label["decision"]), (0.5, [], "excluded: below-threshold"))
        self.assertEqual(record["mechanisms"], [])
        self.assertTrue(any(f.startswith("Relevance 1 needs a mechanism") for f in record["flags"]))

    def test_a_mechanism_at_a_hallucinated_path_is_dropped_and_flagged(self):
        ghost = {"problem": "X2", "path": "hooks/ghost.sh", "why": "a hook that is not there"}
        label, record = labelled(reply(mechanisms=(GATE, ghost)))
        self.assertEqual((label["Relevance"], label["problems"], label["decision"]), (1, ["X1"], "eligible"))
        self.assertEqual(record["mechanisms"], [GATE])
        self.assertIn("citation failed: mechanism hooks/ghost.sh", record["flags"])

    def test_relevance_one_half_from_the_reference_stays_one_half_beside_a_valid_mechanism(self):
        label, _ = labelled(reply(values=(1, 1, 1, 1, 0.5)))
        self.assertEqual((label["Relevance"], label["problems"], label["decision"]), (0.5, [], "excluded: below-threshold"))

    def test_a_cited_copy_is_kept_and_an_uncited_copy_is_derived_and_flagged(self):
        label, record = labelled(reply(decision="excluded: copy", decision_cite="readme:Forked from upstream/demo."))
        self.assertEqual(label["decision"], "excluded: copy")
        self.assertEqual(record["cites"]["decision"], "readme:Forked from upstream/demo.")
        label, record = labelled(reply(decision="excluded: aggregator", decision_cite="readme:An awesome list"))
        self.assertEqual(label["decision"], "eligible")
        self.assertNotIn("decision", record["cites"])
        self.assertIn("citation failed: decision readme:An awesome list", record["flags"])

    def test_the_decision_is_derived_four_is_below_threshold_and_four_and_a_half_eligible(self):
        self.assertEqual(labelled(reply(values=(1, 1, 1, 0.5, 1)))[0]["decision"], "eligible")
        self.assertEqual(labelled(reply(values=(1, 1, 1, 0, 1)))[0]["decision"], "excluded: below-threshold")
        self.assertEqual(labelled(reply(values=(1, 1, 0.5, 0.5, 1)), date=1)[0]["decision"], "eligible")
        self.assertEqual(labelled(reply(values=(1, 1, 1, 1, 0), mechanisms=(), decision="eligible"))[0]["decision"], "excluded: irrelevant")

    def test_a_rerun_criterion_replaces_only_that_criterion_and_relevance_brings_its_mechanisms(self):
        rerun = reply(values=(0, 0, 0, 0, 1), mechanisms=({"problem": "X3", "path": "src/hook.ts", "why": "a pre-commit hook"},))
        label, record = labelled(reply(), {"Objectivity": ("reference-calibration-config-notes-1", rerun), "Relevance": ("reference-calibration-config-notes-1", rerun)})
        self.assertEqual([label[c] for c in ("Authority", "Methodology", "Objectivity", "Position")], [1, 1, 0, 1])
        self.assertEqual(label["problems"], ["X3"])
        self.assertEqual(record["rerun"], {"Objectivity": "reference-calibration-config-notes-1", "Relevance": "reference-calibration-config-notes-1"})


class ReplyShapeTest(unittest.TestCase):
    def refused(self, row, text):
        with self.assertRaises(TopicError) as caught:
            checked_reply("calibration-config-1", row, "o/demo", PROBLEMS)
        self.assertIn(text, str(caught.exception))

    def test_a_well_formed_reply_passes(self):
        checked_reply("calibration-config-1", reply(), "o/demo", PROBLEMS)

    def test_an_unknown_problem_id_is_refused(self):
        self.refused(reply(mechanisms=({"problem": "Z9", "path": "src/hook.ts", "why": "w"},)), "Z9")

    def test_a_reply_with_another_key_set_is_refused(self):
        self.refused({**reply(), "Date": {"v": 1}}, "holds exactly")
        row = reply()
        row["scores"]["Date"] = {"v": 1, "cite": SKILL}
        self.refused(row, "scores")
        row = reply()
        row["scores"]["Authority"]["why"] = "free text"
        self.refused(row, "Authority")
        self.refused(reply(mechanisms=({"problem": "X1", "path": "src/hook.ts"},)), "mechanism")

    def test_a_rating_outside_the_scale_or_a_malformed_decision_is_refused(self):
        self.refused(reply(values=("1", 1, 1, 1, 1)), "Authority")
        self.refused(reply(values=(True, 1, 1, 1, 1)), "Authority")
        self.refused(reply(values=(0.7, 1, 1, 1, 1)), "Authority")
        self.refused(reply(decision="excluded: stale"), "decision")
        self.refused(reply(repo="o/other"), "o/other")

    def test_a_cite_outside_the_grammar_is_refused_not_scored(self):
        self.refused(reply(cites=("url:https://example.com", SKILL, SKILL, SKILL, SKILL)), "url:https://example.com")
        self.refused(reply(cites=("readme:" + "x" * 201, SKILL, SKILL, SKILL, SKILL)), "200")
        self.refused(reply(cites=("path:  ", SKILL, SKILL, SKILL, SKILL)), "path:")
        self.refused(reply(decision_cite=None), "decision")


class NoteTest(unittest.TestCase):
    LINES = ["# Criteria", "| Objectivity | Nothing sold | Some | Sold |", ""]

    def refused(self, notes, text):
        with self.assertRaises(TopicError) as caught:
            checked_notes(notes, self.LINES, [packet()])
        self.assertIn(text, str(caught.exception))

    def note(self, **change):
        return {"line": 2, "quote": self.LINES[1], "criterion": "Objectivity", "cue": "objectivity:pricing", **change}

    def test_a_note_in_the_four_field_form_passes(self):
        checked_notes([self.note(), self.note(cue="fact:prefilled.released"), self.note(cue="fact:evidence.releases")], self.LINES, [packet()])

    def test_a_note_with_a_free_text_or_value_field_is_refused(self):
        self.refused([self.note(value=0)], "never sets a value")
        self.refused([self.note(why="the reference misread it")], "never sets a value")
        self.refused([{k: v for k, v in self.note().items() if k != "cue"}], "never sets a value")
        self.refused({"notes": []}, "list")

    def test_a_note_whose_quote_differs_from_the_criteria_file_is_refused(self):
        self.refused([self.note(quote="| Objectivity | Nothing sold |")], "line 2")
        self.refused([self.note(line=3, quote="")], "line 3")
        self.refused([self.note(line=9)], "line 9")
        self.refused([self.note(line=True)], "line")

    def test_a_note_with_another_criterion_or_cue_is_refused(self):
        self.refused([self.note(criterion="Date")], "Date")
        self.refused([self.note(cue="objectivity:cheap")], "objectivity:cheap")
        self.refused([self.note(cue="not:vs code")], "not:vs code")
        self.refused([self.note(cue="fact:facts.stars")], "fact:facts.stars")
        self.refused([self.note(cue="fact:prefilled.nothing")], "fact:prefilled.nothing")


class ReferenceLabelsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo, cls.work = drawn_work()
        quiet(cls.repo, "freeze-stage1", "--work", str(cls.work), "--today", TODAY)
        topic = cls.repo / "docs/prior-art/topics/demo.json"
        write_json(topic, {**json.loads(topic.read_text()), "reference": REFERENCE})
        cls.sample = json.loads((cls.work / "calibration-set.json").read_text())
        cls.held = pinned_inputs(cls.work, cls.sample)

    def copies(self):
        base = Path(tempfile.mkdtemp(prefix="study-reference-labels-"))
        self.addCleanup(shutil.rmtree, base)
        repo, work = base / "repo", base / "work"
        shutil.copytree(self.repo, repo)
        shutil.copytree(self.work, work)
        return repo, work

    def row_packet(self, row, readme=README):
        return {**packet(row["order_rank"], row["repo"], readme), "facts": self.held[row["id"]].get("facts", {})}

    def row_reply(self, number, row, **change):
        if number % 2:
            return reply(row["order_rank"], row["repo"], values=(1, 1, 1, 1, 0), mechanisms=(), decision="excluded: irrelevant", **change)
        return reply(row["order_rank"], row["repo"], **change)

    def session(self, work, key, rows, packets, option=REFERENCE):
        meta_file = work / "meta.json"
        meta = json.loads(meta_file.read_text()) if meta_file.is_file() else {}
        blocks = [{"ranks": [r["order_rank"]], "row_sha256": {str(r["order_rank"]): canonical_sha256(packets[r["order_rank"]])}} for r in rows]
        meta.setdefault("sessions", {})[key] = {"cli": option["cli"], "model": option["model"], "effort": option["effort"], "blocks": blocks}
        write_json(meta_file, meta)
        write_jsonl(work / f"{key}.jsonl", rows)

    def referenced(self, work, readme=lambda number: README, replies=None):
        for stratum in ("config", "product"):
            rows = [(n, r) for n, r in enumerate(self.sample["rows"]) if r["stratum"] == stratum]
            packets = {r["order_rank"]: self.row_packet(r, readme(n)) for n, r in rows}
            write_jsonl(work / f"reference-inputs-{stratum}.jsonl", list(packets.values()))
            made = [(replies or self.row_reply)(n, r) for n, r in rows]
            self.session(work, f"reference-calibration-{stratum}", [m for m in made if m is not None], packets)

    def derive(self, repo, work, *extra):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            script("derive-reference-labels").main(["--topic", "demo", "--repo", str(repo), "--work", str(work), "--criteria", CRITERIA, *extra])
        return out.getvalue()

    def refused(self, repo, work, text, *extra):
        with self.assertRaises(SystemExit) as caught:
            self.derive(repo, work, *extra)
        self.assertIn(text, str(caught.exception))

    def objectivity_line(self, repo):
        lines = (repo / CRITERIA).read_text().splitlines()
        number = next(i for i, line in enumerate(lines, 1) if line.startswith("| Objectivity |"))
        return {"line": number, "quote": lines[number - 1], "criterion": "Objectivity", "cue": "objectivity:pricing"}

    def test_reference_labels_carry_the_labeller_and_pass_the_label_rules(self):
        repo, work = self.copies()
        self.referenced(work)
        printed = self.derive(repo, work, "--batch", "calibration")
        labels = json.loads((work / "calibration-labels.json").read_text())
        self.assertEqual(labels["labeller"], {"kind": "reference", "cli": "claude", "model": "claude-fable-5-1", "effort": "max",
                                              "sessions": ["reference-calibration-config", "reference-calibration-product"], "notes_sha256": None})
        self.assertEqual((labels["complete"], len(labels["rows"])), (120, 120))
        self.assertEqual(labels["set_sha256"], hashlib.sha256((work / "calibration-set.json").read_bytes()).hexdigest())
        decisions = [r["user"]["decision"] for r in labels["rows"]]
        self.assertEqual((decisions.count("eligible"), decisions.count("excluded: irrelevant")), (60, 60))
        self.assertEqual(labels["rows"][0]["user"], {"Authority": 1, "Methodology": 1, "Objectivity": 1, "Position": 1, "Relevance": 1, "problems": ["X1"], "decision": "eligible"})
        cites = json.loads((work / "calibration-reference-cites.json").read_text())
        self.assertEqual(cites["labels_sha256"], hashlib.sha256((work / "calibration-labels.json").read_bytes()).hexdigest())
        self.assertEqual([r["id"] for r in cites["rows"]], [r["id"] for r in self.sample["rows"]])
        self.assertEqual(cites["rows"][0]["mechanisms"], [GATE])
        self.assertEqual(cites["rows"][0]["cites"]["Authority"], SKILL)
        self.assertIn("120 rows", printed)

    def test_a_malformed_reply_is_refused_and_the_labels_file_left_untouched(self):
        repo, work = self.copies()
        (work / "calibration-labels.json").write_text("earlier\n")
        self.referenced(work, replies=lambda n, r: {**self.row_reply(n, r), "note": "extra"} if n == 7 else self.row_reply(n, r))
        self.refused(repo, work, "holds exactly", "--batch", "calibration")
        self.assertEqual((work / "calibration-labels.json").read_text(), "earlier\n")
        self.assertFalse((work / "calibration-reference-cites.json").exists())

    def test_a_row_without_a_reference_reply_is_refused(self):
        repo, work = self.copies()
        self.referenced(work, replies=lambda n, r: None if n == 3 else self.row_reply(n, r))
        self.refused(repo, work, "no reference reply", "--batch", "calibration")
        self.assertFalse((work / "calibration-labels.json").exists())

    def test_a_reply_for_a_row_outside_the_batch_is_refused(self):
        repo, work = self.copies()
        self.referenced(work)
        rows = [json.loads(line) for line in (work / "reference-inputs-config.jsonl").read_text().splitlines()]
        packets = {r["order_rank"]: r for r in rows + [packet(9999, "o/stray")]}
        write_jsonl(work / "reference-inputs-config.jsonl", list(packets.values()))
        replies = [json.loads(line) for line in (work / "reference-calibration-config.jsonl").read_text().splitlines()]
        self.session(work, "reference-calibration-config", replies + [reply(9999, "o/stray")], packets)
        self.refused(repo, work, "does not hold", "--batch", "calibration")

    def test_a_packet_row_changed_after_the_reference_read_it_is_refused(self):
        repo, work = self.copies()
        self.referenced(work)
        rows = [json.loads(line) for line in (work / "reference-inputs-config.jsonl").read_text().splitlines()]
        rows[0]["tree"] = rows[0]["tree"] + ["skills/later/SKILL.md"]
        write_jsonl(work / "reference-inputs-config.jsonl", rows)
        self.refused(repo, work, "the row the reference read", "--batch", "calibration")

    def test_a_session_of_another_model_or_none_at_all_is_refused(self):
        repo, work = self.copies()
        self.referenced(work)
        meta = json.loads((work / "meta.json").read_text())
        meta["sessions"]["reference-calibration-product"]["model"] = "claude-opus-5-5"
        write_json(work / "meta.json", meta)
        self.refused(repo, work, "claude-opus-5-5", "--batch", "calibration")
        del meta["sessions"]["reference-calibration-product"]
        write_json(work / "meta.json", meta)
        self.refused(repo, work, "records no session reference-calibration-product", "--batch", "calibration")

    def test_a_topic_without_a_reference_is_refused(self):
        repo, work = self.copies()
        self.referenced(work)
        topic = repo / "docs/prior-art/topics/demo.json"
        write_json(topic, {k: v for k, v in json.loads(topic.read_text()).items() if k != "reference"})
        self.refused(repo, work, "names no reference", "--batch", "calibration")

    def test_a_reference_that_is_also_an_index_judge_or_a_ladder_model_is_refused(self):
        repo, work = self.copies()
        self.referenced(work)
        topic = repo / "docs/prior-art/topics/demo.json"
        write_json(topic, {**json.loads(topic.read_text()), "reference": {**REFERENCE, "model": "claude-opus-5-5"}})
        self.refused(repo, work, "reference claude-opus-5-5 is also sessions.A, qgs_judges.A, reader, the stage-1 ladder; the reference is never a judge", "--batch", "calibration")

    def test_the_user_import_is_refused_for_a_reference_topic(self):
        repo, work = self.copies()
        path = saved_labels(work, "calibration")
        with self.assertRaises(SystemExit) as caught:
            quiet(repo, "import-calibration-labels", "--work", str(work), "--labels", str(path))
        self.assertIn("derive-reference-labels.py", str(caught.exception))
        self.assertFalse((work / "calibration-labels.json").exists())

    def pricing(self, number):
        return README + "\nA paid pricing tier." if number in (0, 1, 61) else README

    def test_the_rerun_value_replaces_only_the_rows_a_note_selects_and_only_its_criterion(self):
        repo, work = self.copies()
        self.referenced(work, readme=self.pricing)
        note = self.objectivity_line(repo)
        write_json(work / "reference-notes-calibration.json", [note])
        rows = self.sample["rows"]
        packets = {json.loads(line)["order_rank"]: json.loads(line) for line in (work / "reference-inputs-config.jsonl").read_text().splitlines()}
        rerun = [reply(rows[n]["order_rank"], rows[n]["repo"], values=(0, 0, 0.5, 0, 1)) for n in (0, 1) if rows[n]["stratum"] == "config"]
        self.assertEqual(len(rerun), 2)
        self.session(work, "reference-calibration-config-notes-1", rerun, packets)
        products = {json.loads(line)["order_rank"]: json.loads(line) for line in (work / "reference-inputs-product.jsonl").read_text().splitlines()}
        self.session(work, "reference-calibration-product-notes-1", [reply(rows[61]["order_rank"], rows[61]["repo"], values=(1, 1, 0, 1, 1))], products)
        self.derive(repo, work, "--batch", "calibration")
        labels = {r["id"]: r["user"] for r in json.loads((work / "calibration-labels.json").read_text())["rows"]}
        self.assertEqual([labels[rows[n]["id"]]["Objectivity"] for n in (0, 1, 2, 61, 62)], [0.5, 0.5, 1, 0, 1])
        self.assertEqual([labels[rows[n]["id"]]["Authority"] for n in (0, 1, 61)], [1, 1, 1])
        self.assertEqual(labels[rows[1]["id"]]["decision"], "excluded: irrelevant")
        cites = {r["id"]: r for r in json.loads((work / "calibration-reference-cites.json").read_text())["rows"]}
        self.assertEqual(cites[rows[0]["id"]]["rerun"], {"Objectivity": "reference-calibration-config-notes-1"})
        self.assertNotIn("rerun", cites[rows[2]["id"]])
        labeller = json.loads((work / "calibration-labels.json").read_text())["labeller"]
        self.assertEqual(labeller["notes_sha256"], hashlib.sha256((work / "reference-notes-calibration.json").read_bytes()).hexdigest())
        self.assertEqual(labeller["sessions"], ["reference-calibration-config", "reference-calibration-config-notes-1", "reference-calibration-product",
                                                "reference-calibration-product-notes-1"])

    def test_a_row_a_note_selects_without_a_rerun_is_refused(self):
        repo, work = self.copies()
        self.referenced(work, readme=self.pricing)
        write_json(work / "reference-notes-calibration.json", [self.objectivity_line(repo)])
        self.refused(repo, work, "re-run", "--batch", "calibration")
        self.assertFalse((work / "calibration-labels.json").exists())

    def test_a_rerun_row_no_note_selects_is_refused(self):
        repo, work = self.copies()
        self.referenced(work)
        rows = self.sample["rows"]
        packets = {json.loads(line)["order_rank"]: json.loads(line) for line in (work / "reference-inputs-config.jsonl").read_text().splitlines()}
        self.session(work, "reference-calibration-config-notes-1", [reply(rows[2]["order_rank"], rows[2]["repo"], values=(0, 0, 0, 0, 1))], packets)
        self.refused(repo, work, "no note selects", "--batch", "calibration")

    def test_a_note_against_another_criteria_line_is_refused(self):
        repo, work = self.copies()
        self.referenced(work, readme=self.pricing)
        write_json(work / "reference-notes-calibration.json", [{**self.objectivity_line(repo), "quote": "| Objectivity | anything |"}])
        self.refused(repo, work, "verbatim", "--batch", "calibration")

    def test_rows_outside_the_batches_go_to_their_purpose_labels_file(self):
        repo, work = self.copies()
        rows = [r for r in self.sample["rows"] if r["stratum"] == "config"][:2]
        packets = {r["order_rank"]: self.row_packet(r) for r in rows}
        write_jsonl(work / "reference-inputs-config.jsonl", list(packets.values()))
        self.session(work, "reference-exclusion-audit-1-config", [reply(rows[0]["order_rank"], rows[0]["repo"]), reply(rows[1]["order_rank"], rows[1]["repo"], values=(1, 1, 1, 1, 0),
                                                                                                                 mechanisms=(), decision="excluded: irrelevant")], packets)
        self.derive(repo, work, "--batch", "exclusion-audit-1")
        out = json.loads((work / "exclusion-audit-1-reference-labels.json").read_text())
        self.assertEqual(out["purpose"], "exclusion-audit-1")
        self.assertEqual(out["labeller"]["sessions"], ["reference-exclusion-audit-1-config"])
        self.assertEqual([(r["stratum"], r["order_rank"], r["label"]["decision"]) for r in out["rows"]],
                         [("config", rows[0]["order_rank"], "eligible"), ("config", rows[1]["order_rank"], "excluded: irrelevant")])
        self.assertEqual(out["rows"][0]["mechanisms"], [GATE])
        write_json(work / "reference-notes-exclusion-audit-1.json", [])
        self.refused(repo, work, "notes", "--batch", "exclusion-audit-1")
        self.refused(repo, work, "not a calibration-family batch", "--batch", "stage-9")


if __name__ == "__main__":
    unittest.main()
