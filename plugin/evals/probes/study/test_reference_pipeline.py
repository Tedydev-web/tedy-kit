import contextlib
import hashlib
import io
import json
import shutil
import unittest

from study_calibration_set import pinned_inputs
from study_fixtures import FakeFetch, script, write_json, write_jsonl
from study_v4_fixture import CRITERIA, PROBLEMS, TODAY, quiet
from test_calibration_set import drawn_work
from test_reference_freeze import HOOK_TEXT, REFERENCE, SKILL_TEXT
from test_reference_labels import packet, reply
from test_reference_run import fable, needle
from test_sessions import agy_reply

GEMINI = {"cli": "agy", "model": "gemini-3.8-flash-high"}
LISTS = [("agy mcp list", "NAME TYPE STATUS\n"), ("agy plugin list", "Installed plugins:\n")]
PAID = "fact:prefilled.paid_tier_cues"
FORKED = "readme:Forked from upstream/demo."
PAID_ROWS = (0, 2, 61)


def first_reply(number, row, **change):
    if number % 2:
        return {**reply(row["order_rank"], row["repo"], values=(1, 1, 1, 1, 0), mechanisms=(), decision="excluded: irrelevant"), **change}
    return {**reply(row["order_rank"], row["repo"]), **change}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ReferencePipelineBase(unittest.TestCase):
    flagger = GEMINI

    def setUp(self):
        self.repo, self.work = drawn_work()
        self.addCleanup(shutil.rmtree, self.repo)
        self.addCleanup(shutil.rmtree, self.work)
        quiet(self.repo, "freeze-stage1", "--work", str(self.work), "--today", TODAY)
        (self.repo / "docs/prior-art/problems-demo.md").write_text("| Id | Problem | Area |\n|---|---|---|\n" + "".join(f"| {p} | statement of {p} | area |\n" for p in PROBLEMS))
        topic = self.repo / "docs/prior-art/topics/demo.json"
        write_json(topic, {**json.loads(topic.read_text()), "reference": REFERENCE, "eligibility": {"vi": "-", "en": "The judges' question."},
                           "rubric_trigger_flaggers": [self.flagger], "record_only_flaggers": []})
        self.sample = json.loads((self.work / "calibration-set.json").read_text())
        self.rows = self.sample["rows"]
        held = pinned_inputs(self.work, self.sample)
        (self.work / "reference-bundle.md").write_text("# Reference anchors\n")
        for stratum in ("config", "product"):
            packets = []
            for n, r in enumerate(self.rows):
                if r["stratum"] == stratum:
                    made = {**packet(r["order_rank"], r["repo"]), "facts": held[r["id"]].get("facts", {}),
                            "assets": [{"path": "skills/tdd/SKILL.md", "text": SKILL_TEXT}, {"path": "src/hook.ts", "text": HOOK_TEXT}]}
                    made["prefilled"] = {**made["prefilled"], "paid_tier_cues": ["3: A paid hosted tier."] if n in PAID_ROWS else []}
                    packets.append(made)
            write_jsonl(self.work / f"reference-inputs-{stratum}.jsonl", packets)

    def cli(self, name, *extra, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            script(name).main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), *extra], **kwargs)
        return out.getvalue()

    def judge(self, judge, stratum, replies, *extra):
        wrap = agy_reply if judge == "flagger" and self.flagger["cli"] == "agy" else fable
        rules = [(needle(r["order_rank"]), wrap(json.dumps(reply_row))) for r, reply_row in replies]
        fetch = FakeFetch([*LISTS, *rules] if wrap is agy_reply else rules)
        return self.cli("run-judge", "--judge", judge, "--set", "reference", "--batch", "calibration", "--stratum", stratum, *extra, "--today", TODAY,
                        fetch=fetch, which=lambda cli: True, environ={})

    def first_runs(self, flagged=None):
        for stratum in ("config", "product"):
            rows = [(n, r) for n, r in enumerate(self.rows) if r["stratum"] == stratum]
            self.judge("reference", stratum, [(r, first_reply(n, r)) for n, r in rows])
            self.judge("flagger", stratum, [(r, (flagged or {}).get(n) or first_reply(n, r)) for n, r in rows], "--model", self.flagger["model"])

    def line(self, start):
        lines = (self.repo / CRITERIA).read_text().splitlines()
        begin = next(i for i, text in enumerate(lines) if text.startswith("## GitHub assets"))
        number = next(i for i, text in enumerate(lines[begin:], begin + 1) if text.startswith(start))
        return number, lines[number - 1]

    def derive(self, *extra):
        return self.cli("derive-reference-labels", "--criteria", CRITERIA, "--batch", "calibration", *extra)

    def labels(self):
        return {r["id"]: r["user"] for r in json.loads((self.work / "calibration-labels.json").read_text())["rows"]}

    def cites(self):
        return {r["id"]: r for r in json.loads((self.work / "calibration-reference-cites.json").read_text())["rows"]}

    def frozen(self):
        return json.loads((self.work / "reference-freeze-calibration.json").read_text())


class DecisionNoteFreezeTest(ReferencePipelineBase):
    def test_a_decision_note_reruns_its_rows_and_the_derived_decision_is_frozen(self):
        self.first_runs()
        self.cli("flag-reference-rows", "--batch", "calibration")
        number, text = self.line("| Novelty for the kit |")
        write_json(self.work / "reference-notes-calibration.json", [{"line": number, "quote": text, "criterion": "decision", "cue": PAID}])
        for stratum, picked in (("config", (0, 2)), ("product", (61,))):
            self.judge("reference", stratum, [(self.rows[n], first_reply(n, self.rows[n], decision="excluded: copy", decision_cite=FORKED)) for n in picked], "--rerun-notes", "1")
        self.derive()
        labels, cites = self.labels(), self.cites()
        self.assertEqual([labels[self.rows[n]["id"]]["decision"] for n in (0, 2, 61, 4, 1)], ["excluded: copy"] * 3 + ["eligible", "excluded: irrelevant"])
        self.assertEqual(cites[self.rows[61]["id"]]["rerun"], {"decision": "reference-calibration-product-notes-1"})
        self.assertNotIn("rerun", cites[self.rows[4]["id"]])
        self.cli("freeze-reference", "--batch", "calibration", "--today", TODAY)
        freeze = self.frozen()
        self.assertEqual(freeze["notes_sha256"], sha(self.work / "reference-notes-calibration.json"))
        self.assertEqual(sorted(freeze["reference"]["sessions"]), ["reference-calibration-config", "reference-calibration-config-notes-1", "reference-calibration-product",
                                                                   "reference-calibration-product-notes-1"])
        self.assertEqual(freeze["labels_sha256"], sha(self.work / "calibration-labels.json"))
        self.assertEqual(freeze["rubric"]["flagged"], 0)


if __name__ == "__main__":
    unittest.main()
