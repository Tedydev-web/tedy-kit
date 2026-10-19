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
CRITERIA = "docs/prior-art/quality-criteria-v2.md"
SESSIONS = {"A": {"cli": "claude", "model": "claude-opus-5-5", "effort": "high"},
            "B": {"cli": "agy", "model": "gemini-3.8-flash-high", "fallback": {"cli": "claude", "model": "claude-sonnet-4-6", "effort": "high"},
                  "pilot_also": [{"cli": "agy", "model": "gpt-oss-120b-medium"}]}}


def scores(value):
    return {c: {"v": value, "why": "w"} for c in ("Authority", "Methodology", "Objectivity", "Date", "Position", "Novelty", "Relevance")}


def reply_row(rank, repo, value=1, mechanisms=("gate",)):
    return json.dumps({"order_rank": rank, "repo": repo, "file": "skills/tdd/SKILL.md", "scores": scores(value), "mechanisms": list(mechanisms), "new": True, "decision": "eligible", "note": ""})


def claude_reply(text, models=("claude-opus-5-5",), turns=1, denials=()):
    return json.dumps({"type": "result", "is_error": False, "num_turns": turns, "permission_denials": list(denials), "result": text, "modelUsage": {m: {} for m in models}})


def agy_reply(text, denied=None):
    return json.dumps({"status": "SUCCESS", "num_turns": 1, "response": text, **({"denied_actions": denied} if denied else {})})


class SessionBase(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo(strata={"config": {"stop_row": None, "forced_repos": [], "channels": {}}, "local": {"stop_row": None, "forced_repos": []}})
        self.work = Path(tempfile.mkdtemp(prefix="study-sessions-"))
        for path in (self.repo, self.work):
            self.addCleanup(shutil.rmtree, path)
        self.write_topic(SESSIONS)
        write_jsonl(self.work / "config-screening-order.jsonl", [{"order_rank": 1, "repo": "o/one", "forced": False}, {"order_rank": 2, "repo": "o/two", "forced": False}])
        write_jsonl(self.work / "config-screening-inputs.jsonl", [{"order_rank": r, "repo": f"o/{n}", "sha": SHA, "facts": {}, "listing": [], "readme": "write the failing test first",
                                                                   "files": []} for r, n in ((1, "one"), (2, "two"))])
        (self.work / "screening-packet-config.md").write_text("# packet\n")

    def write_topic(self, sessions):
        topic = json.loads((self.repo / "docs/prior-art/topics/demo.json").read_text())
        write_json(self.repo / "docs/prior-art/topics/demo.json", {**topic, "pilot_rows": 1, "sessions": sessions})

    def run_session(self, fetch, *args, which=lambda cli: True):
        return script("run-screening-session").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--stratum", "config", *args, "--today", "2026-10-20"],
                                                    fetch=fetch, which=which)

    def pilot(self, fetch, side="A", ranks="1-1", *extra, which=lambda cli: True):
        return self.run_session(fetch, "--side", side, "--ranks", ranks, "--pilot", "--criteria", CRITERIA, *extra, which=which)

    def meta(self):
        return json.loads((self.work / "meta.json").read_text())["sessions"]

    def freeze(self, packet=None):
        packet_sha = hashlib.sha256((self.work / "screening-packet-config.md").read_bytes()).hexdigest()
        criteria_sha = hashlib.sha256((self.repo / CRITERIA).read_bytes()).hexdigest()
        write_json(self.work / "protocol-freeze.json", {"criteria": CRITERIA, "session_a": SESSIONS["A"], "session_b": {"chosen": {"cli": "agy", "model": "gemini-3.8-flash-high"}},
                                                         "strata": {"config": {"frozen_after_rank": 1, "packet_sha256": packet or packet_sha, "criteria_sha256": criteria_sha}}})


