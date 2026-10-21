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
from study_reference_freeze import require_frozen
from study_session import canonical_sha256
from study_topic import TopicError, load_topic
from study_v4_fixture import CRITERIA, TODAY, ScriptedJudges, calibrated_work, quiet
from test_calibration_set import drawn_work
from test_reference_labels import README, packet, reply

REFERENCE = {"cli": "claude", "model": "claude-fable-5-1", "effort": "max"}
GEMINI, GPT_OSS = "gemini-3.8-flash-high", "gpt-oss-120b-medium"
LISTS = {"mcp_sha256": "a" * 64, "plugins_sha256": "b" * 64, "context_mode_enabled": False, "ponytail_enabled": False}
SKILL_TEXT = "# TDD skill\nA red test gates the commit.\n"
HOOK_TEXT = "export const hook = () => true;\n"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def with_reference(repo):
    path = repo / "docs/prior-art/topics/demo.json"
    write_json(path, {**json.loads(path.read_text()), "reference": REFERENCE})


def row_reply(number, row):
    if number % 2:
        return reply(row["order_rank"], row["repo"], values=(1, 1, 1, 1, 0), mechanisms=(), decision="excluded: irrelevant")
    return reply(row["order_rank"], row["repo"])


def derive(repo, work):
    with contextlib.redirect_stdout(io.StringIO()):
        script("derive-reference-labels").main(["--topic", "demo", "--repo", str(repo), "--work", str(work), "--criteria", CRITERIA, "--batch", "calibration"])


def reference_session(work, key, rows, packets, bundle_sha):
    meta_file = work / "meta.json"
    meta = json.loads(meta_file.read_text()) if meta_file.is_file() else {}
    blocks = [{"ranks": [r["order_rank"]], "packet_sha256": bundle_sha, "row_sha256": {str(r["order_rank"]): canonical_sha256(packets[r["order_rank"]])}} for r in rows]
    meta.setdefault("sessions", {})[key] = {**REFERENCE, "blocks": blocks}
    write_json(meta_file, meta)
    write_jsonl(work / f"{key}.jsonl", rows)


def referenced_work():
    repo, work = drawn_work()
    quiet(repo, "freeze-stage1", "--work", str(work), "--today", TODAY)
    with_reference(repo)
    sample = json.loads((work / "calibration-set.json").read_text())
    held = pinned_inputs(work, sample)
    (work / "reference-bundle.md").write_text("# Reference anchors\n")
    for stratum in ("config", "product"):
        rows = [(n, r) for n, r in enumerate(sample["rows"]) if r["stratum"] == stratum]
        packets = {r["order_rank"]: {**packet(r["order_rank"], r["repo"]), "facts": held[r["id"]].get("facts", {}),
                                     "assets": [{"path": "skills/tdd/SKILL.md", "text": SKILL_TEXT}, {"path": "src/hook.ts", "text": HOOK_TEXT}]} for _, r in rows}
        write_jsonl(work / f"reference-inputs-{stratum}.jsonl", list(packets.values()))
        reference_session(work, f"reference-calibration-{stratum}", [row_reply(n, r) for n, r in rows], packets, sha(work / "reference-bundle.md"))
    derive(repo, work)
    return repo, work, sample


class ReferenceFreezeBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo, cls.work, cls.sample = referenced_work()

    def copies(self):
        base = Path(tempfile.mkdtemp(prefix="study-reference-freeze-"))
        self.addCleanup(shutil.rmtree, base)
        repo, work = base / "repo", base / "work"
        shutil.copytree(self.repo, repo)
        shutil.copytree(self.work, work)
        return repo, work

    def meta(self, work):
        return json.loads((work / "meta.json").read_text())

    def flagger(self, work, model, refused=(), skipped=()):
        meta = self.meta(work)
        for stratum in ("config", "product"):
            key = f"reference-calibration-{stratum}-flagger-{model}"
            rows = [r for r in self.sample["rows"] if r["stratum"] == stratum]
            answered = [r for r in rows if r["id"] not in refused and r["id"] not in skipped]
            gone = [{"rank": r["order_rank"], "reason": "step types ['tool']", "date": TODAY} for r in rows if r["id"] in refused]
            meta["sessions"][key] = {"cli": "agy", "model": model, "blocks": [{"ranks": [r["order_rank"]], "agy_lists": {"before": LISTS, "after": LISTS}} for r in answered],
                                     **({"refused": gone} if gone else {})}
            write_jsonl(work / f"{key}.jsonl", [{"order_rank": r["order_rank"], "repo": r["repo"]} for r in answered])
        write_json(work / "meta.json", meta)

    def flags(self, work, ids):
        rows = {r["id"]: r for r in self.sample["rows"]}
        write_json(work / "reference-flags-calibration.json",
                   {"rubric_rows": [{"id": i, "stratum": rows[i]["stratum"], "order_rank": rows[i]["order_rank"], "criteria": ["Objectivity"]} for i in ids]})

    def outcomes(self, work, *rows):
        drawn = {r["id"]: r for r in self.sample["rows"]}
        write_json(work / "rubric-outcomes-calibration.json", {"rows": [{"id": i, "stratum": drawn[i]["stratum"], "order_rank": drawn[i]["order_rank"], "outcome": outcome,
                                                                         "question": question, "notes": notes} for i, outcome, question, notes in rows]})

    def flagged_work(self, refused=()):
        repo, work = self.copies()
        self.flagger(work, GEMINI)
        self.flagger(work, GPT_OSS, refused=refused)
        self.flags(work, [])
        return repo, work

    def freeze(self, repo, work, *extra, batch="calibration"):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            script("freeze-reference").main(["--topic", "demo", "--repo", str(repo), "--work", str(work), "--batch", batch, "--today", TODAY, *extra])
        return out.getvalue()

    def refused(self, repo, work, text, *extra):
        with self.assertRaises(SystemExit) as caught:
            self.freeze(repo, work, *extra)
        self.assertIn(text, str(caught.exception))
        return str(caught.exception)

    def frozen(self, work):
        return json.loads((work / "reference-freeze-calibration.json").read_text())


class FreezeRecordTest(ReferenceFreezeBase):
    def test_the_freeze_records_the_hashes_the_anchors_the_sessions_and_each_flaggers_coverage(self):
        ids = [r["id"] for r in self.sample["rows"]]
        refused = ids[:5] + [i for i in ids if "product" in i][:5]
        repo, work = self.flagged_work(refused)
        printed = self.freeze(repo, work)
        freeze, meta = self.frozen(work), self.meta(work)["sessions"]
        bundle = sha(work / "reference-bundle.md")
        self.assertEqual((freeze["batch"], freeze["frozen"]), ("calibration", TODAY))
        self.assertEqual((freeze["set_sha256"], freeze["labels_sha256"], freeze["cites_sha256"], freeze["notes_sha256"]),
                         (sha(work / "calibration-set.json"), sha(work / "calibration-labels.json"), sha(work / "calibration-reference-cites.json"), None))
        self.assertEqual(freeze["anchors_sha256"], {"before": bundle, "after": bundle})
        self.assertEqual(freeze["criteria_sha256_at_freeze"], sha(repo / CRITERIA))
        reference = freeze["reference"]
        self.assertEqual((reference["model"], reference["effort"], sorted(reference["sessions"])),
                         ("claude-fable-5-1", "max", ["reference-calibration-config", "reference-calibration-product"]))
        self.assertEqual(reference["sessions"]["reference-calibration-config"],
                         {"session_sha256": canonical_sha256(meta["reference-calibration-config"]), "rows_sha256": sha(work / "reference-calibration-config.jsonl")})
        gpt, gemini = freeze["flaggers"][GPT_OSS], freeze["flaggers"][GEMINI]
        self.assertEqual((gpt["role"], gpt["answered"], gpt["unflagged_by_refusal"]), ("record_only", 110, refused))
        self.assertEqual((gemini["role"], gemini["answered"], gemini["unflagged_by_refusal"]), ("rubric_trigger", 120, []))
        self.assertEqual(sorted(gpt["sessions"]), [f"reference-calibration-{s}-flagger-{GPT_OSS}" for s in ("config", "product")])
        self.assertEqual(gemini["agy_lists"], {"before": LISTS, "after": LISTS})
        self.assertEqual(freeze["rubric"]["flagged"], 0)
        self.assertIn(f"{GPT_OSS} answered 110, unflagged by refusal 10", printed)

    def test_a_freeze_is_never_rewritten(self):
        repo, work = self.flagged_work()
        self.freeze(repo, work)
        before = (work / "reference-freeze-calibration.json").read_text()
        self.refused(repo, work, "a freeze is never rewritten, a later batch gets its own")
        self.assertEqual((work / "reference-freeze-calibration.json").read_text(), before)

    def test_a_batch_outside_the_calibration_family_is_refused(self):
        repo, work = self.flagged_work()
        with self.assertRaises(SystemExit) as caught:
            self.freeze(repo, work, batch="adjudication")
        self.assertIn("is not calibration, top-up or a held-out batch", str(caught.exception))


