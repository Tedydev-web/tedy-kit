import contextlib
import hashlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from study_calibration_set import pinned_inputs
from study_fixtures import FakeFetch, script, write_json, write_jsonl
from study_reference_flags import agy_window, differs, flagger_key
from study_session import canonical_sha256, session_header
from study_stage1 import LADDER
from study_topic import TopicError, flaggers, load_topic
from study_v4_fixture import TODAY
from test_calibration_set import drawn_work
from test_reference_run import MCP_LIST, PLUGIN_LIST, REFERENCE, ReferenceBase, fable, label, needle
from test_sessions import agy_reply

GEMINI = {"cli": "agy", "model": "gemini-3.8-flash-high"}
GPT_OSS = {"cli": "agy", "model": "gpt-oss-120b-medium"}
RETEST = {**REFERENCE, "retest": True}
LADDER_MODELS = [m for rung in LADDER for m in rung["models"]]
TREE = ["README.md", "skills/tdd/SKILL.md"]
SKILL = "path:skills/tdd/SKILL.md"
GATE = {"problem": "X1", "path": "skills/tdd/SKILL.md", "why": "a red test gates the commit"}


def scored(**values):
    return {"Authority": 1, "Methodology": 1, "Objectivity": 1, "Position": 1, "Relevance": 1, "problems": ["X1"], "decision": "eligible", **values}


def reply(row, values=(1, 1, 1, 1, 1), mechanisms=(GATE,)):
    names = ("Authority", "Methodology", "Objectivity", "Position", "Relevance")
    return {"order_rank": row["order_rank"], "repo": row["repo"], "scores": {n: {"v": v, "cite": SKILL} for n, v in zip(names, values)},
            "mechanisms": [dict(m) for m in mechanisms], "decision": "eligible", "decision_cite": SKILL}


class FlagRuleTest(unittest.TestCase):
    def test_a_full_point_flags_a_criterion_and_a_half_point_does_not(self):
        self.assertEqual(differs(scored(), scored(Authority=0.5, Position=0.5)), [])
        self.assertEqual(differs(scored(), scored(Authority=0, Methodology=0.5)), ["Authority"])

    def test_any_relevance_difference_flags(self):
        self.assertEqual(differs(scored(), scored(Relevance=0.5, problems=[])), ["problems", "Relevance"])

    def test_a_problem_set_difference_flags_alone(self):
        self.assertEqual(differs(scored(problems=["X1"]), scored(problems=["X1", "X2"])), ["problems"])

    def test_an_eligibility_difference_flags(self):
        self.assertEqual(differs(scored(), scored(decision="excluded: below-threshold")), ["eligibility"])
        self.assertEqual(differs(scored(decision="excluded: irrelevant"), scored(decision="excluded: below-threshold")), [])


class FlaggerTopicTest(ReferenceBase):
    def topic(self):
        return load_topic(self.repo, "demo")

    def test_the_index_judges_are_refused_as_flaggers_and_the_cross_family_model_is_not(self):
        for model, role in (("claude-opus-5-5", "sessions.A, qgs_judges.A, reader, the stage-1 ladder"), ("claude-sonnet-5-5", "sessions.B, qgs_judges.B, the stage-1 ladder")):
            with self.subTest(model):
                self.write_topic(rubric_trigger_flaggers=[{"cli": "claude", "model": model, "effort": "high"}])
                with self.assertRaisesRegex(TopicError, f"flagger {model} is also {role}; an index judge never flags the reference it is measured against"):
                    flaggers(self.topic(), LADDER_MODELS)
        self.write_topic(rubric_trigger_flaggers=[GEMINI])
        self.assertEqual(flaggers(self.topic(), LADDER_MODELS)["rubric_trigger"], [GEMINI])
        self.write_topic(record_only_flaggers=[{"cli": "claude", "model": "claude-haiku-5-5"}])
        with self.assertRaisesRegex(TopicError, "flagger claude-haiku-5-5 is also the stage-1 ladder"):
            flaggers(self.topic(), ["claude-haiku-5-5"])

    def test_a_retest_of_the_reference_is_a_flagger_only_when_marked_and_equal_to_the_reference(self):
        self.write_topic(rubric_trigger_flaggers=[RETEST], record_only_flaggers=[GEMINI, GPT_OSS])
        self.assertEqual(flaggers(self.topic(), LADDER_MODELS), {"rubric_trigger": [RETEST], "record_only": [GEMINI, GPT_OSS]})
        cases = {"is the reference; a flagger labels blind of it": [REFERENCE],
                 "is a retest, a second independent pass of the reference": [{**RETEST, "effort": "high"}],
                 "retest must be true": [{**REFERENCE, "retest": "yes"}]}
        for message, listed in cases.items():
            with self.subTest(message):
                self.write_topic(rubric_trigger_flaggers=listed)
                with self.assertRaisesRegex(TopicError, message):
                    flaggers(self.topic(), LADDER_MODELS)
        self.write_topic(rubric_trigger_flaggers=[GEMINI, RETEST], reference=None)
        with self.assertRaisesRegex(TopicError, "is a retest, a second independent pass of the reference"):
            flaggers(self.topic())

    def test_the_retest_session_key_is_fresh_and_the_cross_family_key_unchanged(self):
        self.assertEqual(flagger_key("calibration", "config", RETEST), "reference-calibration-config-flagger-claude-fable-5-1-pass2")
        self.assertEqual(flagger_key("top-up", "product", GEMINI), "reference-top-up-product-flagger-gemini-3.8-flash-high")