class IsolationTest(SessionBase):
    def test_claude_runs_bare_with_no_tools_settings_or_mcp_in_an_empty_folder_that_is_removed(self):
        fetch = FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))])
        self.pilot(fetch)
        [index] = [i for i, c in enumerate(fetch.calls) if c.startswith("claude -p")]
        cwd = fetch.cwds[index]
        self.assertIsNotNone(cwd)
        self.assertNotEqual(Path(cwd), self.work)
        self.assertFalse(Path(cwd).exists())
        self.assertTrue(fetch.calls[index].endswith("--model claude-opus-5-5 --effort high --output-format json --bare --tools  --setting-sources  --strict-mcp-config "
                                                    "--no-session-persistence --disable-slash-commands --max-turns 1"))
        self.assertIn("claude --version", fetch.calls)

    def test_agy_runs_without_effort_or_slash_commands_in_an_empty_folder(self):
        fetch = FakeFetch([("agy --model", agy_reply(reply_row(1, "o/one")))])
        self.pilot(fetch, "B")
        [call] = fetch.called("agy --model")
        self.assertTrue(call.startswith("agy --model gemini-3.8-flash-high --output-format json --print-timeout 600s --disable-slash-commands --print "))
        self.assertIsNotNone(fetch.cwds[fetch.calls.index(call)])

    def test_a_session_that_writes_into_its_folder_is_refused(self):
        class Writer(FakeFetch):
            def run(self, cmd, timeout=180, cwd=None):
                if cwd:
                    (Path(cwd) / "notes.txt").write_text("x")
                return super().run(cmd, timeout, cwd)

        with self.assertRaises(SystemExit) as raised:
            self.pilot(Writer([("claude -p", claude_reply(reply_row(1, "o/one")))]))
        self.assertIn("wrote ['notes.txt']", str(raised.exception))
        self.assertFalse((self.work / "config-pilot-A.jsonl").exists())

    def test_the_network_guard_stops_both_clis_even_when_they_are_on_path(self):
        bin_dir = Path(tempfile.mkdtemp(prefix="fake-cli-"))
        self.addCleanup(shutil.rmtree, bin_dir)
        for cli in ("claude", "agy"):
            (bin_dir / cli).write_text(f"#!/bin/sh\ntouch {bin_dir}/{cli}-ran\n")
            (bin_dir / cli).chmod(0o755)
        for side in "AB":
            result = subprocess.run([sys.executable, "-B", str(HERE / "run-screening-session.py"), "--topic", "demo", "--repo", str(self.repo), "--work", str(self.work),
                                     "--stratum", "config", "--side", side, "--ranks", "1-1", "--pilot", "--criteria", CRITERIA],
                                    capture_output=True, text=True, env={**os.environ, "STUDY_NO_NETWORK": "1", "PATH": str(bin_dir)})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("STUDY_NO_NETWORK is set", result.stderr)
        self.assertEqual(sorted(p.name for p in bin_dir.iterdir()), ["agy", "claude"])


class BlockRecordTest(SessionBase):
    def test_every_block_keeps_its_own_hashes_and_the_session_header_is_shared(self):
        fetch = FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))])
        self.pilot(fetch, "A", "1-1")
        fetch.rules = [("claude -p", claude_reply(reply_row(2, "o/two")))]
        self.pilot(fetch, "A", "2-2")
        entry = self.meta()["config-pilot-A"]
        self.assertEqual({k: entry.get(k) for k in ("cli", "model", "effort", "cli_version")}, {"cli": "claude", "model": "claude-opus-5-5", "effort": "high", "cli_version": "unknown"})
        self.assertEqual([b["ranks"] for b in entry.get("blocks", [])], [[1], [2]])
        rows = [json.loads(line) for line in (self.work / "config-screening-inputs.jsonl").read_text().splitlines()]
        canonical = lambda value: hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(entry["blocks"][1]["inputs_sha256"], canonical([rows[1]]))
        self.assertEqual(entry["blocks"][1]["row_sha256"], {"2": canonical(rows[1])})
        self.assertEqual(entry["blocks"][0]["packet_sha256"], hashlib.sha256(b"# packet\n").hexdigest())
        self.assertEqual(entry["blocks"][0]["criteria_sha256"], hashlib.sha256((self.repo / CRITERIA).read_bytes()).hexdigest())
        self.assertEqual(entry["blocks"][0]["served_models"], ["claude-opus-5-5"])

    def test_a_block_with_another_model_setting_is_refused_before_any_call(self):
        self.pilot(FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))]))
        self.write_topic({**SESSIONS, "A": {**SESSIONS["A"], "effort": "low"}})
        fetch = FakeFetch()
        with self.assertRaises(SystemExit) as raised:
            self.pilot(fetch, "A", "2-2")
        self.assertIn("ran with effort 'high'", str(raised.exception))
        self.assertEqual(fetch.called("claude -p"), [])

    def test_parallel_sessions_never_lose_each_others_meta_entries(self):
        import threading
        from study_session import update_sessions
        threads = [threading.Thread(target=lambda key=f"config-{i}": update_sessions(self.work, lambda sessions: sessions.update({key: {"blocks": []}}))) for i in range(40)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(self.meta()), 40)
        self.assertEqual(sorted(p.name for p in self.work.glob("meta.json*.tmp")), [])

    def test_claude_without_effort_records_the_default(self):
        self.write_topic({**SESSIONS, "A": {"cli": "claude", "model": "claude-opus-5-5"}})
        self.pilot(FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))]))
        self.assertEqual(self.meta()["config-pilot-A"]["effort"], "default")

    def test_agy_options_with_an_effort_are_refused(self):
        self.write_topic({**SESSIONS, "B": {**SESSIONS["B"], "effort": "high"}})
        with self.assertRaises(SystemExit) as raised:
            self.pilot(FakeFetch(), "B")
        self.assertIn("agy takes no effort", str(raised.exception))