class FreezeRefusalTest(ReferenceFreezeBase):
    def test_a_flagger_that_did_not_run_blocks_the_freeze_unless_the_fallback_names_why(self):
        repo, work = self.copies()
        self.flagger(work, GEMINI)
        self.flags(work, [])
        self.refused(repo, work, f"flaggers {GPT_OSS} have not run on calibration; run them, or freeze with --without-flaggers")
        self.refused(repo, work, "in a non-empty reason", "--without-flaggers", " ")
        self.assertFalse((work / "reference-freeze-calibration.json").exists())
        self.freeze(repo, work, "--without-flaggers", "agy quota exhausted until 2026-10-24")
        self.assertEqual(self.frozen(work)["flaggers"][GPT_OSS], "not run: agy quota exhausted until 2026-10-24")

    def test_a_fallback_reason_when_every_flagger_ran_is_refused(self):
        repo, work = self.flagged_work()
        self.refused(repo, work, "every flagger ran on this batch", "--without-flaggers", "agy quota")

    def test_a_row_a_flagger_neither_answered_nor_refused_blocks_the_freeze(self):
        repo, work = self.copies()
        self.flagger(work, GEMINI, skipped=[self.sample["rows"][0]["id"]])
        self.flagger(work, GPT_OSS)
        self.flags(work, [])
        self.refused(repo, work, f"flagger {GEMINI} has neither answered nor twice refused 1 rows of calibration ({self.sample['rows'][0]['id']})")

    def test_flaggers_that_ran_need_their_flags_first(self):
        repo, work = self.flagged_work()
        (work / "reference-flags-calibration.json").unlink()
        self.refused(repo, work, "no reference-flags-calibration.json in")

    def relabel(self, work, change):
        labels = json.loads((work / "calibration-labels.json").read_text())
        write_json(work / "calibration-labels.json", change(labels))
        cites = json.loads((work / "calibration-reference-cites.json").read_text())
        write_json(work / "calibration-reference-cites.json", {**cites, "labels_sha256": sha(work / "calibration-labels.json")})

    def test_labels_without_the_reference_labeller_or_from_another_model_are_refused(self):
        repo, work = self.flagged_work()
        self.relabel(work, lambda labels: {k: v for k, v in labels.items() if k != "labeller"})
        self.refused(repo, work, "carries no reference labeller")
        self.relabel(work, lambda labels: {**labels, "labeller": {"kind": "reference", "cli": "claude", "model": "claude-opus-5-5", "effort": "max",
                                                                  "sessions": ["reference-calibration-config", "reference-calibration-product"], "notes_sha256": None}})
        self.refused(repo, work, "was labelled by claude claude-opus-5-5 (effort max)")

    def test_labels_edited_after_their_cites_are_refused(self):
        repo, work = self.flagged_work()
        labels = json.loads((work / "calibration-labels.json").read_text())
        labels["rows"][0]["user"]["Authority"] = 0.5
        write_json(work / "calibration-labels.json", labels)
        self.refused(repo, work, "calibration-reference-cites.json was not written with the current calibration-labels.json")

    def test_a_bundle_changed_after_the_latest_reference_round_is_a_pending_rubric_edit(self):
        repo, work = self.flagged_work()
        (work / "reference-bundle.md").write_text("# Reference anchors\nObjectivity 1 now reads otherwise.\n")
        self.refused(repo, work, "a rubric edit is pending: reference-bundle.md")