class RetestRunTest(ReferenceBase):
    def test_the_retest_runs_the_reference_kind_on_the_same_packet_under_its_own_key(self):
        self.write_topic(rubric_trigger_flaggers=[RETEST], record_only_flaggers=[GEMINI, GPT_OSS])
        fetch = FakeFetch([(needle(1), fable(label(1, "o/one"))), (needle(2), fable(label(2, "o/two")))])
        self.judge(fetch, "--model", "claude-fable-5-1", judge="flagger")
        name = "reference-calibration-config-flagger-claude-fable-5-1-pass2"
        self.assertEqual([r["order_rank"] for r in self.rows(name)], [1, 2])
        self.assertEqual(self.rows(), [])
        entry = self.sessions()[name]
        self.assertEqual((entry["cli"], entry["model"], entry["effort"]), ("claude", "claude-fable-5-1", "max"))
        bundle = hashlib.sha256((self.work / "reference-bundle.md").read_bytes()).hexdigest()
        self.assertEqual([b["packet_sha256"] for b in entry["blocks"]], [bundle] * 2)
        [call] = [c for c in fetch.called("claude -p") if needle(1) in c]
        self.assertIn("--model claude-fable-5-1 --effort max", call)
        self.assertNotIn("retest", call)

    def test_a_listed_index_judge_cannot_run_as_a_flagger(self):
        self.write_topic(record_only_flaggers=[{"cli": "claude", "model": "claude-sonnet-5-5", "effort": "high"}])
        self.assertIn("an index judge never flags", self.refused(FakeFetch(), "--model", "claude-sonnet-5-5", judge="flagger"))


class AgyState(FakeFetch):
    def __init__(self, rules=(), fail=None):
        super().__init__(rules)
        self.enabled, self.fail = {"mcp": True, "plugin": True}, fail

    def run(self, cmd, timeout=180, cwd=None):
        line = " ".join(cmd)
        if cmd[:1] == ["agy"] and len(cmd) == 4 and cmd[2] in ("enable", "disable"):
            self.calls.append(line)
            if line == self.fail:
                return "", "exit 1: refused", 0
            self.enabled[cmd[1]] = cmd[2] == "enable"
            return "", "ok", 0
        if line in ("agy mcp list", "agy plugin list"):
            self.calls.append(line)
            on = self.enabled[cmd[1]]
            text = MCP_LIST if cmd[1] == "mcp" else PLUGIN_LIST
            return (text if on else text.replace("  enabled  ", "  disabled  ").replace("(enabled,", "(disabled,")), "ok", 0
        return super().run(cmd, timeout, cwd)

    def switches(self):
        return [c for c in self.calls if c.split()[2:3] in (["enable"], ["disable"])]