class PilotAndFreezeRunTest(SessionBase):
    def test_the_pilot_runs_one_session_b_option_per_invocation(self):
        fetch = FakeFetch([("agy --model gemini", agy_reply(reply_row(1, "o/one"))), ("agy --model gpt-oss", agy_reply(reply_row(1, "o/one", 0, [])))])
        self.pilot(fetch, "B")
        self.assertEqual(len(fetch.called("agy --model")), 1)
        self.pilot(fetch, "B", "1-1", "--model", "gpt-oss-120b-medium")
        self.assertTrue((self.work / "config-pilot-B-gpt-oss-120b-medium.jsonl").is_file())
        with self.assertRaises(SystemExit) as raised:
            self.pilot(fetch, "B", "1-1", "--model", "o3")
        self.assertIn("o3 is not session B", str(raised.exception))

    def test_without_agy_on_path_session_b_falls_back_to_another_claude_tier(self):
        fetch = FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one"), ("claude-sonnet-4-6",)))])
        self.pilot(fetch, "B", which=lambda cli: cli != "agy")
        self.assertEqual(fetch.called("agy"), [])
        self.assertTrue((self.work / "config-pilot-B-claude-sonnet-4-6.jsonl").is_file())

    def test_after_the_freeze_both_sessions_come_from_the_freeze_not_the_live_config(self):
        self.freeze()
        self.write_topic({**SESSIONS, "A": {"cli": "claude", "model": "claude-haiku-4-5"}})
        fetch = FakeFetch([("claude -p", claude_reply(reply_row(2, "o/two"))), ("agy --model gemini", agy_reply(reply_row(2, "o/two")))])
        self.run_session(fetch, "--side", "A", "--ranks", "2-2")
        self.run_session(fetch, "--side", "B", "--ranks", "2-2")
        self.assertEqual(self.meta()["config-A"]["model"], "claude-opus-5-5")
        self.assertEqual(json.loads((self.work / "config-screen-B.jsonl").read_text())["sha"], SHA)

    def test_a_changed_packet_after_the_freeze_is_refused_before_any_call(self):
        self.freeze(packet="0" * 64)
        fetch = FakeFetch()
        with self.assertRaises(SystemExit) as raised:
            self.run_session(fetch, "--side", "A", "--ranks", "2-2")
        self.assertIn("differ from the freeze", str(raised.exception))
        self.assertEqual(fetch.calls, [])

    def test_a_screen_session_before_the_freeze_is_refused(self):
        with self.assertRaises(SystemExit) as raised:
            self.run_session(FakeFetch(), "--side", "A", "--ranks", "1-1")
        self.assertIn("freeze the protocol", str(raised.exception))

    def test_a_reply_missing_a_row_is_kept_aside_and_nothing_is_written(self):
        with self.assertRaises(SystemExit) as raised:
            self.pilot(FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))]), "A", "1-2")
        self.assertIn("rank 2", str(raised.exception))
        self.assertFalse((self.work / "config-pilot-A.jsonl").exists())
        self.assertTrue(list((self.work / "prompts").glob("*.response.txt")))

    def test_a_prompt_over_the_argument_limit_is_refused(self):
        (self.work / "screening-packet-config.md").write_text("p" * 130000)
        with self.assertRaises(SystemExit) as raised:
            self.pilot(FakeFetch())
        self.assertIn("smaller block", str(raised.exception))

    def test_a_tag_only_stratum_gets_no_inputs_and_no_sessions(self):
        with self.assertRaises(SystemExit) as raised:
            script("fetch-screening-inputs").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--stratum", "local"], fetch=FakeFetch())
        self.assertIn("local is tag-only", str(raised.exception))
        with self.assertRaises(SystemExit) as raised:
            script("run-screening-session").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--stratum", "local", "--side", "A", "--ranks", "1-1",
                                                  "--pilot", "--criteria", CRITERIA], fetch=FakeFetch())
        self.assertIn("local is tag-only", str(raised.exception))

    def test_model_families_come_from_the_model_id(self):
        family = script("run-screening-session").model_family
        self.assertEqual([family(m) for m in ("claude-opus-5-5", "gemini-3.8-flash-high", "gpt-oss-120b-medium", "o3")], ["claude", "gemini", "gpt", "o3"])

    def test_the_canon_topic_fixes_session_b_and_names_its_fallback(self):
        from study_topic import pilot_rows, session_a, session_b
        canon = load_topic(HERE.parents[3], "canon")
        primary, fallback, also = session_b(canon)
        self.assertEqual((pilot_rows(canon), session_a(canon)["cli"], primary["model"], fallback["model"], [o["model"] for o in also]),
                         (20, "claude", "gemini-3.8-flash-high", "claude-sonnet-4-6", ["gpt-oss-120b-medium"]))
        self.assertEqual({s: r["stop_row"] for s, r in canon["strata"].items()}, {"config": None, "product": None, "local": None})

    def test_a_session_option_without_a_cli_is_refused(self):
        from study_topic import session_a
        with self.assertRaisesRegex(TopicError, "sessions.A needs a cli"):
            session_a({**load_topic(self.repo, "demo"), "sessions": {"A": {"model": "x"}}})


if __name__ == "__main__":
    unittest.main()