class RubricOutcomeTest(ReferenceFreezeBase):
    def test_every_rubric_row_needs_exactly_one_outcome(self):
        repo, work = self.flagged_work()
        first, second = self.sample["rows"][0]["id"], self.sample["rows"][1]["id"]
        self.flags(work, [first, second])
        self.refused(repo, work, f"rubric row {first} has no outcome in rubric-outcomes-calibration.json")
        self.outcomes(work, (first, "rule", None, []), (second, "asked", None, []))
        self.refused(repo, work, "an asked row names its question")
        self.outcomes(work, (first, "rule", None, []), (first, "asked", "Q1", []))
        self.refused(repo, work, f"{first} has a second outcome")
        self.outcomes(work, (first, "rule", None, []), (second, "dropped", None, []))
        self.refused(repo, work, "outcome 'dropped' is not one of rule, asked, contested")
        self.outcomes(work, (first, "rule", None, []), (self.sample["rows"][2]["id"], "rule", None, []))
        self.refused(repo, work, "is no rubric row of reference-flags-calibration.json")
        self.outcomes(work, (first, "rule", None, []), (second, "asked", "Q1", []))
        self.freeze(repo, work)
        rubric = self.frozen(work)["rubric"]
        self.assertEqual({k: rubric[k] for k in ("flagged", "rule", "asked", "contested", "rerun", "contested_rows")},
                         {"flagged": 2, "rule": 1, "asked": 1, "contested": 0, "rerun": 0, "contested_rows": []})
        self.assertEqual((rubric["flags_sha256"], rubric["outcomes_sha256"]), (sha(work / "reference-flags-calibration.json"), sha(work / "rubric-outcomes-calibration.json")))

    def rerun_work(self):
        repo, work = self.flagged_work()
        row = next(r for r in self.sample["rows"] if r["stratum"] == "config")
        rank = row["order_rank"]
        inputs = [json.loads(line) for line in (work / "reference-inputs-config.jsonl").read_text().splitlines()]
        packets = {p["order_rank"]: ({**p, "readme": README + "\nPricing: a paid tier."} if p["order_rank"] == rank else p) for p in inputs}
        write_jsonl(work / "reference-inputs-config.jsonl", list(packets.values()))
        meta = self.meta(work)
        for block in meta["sessions"]["reference-calibration-config"]["blocks"]:
            block["row_sha256"] = {str(r): canonical_sha256(packets[r]) for r in block["ranks"]}
        write_json(work / "meta.json", meta)
        lines = (repo / CRITERIA).read_text().splitlines()
        number = next(i for i, line in enumerate(lines, 1) if line.startswith("| Objectivity |"))
        write_json(work / "reference-notes-calibration.json", [{"line": number, "quote": lines[number - 1], "criterion": "Objectivity", "cue": "objectivity:pricing"}])
        (work / "reference-bundle.md").write_text("# Reference anchors\nwith the chosen Objectivity wording\n")
        first = json.loads((work / "reference-calibration-config.jsonl").read_text().splitlines()[0])
        reference_session(work, "reference-calibration-config-notes-1", [first], packets, sha(work / "reference-bundle.md"))
        derive(repo, work)
        return repo, work, row

    def test_a_rerun_row_keeps_the_anchors_before_and_after_and_its_notes_hold(self):
        repo, work, row = self.rerun_work()
        other = next(r["id"] for r in self.sample["rows"] if r["stratum"] == "product")
        self.flags(work, [row["id"], other])
        self.outcomes(work, (row["id"], "asked", "Q1", [1]), (other, "rule", None, [1]))
        self.refused(repo, work, f"rubric row {other} names notes [1] but no reference-calibration-product-notes-<n>.jsonl re-ran it")
        self.outcomes(work, (row["id"], "contested", None, []), (other, "rule", None, []))
        self.refused(repo, work, f"rubric row {row['id']} is contested yet was re-run")
        self.outcomes(work, (row["id"], "asked", "Q1", [1]), (other, "contested", None, []))
        self.freeze(repo, work)
        freeze = self.frozen(work)
        self.assertEqual(freeze["anchors_sha256"]["after"], sha(work / "reference-bundle.md"))
        self.assertNotEqual(freeze["anchors_sha256"]["before"], freeze["anchors_sha256"]["after"])
        self.assertEqual(freeze["notes_sha256"], sha(work / "reference-notes-calibration.json"))
        self.assertIn("reference-calibration-config-notes-1", freeze["reference"]["sessions"])
        self.assertEqual({k: freeze["rubric"][k] for k in ("asked", "contested", "rerun", "contested_rows")}, {"asked": 1, "contested": 1, "rerun": 1, "contested_rows": [other]})

    def test_notes_changed_after_the_derive_are_refused(self):
        repo, work, _ = self.rerun_work()
        notes = json.loads((work / "reference-notes-calibration.json").read_text())
        write_json(work / "reference-notes-calibration.json", notes + notes)
        self.refused(repo, work, "reference-notes-calibration.json changed after calibration-labels.json was derived")

    def test_after_the_protocol_freeze_flaggers_not_run_and_open_rubric_rows_are_recorded_and_a_criteria_edit_is_refused(self):
        repo, work = self.copies()
        write_json(work / "protocol-freeze.json", {"strata": {"config": {"criteria_sha256": sha(repo / CRITERIA)}}})
        first = self.sample["rows"][0]["id"]
        self.flags(work, [first])
        self.freeze(repo, work)
        freeze = self.frozen(work)
        self.assertEqual(freeze["flaggers"], {GEMINI: "not run: after protocol freeze", GPT_OSS: "not run: after protocol freeze"})
        self.assertEqual((freeze["rubric"]["contested"], freeze["rubric"]["contested_rows"]), (1, [first]))
        repo, work = self.copies()
        write_json(work / "protocol-freeze.json", {"strata": {"config": {"criteria_sha256": "c" * 64}}})
        self.refused(repo, work, "a rubric edit is pending: docs/prior-art/quality-criteria-v4.md differs from the criteria protocol-freeze.json pinned")


