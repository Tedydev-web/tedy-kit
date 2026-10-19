import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from study_fixtures import HERE, FakeFetch, script, topic_repo, write_json, write_jsonl
from study_topic import TopicError, load_topic

SHA = "c" * 40
SESSIONS = {"A": {"cli": "claude", "model": "claude-opus-5-5", "effort": "high"},
            "B": {"candidates": [{"cli": "agy", "model": "gemini-3.8-flash-high"}, {"cli": "agy", "model": "gpt-oss-120b-medium"}],
                  "fallback": {"cli": "claude", "model": "claude-sonnet-4-6", "effort": "high"}}}


def scores(value):
    return {c: {"v": value, "why": "w"} for c in ("Authority", "Methodology", "Objectivity", "Date", "Position", "Novelty", "Relevance")}


def reply_row(rank, repo, value=1, mechanisms=("gate",)):
    return json.dumps({"order_rank": rank, "repo": repo, "file": "skills/tdd/SKILL.md", "scores": scores(value), "mechanisms": list(mechanisms), "new": True, "decision": "eligible", "note": ""})


def claude_reply(text, models=("claude-opus-5-5",)):
    return json.dumps({"type": "result", "is_error": False, "result": text, "modelUsage": {m: {} for m in models}})


def agy_reply(text):
    return json.dumps({"status": "SUCCESS", "response": text})


