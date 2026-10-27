import contextlib
import hashlib
import io
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path

from study_citation_check import drawn
from study_citation_checkers import FILE_BYTES, checker_prompts, parse_vote, votes_file
from study_fixtures import FakeFetch, script
from study_reference_freeze import require_frozen
from study_session import MAX_PROMPT
from study_topic import TopicError, load_topic
from study_v4_fixture import SECRET, SWEEP, TODAY, quiet
from test_citation_check import REGISTRY
from test_reference_freeze import GEMINI, GPT_OSS, referenced_work
from test_reference_run import fable
from test_session_reply import agy_stream

OPUS = "claude-opus-5-5"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def agy(text):
    return agy_stream({"status": "SUCCESS", "num_turns": 1, "response": text}, "agent_response")


class CitationCheckersTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo, cls.work, _ = referenced_work()
        (cls.repo / "docs/prior-art/problems-demo.md").write_text("# Problems\n\n| Id | Statement |\n|---|---|\n" + REGISTRY)
        quiet(cls.repo, "freeze-reference", "--work", str(cls.work), "--batch", "calibration", "--without-flaggers", "agy quota", "--today", TODAY)
        cls.rows = drawn(SWEEP, json.loads((cls.work / "calibration-labels.json").read_text())["rows"])

    def copies(self):
        base = Path(tempfile.mkdtemp(prefix="study-citation-checkers-"))
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

    def votes(self, work, model, unsupported=(), cli="agy", **change):
        votes = {}
        for row in self.rows:
            answer = "yes" if row["kind"] == "relevance-1" else "no"
            if row["id"] in unsupported:
                answer = "no" if answer == "yes" else "yes"
            votes[row["id"]] = {"answer": answer, "reason": "skills/tdd/SKILL.md line 2", "prompt_sha256": "a" * 64}
        saved = {"sweep": SWEEP, "set_sha256": sha(work / "calibration-set.json"), "freeze_sha256": sha(work / "reference-freeze-calibration.json"),
                 "checker": {"cli": cli, "model": model, "effort": "max" if cli == "claude" else "set by the model id", "isolation": "empty folder"}, "votes": votes,
                 "refused": {}, **change}
        path = work / votes_file(model)
        path.write_text(json.dumps(saved))
        return path

    def imported(self, repo, work, *paths):
        return self.run_script("import-citation-check", repo, work, "--votes", *map(str, paths))

    def refused(self, repo, work, paths, text):
        with self.assertRaises(SystemExit) as caught:
            self.imported(repo, work, *paths)
        self.assertIn(text, str(caught.exception))

    def test_the_prompt_shows_each_cited_file_in_full_up_to_the_cap_the_problem_and_the_anchor_but_no_label(self):
        repo, work = self.copies()
        long_file = "".join(f"line {i}\n" for i in range(1, 61))
        prompts = checker_prompts(load_topic(repo, "demo"), repo, work, FakeFetch([("contents/", long_file)]))
        self.assertEqual([row["id"] for row, _ in prompts], [r["id"] for r in self.rows])
        positive = next(p for row, p in prompts if row["kind"] == "relevance-1")
        negative = next(p for row, p in prompts if row["kind"] == "relevance-0")
        for prompt in (positive, negative):
            self.assertIn("line 60", prompt)
            self.assertIn("statement of problem X1", prompt)
            self.assertIn("answer: yes", prompt)
            self.assertIn("You have no tools in this session", prompt)
            for leaked in ("claude-fable-5-1", '"scores"', "decision", "excluded", SECRET, GEMINI, GPT_OSS, "Authority", "Methodology"):
                self.assertNotIn(leaked, prompt)
        self.assertIn("Relevance = 1", positive)
        self.assertIn('<file path="src/hook.ts">', negative)
        self.assertIn("Does any of these files carry a mechanism for a listed problem?", negative)
        self.assertIn("What counts as a mechanism (the Relevance 1 anchor):", negative)
        self.assertNotIn("What counts as a mechanism", positive)
        cut = checker_prompts(load_topic(repo, "demo"), repo, work, FakeFetch([("contents/", "x" * (FILE_BYTES + 5))]))[0][1]
        self.assertIn(f"(cut at {FILE_BYTES} bytes)", cut)

    def test_a_row_citing_many_files_shares_the_prompt_limit_between_them(self):
        repo, work = self.copies()
        cites = json.loads((work / "calibration-reference-cites.json").read_text())
        row = next(r for r in self.rows if r["kind"] == "relevance-1")
        target = next(r for r in cites["rows"] if r["id"] == row["id"])
        target["mechanisms"] = [{"problem": "X1", "path": f"hooks/gate-{i}.sh", "why": "w"} for i in range(30)]
        (work / "calibration-reference-cites.json").write_text(json.dumps(cites))
        prompt = dict((r["id"], p) for r, p in checker_prompts(load_topic(repo, "demo"), repo, work, FakeFetch([("contents/", "é" * FILE_BYTES)])))[row["id"]]
        self.assertLessEqual(len(prompt.encode()), MAX_PROMPT)
        self.assertEqual(prompt.count('<file path="hooks/gate-'), 30)
        self.assertEqual(len(set(re.findall(r"\(cut at (\d+) bytes\)", prompt))), 1)

    def test_a_reply_is_two_lines_answer_and_reason(self):
        self.assertEqual(parse_vote("answer: Yes\nreason: hooks/gate.sh line 3 blocks the commit"), {"answer": "yes", "reason": "hooks/gate.sh line 3 blocks the commit"})
        for bad in ("answer: maybe\nreason: x", "answer: yes", "yes\nreason: x", ""):
            with self.assertRaises(TopicError):
                parse_vote(bad)

    def test_a_checker_run_writes_one_vote_per_row_retries_a_bad_reply_once_and_fills_a_refused_row_on_the_next_run(self):
        repo, work = self.copies()
        bad = self.rows[0]["id"]
        good = fable("answer: yes\nreason: skills/tdd/SKILL.md line 2", models=(OPUS,))
        fetch = FakeFetch([(f"Row: {bad}\n", fable("I think so", models=(OPUS,))), (f"--model {OPUS}", good)])
        self.run_script("run-citation-checker", repo, work, "--checker", f"claude:{OPUS}:max", fetch=fetch)
        saved = json.loads((work / votes_file(OPUS)).read_text())
        self.assertEqual((len(saved["votes"]), list(saved["refused"])), (29, [bad]))
        self.assertEqual(len(fetch.called(f"Row: {bad}\n")), 2)
        self.assertEqual(saved["checker"]["model"], OPUS)
        self.assertEqual(saved["freeze_sha256"], sha(work / "reference-freeze-calibration.json"))
        again = FakeFetch([(f"--model {OPUS}", good)])
        self.run_script("run-citation-checker", repo, work, "--checker", f"claude:{OPUS}:max", fetch=again)
        saved = json.loads((work / votes_file(OPUS)).read_text())
        self.assertEqual((len(saved["votes"]), saved["refused"], len(again.called("claude -p"))), (30, {}, 1))
        ledger = [json.loads(line) for line in (work / "claude-spend-ledger.jsonl").read_text().splitlines()]
        mine = [line for line in ledger if line["key"] == f"citation-check-{OPUS}"]
        self.assertEqual((len(mine), sum("refused" in line for line in mine), {line["total_cost_usd"] for line in mine}), (32, 2, {0.42}))
        self.assertEqual(mine[-1]["ranks"], [bad])
        stale = json.loads((work / votes_file(OPUS)).read_text())
        (work / votes_file(OPUS)).write_text(json.dumps({**stale, "checker": {**stale["checker"], "prompt_rules_sha256": "0" * 64}}))
        with self.assertRaises(SystemExit) as caught:
            self.run_script("run-citation-checker", repo, work, "--checker", f"claude:{OPUS}:max", fetch=FakeFetch())
        self.assertIn("was written for another freeze, set or checker setup", str(caught.exception))
        agy_fetch = FakeFetch([(f"--model {GEMINI}", agy("answer: no\nreason: none of the files checks anything"))])
        self.run_script("run-citation-checker", repo, work, "--checker", f"agy:{GEMINI}", fetch=agy_fetch)
        gemini = json.loads((work / votes_file(GEMINI)).read_text())
        self.assertEqual(({v["answer"] for v in gemini["votes"].values()}, gemini["refused"]), ({"no"}, {}))

    def test_an_aperture_checker_posts_the_prompt_as_a_chat_completion_and_refuses_a_tool_call_or_another_model(self):
        repo, work = self.copies()
        luna = "openai/gpt-5.6-luna"

        def completion(text, model=luna, tools=False):
            message = {"role": "assistant", "content": text, **({"tool_calls": [{"id": "t"}]} if tools else {})}
            return json.dumps({"model": model, "choices": [{"message": message}], "usage": {"prompt_tokens": 900, "completion_tokens": 40}})

        bad, other = self.rows[0]["id"], self.rows[1]["id"]
        fetch = FakeFetch([("--data-binary", completion("answer: yes\nreason: skills/tdd/SKILL.md line 2"))])
        fetch.rules.insert(0, (f"aperture-{bad}", completion("answer: yes\nreason: x", tools=True)))
        fetch.rules.insert(0, (f"aperture-{other}", completion("answer: yes\nreason: x", model="openai/gpt-6-luna")))
        self.run_script("run-citation-checker", repo, work, "--checker", f"aperture:{luna}", "--endpoint", "http://100.127.1.240", fetch=fetch)
        saved = json.loads((work / votes_file(luna)).read_text())
        self.assertEqual((len(saved["votes"]), sorted(saved["refused"])), (28, sorted([bad, other])))
        self.assertIn("tool call", saved["refused"][bad])
        self.assertIn("served openai/gpt-6-luna", saved["refused"][other])
        self.assertEqual(saved["checker"]["endpoint"], "http://100.127.1.240")
        call = fetch.called("curl")[0]
        self.assertIn("http://100.127.1.240/v1/chat/completions", call)
        self.assertTrue((work / "citation-check-votes-openai--gpt-5.6-luna.json").is_file())
        ledger = [json.loads(line) for line in (work / "claude-spend-ledger.jsonl").read_text().splitlines()]
        self.assertEqual({line["usage"]["prompt_tokens"] for line in ledger if line["key"] == "citation-check-openai--gpt-5.6-luna"}, {900})
        with self.assertRaises(SystemExit) as caught:
            self.run_script("run-citation-checker", repo, work, "--checker", f"aperture:{luna}", fetch=FakeFetch())
        self.assertIn("--endpoint", str(caught.exception))

    def test_three_checkers_decide_each_row_by_majority_and_the_record_names_them(self):
        repo, work = self.copies()
        first, second = self.rows[0]["id"], self.rows[1]["id"]
        paths = [self.votes(work, OPUS, cli="claude", unsupported=[first]), self.votes(work, GEMINI, unsupported=[first]), self.votes(work, GPT_OSS, unsupported=[second])]
        self.refused(repo, work, paths, "2 with an unsupporting vote from claude-opus-5-5, gemini-3.8-flash-high, gpt-oss-120b-medium; the checkers straddle the stop rule")
        check = json.loads((work / "citation-check.json").read_text())
        self.assertEqual((check["n"], check["unsupported"], check["unsupported_any"], check["straddle"], check["stopped"]), (30, 1, 2, True, False))
        self.assertEqual(([c["model"] for c in check["checkers"]], check["rule"]), ([OPUS, GEMINI, GPT_OSS], "majority"))
        row = next(r for r in check["rows"] if r["id"] == first)
        self.assertEqual((row["answer"], row["unsupported"], row["votes"]), ("no", True, {OPUS: "no", GEMINI: "no", GPT_OSS: "yes"}))
        with self.assertRaisesRegex(TopicError, "the checkers straddle the stop rule: 1 of 30 unsupported by majority, 2 by any checker; next step is the user's"):
            require_frozen(load_topic(repo, "demo"), work, ("calibration",))
        out = self.run_script("import-citation-check", repo, work, "--votes", *map(str, paths), "--accept-straddle")
        self.assertIn("the user accepted the straddle", out)
        check = json.loads((work / "citation-check.json").read_text())
        self.assertRegex(check["straddle_accepted"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertEqual(require_frozen(load_topic(repo, "demo"), work, ("calibration",)), {"calibration": sha(work / "reference-freeze-calibration.json")})
        with self.assertRaises(SystemExit) as caught:
            self.run_script("import-citation-check", repo, work, "--votes", *map(str, paths), "--accept-straddle")
        self.assertIn("holds another check than these votes give", str(caught.exception))
        (work / "citation-check.json").write_text(json.dumps({**check, "straddle": False}))
        with self.assertRaisesRegex(TopicError, "straddle"):
            require_frozen(load_topic(repo, "demo"), work, ("calibration",))

    def test_accepting_a_straddle_is_refused_when_the_check_does_not_straddle(self):
        repo, work = self.copies()
        first, second = self.rows[0]["id"], self.rows[1]["id"]
        with self.assertRaises(SystemExit) as caught:
            self.run_script("import-citation-check", repo, work, "--votes", str(self.votes(work, OPUS, cli="claude")), str(self.votes(work, GEMINI)),
                            str(self.votes(work, GPT_OSS)), "--accept-straddle")
        self.assertIn("--accept-straddle takes a three-checker check that straddles", str(caught.exception))
        with self.assertRaises(SystemExit) as caught:
            self.run_script("import-citation-check", repo, work, "--votes", str(self.votes(work, OPUS, cli="claude", unsupported=[first, second])),
                            str(self.votes(work, GEMINI, unsupported=[first, second])), str(self.votes(work, GPT_OSS)), "--accept-straddle")
        self.assertIn("--accept-straddle takes a three-checker check that straddles", str(caught.exception))
        self.assertFalse((work / "citation-check.json").is_file())

    def test_a_majority_check_below_the_stop_rule_lets_the_runners_read_the_batch(self):
        repo, work = self.copies()
        first = self.rows[0]["id"]
        self.imported(repo, work, self.votes(work, OPUS, cli="claude"), self.votes(work, GEMINI, unsupported=[first]), self.votes(work, GPT_OSS))
        check = json.loads((work / "citation-check.json").read_text())
        self.assertEqual((check["unsupported"], check["unsupported_any"], check["straddle"]), (0, 1, False))
        self.assertEqual(require_frozen(load_topic(repo, "demo"), work, ("calibration",)), {"calibration": sha(work / "reference-freeze-calibration.json")})

    def test_two_checkers_count_a_row_unsupported_when_either_says_so(self):
        repo, work = self.copies()
        first = self.rows[0]["id"]
        self.imported(repo, work, self.votes(work, OPUS, cli="claude"), self.votes(work, GEMINI, unsupported=[first]))
        check = json.loads((work / "citation-check.json").read_text())
        self.assertEqual((check["unsupported"], check["unsupported_any"], check["straddle"], check["rule"]), (1, 1, False, "either"))
        row = next(r for r in check["rows"] if r["id"] == first)
        self.assertEqual((row["answer"], row["unsupported"], row["votes"]), ("no", True, {OPUS: "yes", GEMINI: "no"}))
        self.assertEqual(require_frozen(load_topic(repo, "demo"), work, ("calibration",)), {"calibration": sha(work / "reference-freeze-calibration.json")})
        repo, work = self.copies()
        second = self.rows[1]["id"]
        self.refused(repo, work, [self.votes(work, OPUS, cli="claude", unsupported=[first]), self.votes(work, GEMINI, unsupported=[second])], "method stopped")

    def test_a_stopped_check_opens_one_correction_round_whose_new_freeze_draws_a_fresh_sample(self):
        repo, work = self.copies()
        with self.assertRaises(SystemExit) as caught:
            self.run_script("open-correction-round", repo, work)
        self.assertIn("no citation-check.json", str(caught.exception))
        self.imported(repo, work, self.votes(work, OPUS, cli="claude"), self.votes(work, GEMINI))
        with self.assertRaises(SystemExit) as caught:
            self.run_script("open-correction-round", repo, work)
        self.assertIn("did not stop the method", str(caught.exception))
        repo, work = self.copies()
        first, second = self.rows[0]["id"], self.rows[1]["id"]
        self.refused(repo, work, [self.votes(work, OPUS, cli="claude", unsupported=[first]), self.votes(work, GEMINI, unsupported=[second])], "method stopped")
        old_freeze = sha(work / "reference-freeze-calibration.json")
        self.run_script("open-correction-round", repo, work)
        archive = work / "calibration-correction-1"
        self.assertEqual(sorted(p.name for p in archive.iterdir()), sorted(["reference-freeze-calibration.json", "citation-check.json", votes_file(OPUS), votes_file(GEMINI)]))
        self.assertEqual(sha(archive / "reference-freeze-calibration.json"), old_freeze)
        self.assertFalse((work / "reference-freeze-calibration.json").exists())
        quiet(repo, "freeze-reference", "--work", str(work), "--batch", "calibration", "--without-flaggers", "agy quota", "--today", TODAY)
        self.assertEqual(json.loads((work / "reference-freeze-calibration.json").read_text())["correction"], 1)
        labels = json.loads((work / "calibration-labels.json").read_text())["rows"]
        fresh = drawn(SWEEP, labels, "verify-2")
        self.assertNotEqual([r["id"] for r in fresh], [r["id"] for r in self.rows])
        self.assertEqual([r["id"] for r, _ in checker_prompts(load_topic(repo, "demo"), repo, work, FakeFetch())], [r["id"] for r in fresh])
        self.rows = fresh
        self.imported(repo, work, self.votes(work, OPUS, cli="claude"), self.votes(work, GEMINI))
        self.assertEqual(require_frozen(load_topic(repo, "demo"), work, ("calibration",)), {"calibration": sha(work / "reference-freeze-calibration.json")})
        self.refused(repo, work, [self.votes(work, OPUS, cli="claude"), self.votes(work, GEMINI)], "already exists")
        (work / "citation-check.json").write_text(json.dumps({**json.loads((work / "citation-check.json").read_text()), "stopped": True}))
        with self.assertRaises(SystemExit) as caught:
            self.run_script("open-correction-round", repo, work)
        self.assertIn("calibration-correction-1 exists; a batch gets one correction round", str(caught.exception))

    def test_votes_from_the_reference_from_one_model_twice_from_another_freeze_or_with_a_row_missing_are_refused(self):
        repo, work = self.copies()
        opus, gemini = self.votes(work, OPUS, cli="claude"), self.votes(work, GEMINI)
        self.refused(repo, work, [opus], "two or three checkers")
        self.refused(repo, work, [opus, gemini, gemini], "different models")
        fable_votes = self.votes(work, "claude-fable-5-1", cli="claude")
        self.refused(repo, work, [opus, gemini, fable_votes], "claude-fable-5-1 is the reference")
        self.refused(repo, work, [opus, gemini, self.votes(work, GPT_OSS, freeze_sha256="f" * 64)], "votes were saved for another freeze")
        missing = self.votes(work, GPT_OSS)
        saved = json.loads(missing.read_text())
        saved["refused"] = {self.rows[0]["id"]: "malformed"}
        del saved["votes"][self.rows[0]["id"]]
        missing.write_text(json.dumps(saved))
        self.refused(repo, work, [opus, gemini, missing], f"{GPT_OSS} has no vote on {self.rows[0]['id']}")
        self.assertFalse((work / "citation-check.json").exists())


if __name__ == "__main__":
    unittest.main()