class AgyWindowTest(ReferenceBase):
    ON = ["agy mcp disable context-mode", "agy plugin disable ponytail", "agy mcp enable context-mode", "agy plugin enable ponytail"]

    def test_the_window_disables_what_is_enabled_and_enables_it_again(self):
        fetch = AgyState()
        with agy_window(fetch):
            self.assertEqual(fetch.enabled, {"mcp": False, "plugin": False})
        self.assertEqual((fetch.switches(), fetch.enabled), (self.ON, {"mcp": True, "plugin": True}))

    def test_the_window_enables_again_when_the_run_fails(self):
        fetch = AgyState()
        with self.assertRaisesRegex(TopicError, "quota"):
            with agy_window(fetch):
                raise TopicError("quota")
        self.assertEqual((fetch.switches(), fetch.enabled), (self.ON, {"mcp": True, "plugin": True}))

    def test_the_window_leaves_a_disabled_extension_alone(self):
        fetch = AgyState()
        fetch.enabled["plugin"] = False
        with agy_window(fetch):
            pass
        self.assertEqual((fetch.switches(), fetch.enabled), (["agy mcp disable context-mode", "agy mcp enable context-mode"], {"mcp": True, "plugin": False}))

    def test_a_failed_disable_restores_and_a_failed_enable_is_loud(self):
        fetch = AgyState(fail="agy plugin disable ponytail")
        with self.assertRaisesRegex(TopicError, "agy plugin disable ponytail: exit 1: refused"):
            with agy_window(fetch):
                self.fail("the run must not start")
        self.assertEqual(fetch.enabled, {"mcp": True, "plugin": True})
        fetch = AgyState(fail="agy plugin enable ponytail")
        with self.assertRaisesRegex(TopicError, "enable them by hand: agy plugin enable ponytail: exit 1: refused"):
            with agy_window(fetch):
                pass

    def test_a_disable_agy_does_not_honour_is_refused_before_the_run(self):
        class Stuck(AgyState):
            def run(self, cmd, timeout=180, cwd=None):
                out = super().run(cmd, timeout, cwd)
                self.enabled["mcp"] = True
                return out

        fetch = Stuck()
        with self.assertRaisesRegex(TopicError, "still lists context-mode as enabled"):
            with agy_window(fetch):
                self.fail("the run must not start")

    def test_the_flag_wraps_the_flagger_run_and_is_off_by_default(self):
        fetch = AgyState([(needle(1), agy_reply(label(1, "o/one")))])
        self.judge(fetch, "--model", "gemini-3.8-flash-high", "--rows", "1-1", judge="flagger")
        self.assertEqual(fetch.switches(), [])
        fetch = AgyState([(needle(2), agy_reply(label(2, "o/two")))])
        self.judge(fetch, "--model", "gemini-3.8-flash-high", "--rows", "2-2", "--agy-window", judge="flagger")
        self.assertEqual(fetch.switches(), self.ON)
        [model] = [i for i, c in enumerate(fetch.calls) if c.startswith("agy --model")]
        self.assertLess(fetch.calls.index("agy plugin disable ponytail"), model)
        self.assertGreater(fetch.calls.index("agy mcp enable context-mode"), model)
        block = self.sessions()["reference-calibration-config-flagger-gemini-3.8-flash-high"]["blocks"][-1]
        self.assertEqual((block["agy_lists"]["before"]["context_mode_enabled"], block["agy_lists"]["after"]["ponytail_enabled"]), (False, False))

    def test_the_flag_is_refused_outside_an_agy_flagger(self):
        self.write_topic(rubric_trigger_flaggers=[RETEST], record_only_flaggers=[GEMINI, GPT_OSS])
        for judge, args in (("reference", []), ("flagger", ["--model", "claude-fable-5-1"])):
            with self.subTest(judge):
                fetch = AgyState()
                self.assertIn("--agy-window belongs to --judge flagger on agy", self.refused(fetch, *args, "--agy-window", judge=judge))
                self.assertEqual(fetch.calls, [])


class FlagsFileTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo, cls.work = drawn_work()
        topic = cls.repo / "docs/prior-art/topics/demo.json"
        write_json(topic, {**json.loads(topic.read_text()), "reference": REFERENCE})
        cls.sample = json.loads((cls.work / "calibration-set.json").read_text())
        held = pinned_inputs(cls.work, cls.sample)
        cls.packets = {s: {r["order_rank"]: {"order_rank": r["order_rank"], "repo": r["repo"], "sha": "e" * 40, "facts": held[r["id"]].get("facts", {}), "evidence": {},
                                             "readme": "# Demo", "tree": TREE, "prefilled": {}, "truncated": {}} for r in cls.sample["rows"] if r["stratum"] == s}
                       for s in ("config", "product")}
        for stratum, packets in cls.packets.items():
            write_jsonl(cls.work / f"reference-inputs-{stratum}.jsonl", list(packets.values()))
        cls.session(cls.work, "reference", REFERENCE, lambda n, r: reply(r))

    @classmethod
    def session(cls, work, key, option, make):
        meta_file = work / "meta.json"
        meta = json.loads(meta_file.read_text())
        effort = session_header(option, False)["effort"]
        for stratum in ("config", "product"):
            rows = [(n, r) for n, r in enumerate(cls.sample["rows"]) if r["stratum"] == stratum]
            made = [(r, make(n, r)) for n, r in rows]
            answered = [m for _, m in made if isinstance(m, dict)]
            name = "reference-calibration-" + stratum if key == "reference" else flagger_key("calibration", stratum, option)
            meta.setdefault("sessions", {})[name] = {"cli": option["cli"], "model": option["model"], "effort": effort,
                                                     "blocks": [{"ranks": [m["order_rank"]], "row_sha256": {str(m["order_rank"]): canonical_sha256(cls.packets[stratum][m["order_rank"]])}}
                                                                for m in answered],
                                                     **({"refused": [{"rank": r["order_rank"], "reason": "step types ['tool']", "date": TODAY} for r, m in made if m == "refused"]}
                                                        if any(m == "refused" for _, m in made) else {})}
            write_jsonl(work / f"{name}.jsonl", answered)
        write_json(meta_file, meta)

    def copies(self):
        base = Path(tempfile.mkdtemp(prefix="study-reference-flags-"))
        self.addCleanup(shutil.rmtree, base)
        repo, work = base / "repo", base / "work"
        shutil.copytree(self.repo, repo)
        shutil.copytree(self.work, work)
        return repo, work

    def flag(self, repo, work):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            script("flag-reference-rows").main(["--topic", "demo", "--repo", str(repo), "--work", str(work), "--batch", "calibration"])
        return json.loads((work / "reference-flags-calibration.json").read_text()), out.getvalue()

    def refused(self, repo, work, text):
        with self.assertRaises(SystemExit) as caught:
            self.flag(repo, work)
        self.assertIn(text, str(caught.exception))

    def gemini(self, n, r):
        if n == 4:
            return "refused"
        return reply(r, mechanisms=({**GATE, "problem": "X2"},)) if n % 10 == 0 else reply(r)

    def gpt_oss(self, n, r):
        return reply(r, values=(1, 1, 1, 1, 0), mechanisms=()) if n % 3 == 0 else reply(r)

    def test_rubric_rows_hold_only_the_trigger_flags_and_refusals_go_unflagged(self):
        repo, work = self.copies()
        self.session(work, "flagger", GEMINI, self.gemini)
        self.session(work, "flagger", GPT_OSS, self.gpt_oss)
        flags, printed = self.flag(repo, work)
        rows = self.sample["rows"]
        self.assertEqual(flags["batch"], "calibration")
        self.assertEqual(flags["set_sha256"], hashlib.sha256((work / "calibration-set.json").read_bytes()).hexdigest())
        self.assertEqual(flags["routed"], True)
        self.assertEqual(flags["rubric_rows"], [{"id": r["id"], "stratum": r["stratum"], "order_rank": r["order_rank"], "criteria": ["problems"]}
                                                for n, r in enumerate(rows) if n % 10 == 0])
        gemini, gpt_oss = flags["flaggers"]
        self.assertEqual((gemini["model"], gemini["role"], gemini["same_family"], gemini["answered"]), ("gemini-3.8-flash-high", "rubric_trigger", False, 119))
        self.assertEqual(gemini["unflagged_by_refusal"], [rows[4]["id"]])
        self.assertEqual((gpt_oss["role"], gpt_oss["answered"], gpt_oss["unflagged_by_refusal"]), ("record_only", 120, []))
        self.assertEqual(len(gpt_oss["rows"]), 40)
        self.assertEqual(gpt_oss["rows"][0], {"id": rows[0]["id"], "stratum": rows[0]["stratum"], "order_rank": rows[0]["order_rank"],
                                              "fields": ["eligibility", "problems", "Relevance"]})
        self.assertEqual(gpt_oss["eligibility_kappa"], 0.0)
        config = gemini["strata"]["config"]
        self.assertEqual(config["answered"], sum(1 for n, r in enumerate(rows) if r["stratum"] == "config" and n != 4))
        self.assertEqual(config["flagged"]["problems"], sum(1 for n, r in enumerate(rows) if r["stratum"] == "config" and n % 10 == 0))
        self.assertEqual(config["rate"]["problems"], round(config["flagged"]["problems"] / config["answered"], 3))
        self.assertEqual(config["flagged"]["Authority"], 0)
        self.assertEqual(flags["rows"][4], {"id": rows[4]["id"], "stratum": rows[4]["stratum"], "order_rank": rows[4]["order_rank"],
                                            "criteria": {f: False for f in flags["fields"]}, "unflagged_by_refusal": ["gemini-3.8-flash-high"]})
        self.assertEqual(flags["rows"][0]["criteria"]["problems"], True)
        self.assertEqual(flags["rows"][3]["criteria"]["Relevance"], False)
        self.assertEqual(gemini["eligibility_kappa"], None)
        self.assertIn("12 rubric rows", printed)

    def test_after_the_protocol_freeze_flags_are_for_the_record_and_never_routed(self):
        repo, work = self.copies()
        self.session(work, "flagger", GEMINI, self.gemini)
        self.session(work, "flagger", GPT_OSS, self.gpt_oss)
        write_json(work / "protocol-freeze.json", {"criteria": "docs/prior-art/quality-criteria-v4.md"})
        flags, _ = self.flag(repo, work)
        self.assertEqual((flags["routed"], flags["rubric_rows"]), (False, []))
        self.assertIn("protocol-freeze.json", flags["for_the_record"])
        self.assertEqual(flags["rows"][0]["criteria"]["problems"], True)

    def test_a_flagger_with_no_session_is_not_run_and_a_retest_is_named_same_family(self):
        repo, work = self.copies()
        path = repo / "docs/prior-art/topics/demo.json"
        write_json(path, {**json.loads(path.read_text()), "rubric_trigger_flaggers": [RETEST], "record_only_flaggers": [GEMINI, GPT_OSS]})
        self.session(work, "flagger", RETEST, lambda n, r: reply(r, values=(1, 1, 1, 1, 0.5), mechanisms=()) if n == 2 else reply(r))
        flags, _ = self.flag(repo, work)
        retest, gemini, gpt_oss = flags["flaggers"]
        self.assertEqual((retest["role"], retest["same_family"], retest["sessions"]),
                         ("rubric_trigger", True, ["reference-calibration-config-flagger-claude-fable-5-1-pass2", "reference-calibration-product-flagger-claude-fable-5-1-pass2"]))
        self.assertIn("test-retest", retest["family"])
        self.assertEqual([gemini["not_run"], gpt_oss["not_run"]], ["no session recorded"] * 2)
        row = self.sample["rows"][2]
        self.assertEqual(flags["rubric_rows"], [{"id": row["id"], "stratum": row["stratum"], "order_rank": row["order_rank"], "criteria": ["eligibility", "problems", "Relevance"]}])

    def test_a_flagger_run_left_half_done_is_refused(self):
        repo, work = self.copies()
        self.session(work, "flagger", GEMINI, lambda n, r: None if n == 7 else reply(r))
        self.refused(repo, work, "neither answered nor refused")
        self.assertFalse((work / "reference-flags-calibration.json").exists())

    def test_a_row_without_a_reference_reply_is_refused(self):
        repo, work = self.copies()
        self.session(work, "reference", REFERENCE, lambda n, r: None if n == 9 else reply(r))
        self.refused(repo, work, "no reference reply")


if __name__ == "__main__":
    unittest.main()