class SessionBase(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo(strata={"config": {"stop_row": None, "forced_repos": []}})
        self.work = Path(tempfile.mkdtemp(prefix="study-sessions-"))
        for path in (self.repo, self.work):
            self.addCleanup(shutil.rmtree, path)
        topic = json.loads((self.repo / "docs/prior-art/topics/demo.json").read_text())
        write_json(self.repo / "docs/prior-art/topics/demo.json", {**topic, "pilot_rows": 1, "sessions": SESSIONS})
        self.topic = load_topic(self.repo, "demo")
        write_jsonl(self.work / "config-screening-order.jsonl", [{"order_rank": 1, "repo": "o/one", "units": ["skills/tdd"], "stars": 3, "pushed": "2026-09-01", "forced": False},
                                                                 {"order_rank": 2, "repo": "o/two", "contract_files": ["src/hook.ts"], "forced": False}])
        write_json(self.work / "cache/trees/o__one.json", {"oid": SHA, "paths": ["README.md", "skills/tdd/SKILL.md", "skills/tdd/notes.txt", "skills/docs/SKILL.md", "package.json"]})
        (self.work / "screening-packet-config.md").write_text("# packet\n")
        self.packet_sha = hashlib.sha256(b"# packet\n").hexdigest()

    def inputs(self):
        fetch = FakeFetch([("repos/o/two/commits/HEAD", "d" * 40 + "\n"), ("repos/o/two/git/trees/", json.dumps({"tree": [{"path": "src/hook.ts"}, {"path": "readme.md"}]})),
                           ("contents/skills/tdd/SKILL.md?ref=" + SHA, "write the failing test first"), ("contents/README.md", "# one"),
                           ("contents/src/hook.ts", "x" * 9000), ("contents/readme.md", "# two")])
        script("fetch-screening-inputs").fetch_inputs(self.topic, self.work, "config", 200, fetch)
        return fetch

    def run_session(self, fetch, *args, which=lambda cli: True):
        return script("run-screening-session").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--stratum", "config", *args], fetch=fetch, which=which)


class InputsTest(SessionBase):
    def test_inputs_pin_the_commit_and_carry_the_unit_files_readme_and_listing(self):
        fetch = self.inputs()
        rows = {r["order_rank"]: r for r in map(json.loads, (self.work / "config-screening-inputs.jsonl").read_text().splitlines())}
        self.assertEqual(rows[1]["sha"], SHA)
        self.assertEqual([(f["path"], f["text"], f["truncated"]) for f in rows[1]["files"]], [("skills/tdd/SKILL.md", "write the failing test first", False), ("skills/tdd/notes.txt", "", False)])
        self.assertEqual((rows[1]["readme"], rows[1]["listing"], rows[1]["facts"]["stars"]), ("# one", ["README.md", "package.json", "skills"], 3))
        self.assertEqual((rows[2]["sha"], rows[2]["files"][0]["path"], len(rows[2]["files"][0]["text"]), rows[2]["files"][0]["truncated"]), ("d" * 40, "src/hook.ts", 8000, True))
        again = FakeFetch()
        script("fetch-screening-inputs").fetch_inputs(self.topic, self.work, "config", 200, again)
        self.assertEqual(again.calls, [])


class RunSessionTest(SessionBase):
    def test_session_a_scores_from_the_embedded_inputs_and_records_its_model_and_packet(self):
        self.inputs()
        fetch = FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one") + "\nmechanism: gate: blocks edits until a test fails\n"))])
        self.run_session(fetch, "--side", "A", "--ranks", "1-1", "--pilot", "--criteria", "docs/prior-art/quality-criteria-v2.md", "--today", "2026-10-20")
        [cmd] = fetch.called("claude -p")
        self.assertIn("# packet", cmd)
        self.assertIn("criteria", cmd)
        self.assertIn("write the failing test first", cmd)
        self.assertTrue(cmd.endswith("--model claude-opus-5-5 --effort high --output-format json --tools  --max-turns 1"))
        row = json.loads((self.work / "config-pilot-A.jsonl").read_text())
        self.assertEqual((row["order_rank"], row["sha"], row["mechanisms"]), (1, SHA, ["gate"]))
        self.assertEqual((self.work / "config-pilot-A-mechanisms.md").read_text(), "gate: blocks edits until a test fails\n")
        entry = json.loads((self.work / "meta.json").read_text())["sessions"]["config-pilot-A"]
        self.assertEqual({k: entry[k] for k in ("cli", "model", "effort", "packet_sha256", "date", "served_models")},
                         {"cli": "claude", "model": "claude-opus-5-5", "effort": "high", "packet_sha256": self.packet_sha, "date": "2026-10-20", "served_models": ["claude-opus-5-5"]})
        self.assertEqual(entry["inputs_sha256"], hashlib.sha256((self.work / "config-screening-inputs.jsonl").read_bytes()).hexdigest())

    def test_the_pilot_runs_every_reachable_session_b_candidate_on_agy_without_effort(self):
        self.inputs()
        fetch = FakeFetch([("agy --model gemini", agy_reply(reply_row(1, "o/one"))), ("agy --model gpt-oss", agy_reply(reply_row(1, "o/one", 0, [])))])
        self.run_session(fetch, "--side", "B", "--ranks", "1-1", "--pilot", "--criteria", "docs/prior-art/quality-criteria-v2.md")
        self.assertEqual([c.split(" --print ")[0] for c in fetch.called("agy")], ["agy --model gemini-3.8-flash-high --output-format json --print-timeout 600s",
                                                                                 "agy --model gpt-oss-120b-medium --output-format json --print-timeout 600s"])
        self.assertTrue((self.work / "config-pilot-B-gemini-3.8-flash-high.jsonl").is_file())
        self.assertEqual(json.loads((self.work / "config-pilot-B-gpt-oss-120b-medium.jsonl").read_text())["scores"]["Authority"]["v"], 0)
        sessions = json.loads((self.work / "meta.json").read_text())["sessions"]
        self.assertEqual(sessions["config-pilot-B-gemini-3.8-flash-high"]["effort"], "set by the model id")
        self.assertNotIn("served_models", sessions["config-pilot-B-gemini-3.8-flash-high"])

    def test_without_agy_on_path_session_b_falls_back_to_another_claude_tier(self):
        self.inputs()
        fetch = FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one"), ("claude-sonnet-4-6",)))])
        self.run_session(fetch, "--side", "B", "--ranks", "1-1", "--pilot", "--criteria", "docs/prior-art/quality-criteria-v2.md", which=lambda cli: cli != "agy")
        self.assertEqual(fetch.called("agy"), [])
        self.assertTrue((self.work / "config-pilot-B-claude-sonnet-4-6.jsonl").is_file())

    def test_after_the_freeze_session_b_runs_the_chosen_model_into_the_screen_file(self):
        self.inputs()
        write_json(self.work / "protocol-freeze.json", {"criteria": "docs/prior-art/quality-criteria-v2.md", "strata": {"config": {"frozen_after_rank": 1}},
                                                         "session_b": {"chosen": {"cli": "agy", "model": "gpt-oss-120b-medium"}}})
        fetch = FakeFetch([("agy --model gpt-oss", agy_reply(reply_row(2, "o/two")))])
        self.run_session(fetch, "--side", "B", "--ranks", "2-2")
        self.assertEqual(json.loads((self.work / "config-screen-B.jsonl").read_text())["sha"], "d" * 40)
        self.assertEqual(json.loads((self.work / "meta.json").read_text())["sessions"]["config-B"]["model"], "gpt-oss-120b-medium")

    def test_a_screen_session_before_the_freeze_is_refused(self):
        self.inputs()
        with self.assertRaises(SystemExit) as raised:
            self.run_session(FakeFetch(), "--side", "A", "--ranks", "1-1")
        self.assertIn("freeze the protocol", str(raised.exception))

    def test_a_reply_missing_a_row_is_kept_aside_and_nothing_is_written(self):
        self.inputs()
        fetch = FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))])
        with self.assertRaises(SystemExit) as raised:
            self.run_session(fetch, "--side", "A", "--ranks", "1-2", "--pilot", "--criteria", "docs/prior-art/quality-criteria-v2.md")
        self.assertIn("rank 2", str(raised.exception))
        self.assertFalse((self.work / "config-pilot-A.jsonl").exists())
        self.assertTrue(list((self.work / "prompts").glob("*.response.txt")))

    def test_a_prompt_over_the_argument_limit_is_refused(self):
        self.inputs()
        (self.work / "screening-packet-config.md").write_text("p" * 130000)
        with self.assertRaises(SystemExit) as raised:
            self.run_session(FakeFetch(), "--side", "A", "--ranks", "1-1", "--pilot", "--criteria", "docs/prior-art/quality-criteria-v2.md")
        self.assertIn("smaller block", str(raised.exception))

    def test_the_cli_runner_refuses_to_call_out_when_the_network_is_off(self):
        write_jsonl(self.work / "config-screening-inputs.jsonl", [{"order_rank": 1, "repo": "o/one", "sha": SHA, "facts": {}, "listing": [], "readme": "", "files": []}])
        result = subprocess.run([sys.executable, "-B", str(HERE / "run-screening-session.py"), "--topic", "demo", "--repo", str(self.repo), "--work", str(self.work),
                                 "--stratum", "config", "--side", "A", "--ranks", "1-1", "--pilot", "--criteria", "docs/prior-art/quality-criteria-v2.md"],
                                capture_output=True, text=True, env={**os.environ, "STUDY_NO_NETWORK": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("STUDY_NO_NETWORK is set", result.stderr)

    def test_model_families_come_from_the_model_id(self):
        family = script("run-screening-session").model_family
        self.assertEqual([family(m) for m in ("claude-opus-5-5", "gemini-3.8-flash-high", "gpt-oss-120b-medium", "o3")], ["claude", "gemini", "gpt", "o3"])

    def test_the_canon_topic_names_its_sessions_and_pilot_block(self):
        from study_topic import pilot_rows, session_a, session_b_options
        canon = load_topic(HERE.parents[3], "canon")
        self.assertEqual((pilot_rows(canon), session_a(canon)["cli"]), (20, "claude"))
        self.assertEqual([o["model"] for o in session_b_options(canon)], ["gemini-3.8-flash-high", "gpt-oss-120b-medium", "claude-sonnet-4-6"])
        self.assertEqual({s: r["stop_row"] for s, r in canon["strata"].items()}, {"config": None, "product": None, "local": None})

    def test_a_session_option_without_a_cli_is_refused(self):
        bad = {**self.topic, "sessions": {"A": {"model": "x"}}}
        from study_topic import session_a
        with self.assertRaisesRegex(TopicError, "sessions.A needs a cli"):
            session_a(bad)


if __name__ == "__main__":
    unittest.main()