class RequireFrozenTest(ReferenceFreezeBase):
    def test_a_batch_needs_a_freeze_whose_set_and_labels_hashes_hold_now(self):
        repo, work = self.flagged_work()
        topic = load_topic(repo, "demo")
        with self.assertRaisesRegex(TopicError, "no reference-freeze-calibration.json in .*; the calibration labels are frozen with freeze-reference.py"):
            require_frozen(topic, work, ("calibration",))
        self.freeze(repo, work)
        self.assertEqual(require_frozen(topic, work, ("calibration",)), {"calibration": sha(work / "reference-freeze-calibration.json")})
        (work / "calibration-labels.json").write_text((work / "calibration-labels.json").read_text() + " ")
        with self.assertRaisesRegex(TopicError, "calibration-labels.json differs from the one reference-freeze-calibration.json froze"):
            require_frozen(topic, work, ("calibration",))

    def test_a_topic_without_a_reference_is_unaffected(self):
        repo, work = self.copies()
        path = repo / "docs/prior-art/topics/demo.json"
        write_json(path, {k: v for k, v in json.loads(path.read_text()).items() if k != "reference"})
        self.assertEqual(require_frozen(load_topic(repo, "demo"), work, ("calibration", "top-up")), {})


class RunnerRefusalTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.judges = ScriptedJudges()
        cls.repo, cls.work = calibrated_work(cls.judges)

    def setUp(self):
        base = Path(tempfile.mkdtemp(prefix="study-reference-runners-"))
        self.addCleanup(shutil.rmtree, base)
        self.repo, self.work = base / "repo", base / "work"
        shutil.copytree(type(self).repo, self.repo)
        shutil.copytree(type(self).work, self.work)
        with_reference(self.repo)

    def frozen(self, batch="calibration"):
        write_json(self.work / f"reference-freeze-{batch}.json", {"batch": batch, "set_sha256": sha(self.work / f"{batch}-set.json"),
                                                                   "labels_sha256": sha(self.work / f"{batch}-labels.json")})
        return sha(self.work / f"reference-freeze-{batch}.json")

    def judge(self):
        quiet(self.repo, "run-judge", "--work", str(self.work), "--stratum", "config", "--judge", "screening-A", "--set", "calibration", "--run", "1", "--rows", "1-2",
              "--today", TODAY, fetch=self.judges)

    def stage1(self, which="calibration"):
        quiet(self.repo, "run-stage1", "--work", str(self.work), "--stratum", "config", "--shape", "brief", "--model", "claude-sonnet-5-5", "--set", which,
              *(("--run", "1") if which == "calibration" else ()), "--today", TODAY, fetch=self.judges)

    def blocks(self, key):
        return json.loads((self.work / "meta.json").read_text())["sessions"][key]["blocks"]

    def test_a_judge_calibration_run_is_refused_without_a_freeze_and_its_blocks_record_the_freeze(self):
        with self.assertRaisesRegex(SystemExit, "no reference-freeze-calibration.json in"):
            self.judge()
        freeze = self.frozen()
        self.judge()
        self.assertEqual(self.blocks("judge-config-screening-A-claude-opus-5-5-run1")[0]["reference_freeze_sha256"], {"calibration": freeze})

    def test_a_judge_calibration_run_is_refused_after_a_labels_edit(self):
        self.frozen()
        (self.work / "calibration-labels.json").write_text((self.work / "calibration-labels.json").read_text() + " ")
        with self.assertRaisesRegex(SystemExit, "calibration-labels.json differs from the one reference-freeze-calibration.json froze"):
            self.judge()

    def test_a_stage1_calibration_run_is_refused_without_a_freeze_and_its_blocks_record_the_freeze(self):
        with self.assertRaisesRegex(SystemExit, "no reference-freeze-calibration.json in"):
            self.stage1()
        freeze = self.frozen()
        self.stage1()
        self.assertEqual({b["reference_freeze_sha256"]["calibration"] for b in self.blocks("judge-config-stage1-brief-claude-sonnet-5-5-run1")}, {freeze})

    def test_a_stage1_held_out_run_is_refused_without_a_freeze(self):
        write_json(self.work / "stage1-rung.json", {"rung": 2})
        write_json(self.work / "held-out-set.json", {"rows": [{"id": "held-out-config-1", "stratum": "config", "order_rank": 1, "repo": "o/one"}]})
        with self.assertRaisesRegex(TopicError, "no reference-freeze-held-out.json in"):
            script("run-stage1").plan(load_topic(self.repo, "demo"), self.work, "config", "brief", "claude-sonnet-5-5", "held-out", None)

    def test_a_topic_without_a_reference_runs_and_records_no_freeze(self):
        path = self.repo / "docs/prior-art/topics/demo.json"
        write_json(path, {k: v for k, v in json.loads(path.read_text()).items() if k != "reference"})
        self.judge()
        self.assertNotIn("reference_freeze_sha256", self.blocks("judge-config-screening-A-claude-opus-5-5-run1")[0])


if __name__ == "__main__":
    unittest.main()
