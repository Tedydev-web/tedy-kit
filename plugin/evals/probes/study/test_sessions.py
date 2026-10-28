import hashlib
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from study_fixtures import HERE, FakeFetch, script, topic_repo, write_json, write_jsonl
from study_judges import run_name
from study_session_prompt import TEMPLATE_SHA256
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


def agy_reply(text):
    events = [{"event": "init", "init": {"model": "gemini-3.8-flash-high"}}, {"event": "step_update", "step_update": {"step_index": 1, "step_type": "agent_response", "state": "DONE"}},
              {"event": "result", "result": {"status": "SUCCESS", "num_turns": 1, "response": text}}]
    return "".join(json.dumps(e) + "\n" for e in events)


class ArgvFetch(FakeFetch):
    def __init__(self, rules=()):
        super().__init__(rules)
        self.argvs = []

    def run(self, cmd, timeout=180, cwd=None):
        self.argvs.append(list(cmd))
        return super().run(cmd, timeout, cwd)


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

    def run_session(self, fetch, *args, which=lambda cli: True, environ=None):
        return script("run-screening-session").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--stratum", "config", *args, "--today", "2026-10-20"],
                                                    fetch=fetch, which=which, environ=environ if environ is not None else {"ANTHROPIC_API_KEY": "stub"})

    def pilot(self, fetch, side="A", ranks="1-1", *extra, which=lambda cli: True, environ=None):
        return self.run_session(fetch, "--side", side, "--ranks", ranks, "--pilot", "--criteria", CRITERIA, *extra, which=which, environ=environ)

    def meta(self):
        return json.loads((self.work / "meta.json").read_text())["sessions"]

    def freeze(self, packet=None, template=None):
        packet_sha = hashlib.sha256((self.work / "screening-packet-config.md").read_bytes()).hexdigest()
        criteria_sha = hashlib.sha256((self.repo / CRITERIA).read_bytes()).hexdigest()
        write_json(self.work / "protocol-freeze.json", {"criteria": CRITERIA, "session_a": SESSIONS["A"], "session_b": {"chosen": {"cli": "agy", "model": "gemini-3.8-flash-high"}},
                                                         "strata": {"config": {"frozen_after_rank": 1, "packet_sha256": packet or packet_sha, "criteria_sha256": criteria_sha,
                                                                               "template_sha256": template or TEMPLATE_SHA256}}})


class BlockRecordTest(SessionBase):
    def test_every_block_keeps_its_own_hashes_and_the_session_header_is_shared(self):
        fetch = FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))])
        self.pilot(fetch, "A", "1-1")
        fetch.rules = [("claude -p", claude_reply(reply_row(2, "o/two")))]
        self.pilot(fetch, "A", "2-2")
        entry = self.meta()["config-pilot-A"]
        self.assertEqual({k: entry.get(k) for k in ("cli", "model", "effort", "cli_version")}, {"cli": "claude", "model": "claude-opus-5-5", "effort": "high", "cli_version": None})
        self.assertEqual([b["cli_version"] for b in entry["blocks"]], ["unknown", "unknown"])
        self.assertEqual(len({b["prompt_sha256"] for b in entry["blocks"]}), 2)
        self.assertEqual([b["ranks"] for b in entry.get("blocks", [])], [[1], [2]])
        rows = [json.loads(line) for line in (self.work / "config-screening-inputs.jsonl").read_text().splitlines()]
        canonical = lambda value: hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(entry["blocks"][1]["inputs_sha256"], canonical([rows[1]]))
        self.assertEqual(entry["blocks"][1]["row_sha256"], {"2": canonical(rows[1])})
        self.assertEqual(entry["blocks"][0]["packet_sha256"], hashlib.sha256(b"# packet\n").hexdigest())
        self.assertEqual(entry["blocks"][0]["criteria_sha256"], hashlib.sha256((self.repo / CRITERIA).read_bytes()).hexdigest())
        self.assertEqual(entry["blocks"][0]["served_models"], ["claude-opus-5-5"])

    def test_a_cli_version_change_between_blocks_is_kept_per_block(self):
        fetch = FakeFetch([("claude --version", "2.1.303 (Claude Code)\n"), ("claude -p", claude_reply(reply_row(1, "o/one")))])
        self.pilot(fetch, "A", "1-1")
        fetch.rules = [("claude --version", "2.1.304 (Claude Code)\n"), ("claude -p", claude_reply(reply_row(2, "o/two")))]
        self.pilot(fetch, "A", "2-2")
        self.assertEqual([b["cli_version"] for b in self.meta()["config-pilot-A"]["blocks"]], ["2.1.303 (Claude Code)", "2.1.304 (Claude Code)"])

    def test_a_block_with_another_model_setting_is_refused_before_any_call(self):
        self.pilot(FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))]))
        self.write_topic({**SESSIONS, "A": {**SESSIONS["A"], "effort": "low"}})
        fetch = FakeFetch()
        with self.assertRaises(SystemExit) as raised:
            self.pilot(fetch, "A", "2-2")
        self.assertIn("ran with effort 'high'", str(raised.exception))
        self.assertEqual(fetch.called("claude -p"), [])

    def test_a_session_whose_blocks_were_all_dropped_runs_again_under_new_settings(self):
        self.pilot(FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))]))
        script("drop-run").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--key", "config-pilot-A", "--ranks", "1-1",
                                 "--reason", "settings changed", "--today", "2026-10-20"])
        self.write_topic({**SESSIONS, "A": {**SESSIONS["A"], "effort": "low"}})
        write_jsonl(self.work / "config-screening-inputs.jsonl", [{"order_rank": 1, "repo": "o/one", "sha": SHA, "facts": {}, "listing": [], "readme": "x", "files": []}])
        self.pilot(FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))]), "A", "1-1")
        entry = self.meta()["config-pilot-A"]
        self.assertEqual((entry["effort"], [b["ranks"] for b in entry["blocks"]]), ("low", [[1]]))

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


class ApertureSessionTest(SessionBase):
    DEEPSEEK = {"cli": "aperture", "model": "deepseek/deepseek-v4.1-flash"}

    def completion(self, text):
        return json.dumps({"model": self.DEEPSEEK["model"], "choices": [{"message": {"role": "assistant", "content": text}}], "usage": {"prompt_tokens": 9, "completion_tokens": 3}})

    def test_session_a_on_aperture_posts_one_chat_completion_to_the_endpoint_given_on_the_command_line(self):
        self.write_topic({**SESSIONS, "A": self.DEEPSEEK})
        models = json.dumps({"data": [{"id": self.DEEPSEEK["model"]}]})
        fetch = FakeFetch([("/v1/models", models), ("--data-binary", self.completion(reply_row(1, "o/one")))])
        self.pilot(fetch, "A", "1-1", "--endpoint", "http://100.127.1.240", which=lambda cli: cli == "curl")
        self.assertTrue((self.work / "config-pilot-A.jsonl").is_file())
        self.assertIn("http://100.127.1.240/v1/chat/completions", fetch.called("--data-binary")[0])
        self.assertEqual((self.meta()["config-pilot-A"]["cli"], self.meta()["config-pilot-A"]["model"]), ("aperture", self.DEEPSEEK["model"]))
        with self.assertRaises(SystemExit) as raised:
            self.pilot(FakeFetch(), "A")
        self.assertIn("--endpoint names the Aperture URL", str(raised.exception))
        with self.assertRaises(SystemExit) as raised:
            self.pilot(FakeFetch(), "B", "1-1", "--endpoint", "http://100.127.1.240")
        self.assertIn("--endpoint names the Aperture URL", str(raised.exception))

    def test_a_model_id_with_a_slash_names_one_file(self):
        self.assertEqual(run_name("config", "qgs-A", self.DEEPSEEK, 1), "judge-config-qgs-A-deepseek--deepseek-v4.1-flash-run1")


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
        self.assertEqual(self.meta()["config-pilot-B-claude-sonnet-4-6"]["blocks"][0]["fallback_reason"], "agy was not on PATH when this pilot ran")

    def test_the_fallback_is_refused_while_the_primary_cli_is_on_path(self):
        fetch = FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one"), ("claude-sonnet-4-6",)))])
        with self.assertRaises(SystemExit) as raised:
            self.pilot(fetch, "B", "1-1", "--model", "claude-sonnet-4-6")
        self.assertIn("agy is on PATH, so session B is gemini-3.8-flash-high; the fallback runs only without it", str(raised.exception))
        self.freeze()
        freeze = json.loads((self.work / "protocol-freeze.json").read_text())
        freeze["session_b"] = {"chosen": SESSIONS["B"]["fallback"], "primary": {"cli": "agy", "model": "gemini-3.8-flash-high"}}
        write_json(self.work / "protocol-freeze.json", freeze)
        with self.assertRaises(SystemExit) as raised:
            self.run_session(fetch, "--side", "B", "--ranks", "2-2")
        self.assertIn("agy is now on PATH; the frozen session B stays the fallback", str(raised.exception))
        self.assertEqual(fetch.called("claude -p"), [])

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

    def test_a_block_with_a_transient_fetch_error_is_refused_and_a_permanent_one_is_coded_dead(self):
        inputs = self.work / "config-screening-inputs.jsonl"
        rows = [json.loads(line) for line in inputs.read_text().splitlines()]
        rows[1].update({"error": "tree: exit 1: HTTP 502", "error_kind": "transient"})
        write_jsonl(inputs, rows)
        fetch = FakeFetch()
        with self.assertRaises(SystemExit) as raised:
            self.pilot(fetch, "A", "1-2")
        self.assertIn("rank 2 has a transient fetch error (tree: exit 1: HTTP 502); run fetch-screening-inputs.py again, or mark it permanent with --mark-permanent "
                      "only if a check by hand finds the repository or commit gone", str(raised.exception))
        self.assertEqual(fetch.called("claude -p"), [])
        rows[1].update({"error": "npm: exit 6: Could not resolve host", "error_kind": "transient"})
        write_jsonl(inputs, rows)
        with self.assertRaises(SystemExit) as raised:
            self.pilot(fetch, "A", "1-2")
        self.assertIn("rank 2 has a transient fetch error (npm: exit 6: Could not resolve host); run fetch-screening-inputs.py again", str(raised.exception))
        self.assertNotIn("--mark-permanent", str(raised.exception))
        rows[1].update({"error": "commit: exit 1: HTTP 404", "error_kind": "permanent"})
        write_jsonl(inputs, rows)
        fetch = FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one") + "\n" + reply_row(2, "o/two")))])
        self.pilot(fetch, "A", "1-2")
        self.assertIn("A row whose error_kind is permanent", fetch.called("claude -p")[0])

    def test_a_prompt_over_the_argument_limit_is_refused(self):
        (self.work / "screening-packet-config.md").write_text("p" * 130000)
        with self.assertRaises(SystemExit) as raised:
            self.pilot(FakeFetch())
        self.assertIn("smaller block", str(raised.exception))

    def test_a_claude_block_sends_the_packet_and_criteria_as_the_cached_system_prompt(self):
        fetch = ArgvFetch([("claude -p", claude_reply(reply_row(1, "o/one")))])
        self.pilot(fetch, "A", "1-1")
        argv = [a for a in fetch.argvs if a[:2] == ["claude", "-p"]][0]
        head, own = argv[:argv.index("--")], argv[-1]
        system = head[-1]
        self.assertEqual(head[-3:-1], ["--exclude-dynamic-system-prompt-sections", "--append-system-prompt"])
        self.assertTrue(system.startswith("# packet") and f"## Criteria ({CRITERIA})" in system and "## Rows" not in system)
        self.assertTrue(own.startswith("## Your mechanism names so far") and '"o/one"' in own)
        self.assertEqual((self.work / "prompts/config-pilot-A-1-1.md").read_text(), system + "\n\n" + own)
        self.assertIn("--append-system-prompt <the packet and the criteria>; empty temporary working folder; stdin closed", self.meta()["config-pilot-A"]["isolation"])

    def test_a_block_whose_parts_each_fit_one_argument_runs_though_the_whole_prompt_does_not(self):
        (self.work / "screening-packet-config.md").write_text("p" * 70000)
        write_jsonl(self.work / "config-screening-inputs.jsonl", [{"order_rank": 1, "repo": "o/one", "sha": SHA, "facts": {}, "listing": [], "readme": "r" * 70000, "files": []}])
        self.pilot(FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))]), "A", "1-1")
        self.assertEqual(len((self.work / "config-pilot-A.jsonl").read_text().splitlines()), 1)
        self.assertGreater(len((self.work / "prompts/config-pilot-A-1-1.md").read_bytes()), 120000)

    def test_an_agy_block_still_sends_one_prompt_under_the_argument_limit(self):
        (self.work / "screening-packet-config.md").write_text("p" * 70000)
        write_jsonl(self.work / "config-screening-inputs.jsonl", [{"order_rank": 1, "repo": "o/one", "sha": SHA, "facts": {}, "listing": [], "readme": "r" * 70000, "files": []}])
        with self.assertRaises(SystemExit) as raised:
            self.pilot(FakeFetch(), "B", "1-1", "--model", "gemini-3.8-flash-high")
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

    def test_the_canon_topic_names_its_roster_the_reference_substitute_and_the_cross_family_model(self):
        from study_judges import reader_shares_family, roster
        from study_qgs import cross_family
        from study_topic import pilot_rows, reference_substitute, session_a, session_b
        canon = load_topic(HERE.parents[3], "canon")
        primary, fallback, also = session_b(canon)
        self.assertEqual((pilot_rows(canon), session_a(canon)["model"], primary["model"], fallback, also),
                         (20, "deepseek/deepseek-v4.1-flash", "claude-sonnet-5-5", None, []))
        self.assertEqual({j: (o["cli"], o["model"]) for j, o in roster(canon).items()},
                         {"qgs-A": ("aperture", "deepseek/deepseek-v4.1-flash"), "qgs-B": ("claude", "claude-sonnet-5-5"), "reader": ("aperture", "deepseek/deepseek-v4.1-flash")})
        self.assertEqual(reference_substitute(canon), {"cli": "claude", "model": "claude-opus-5-5", "effort": "xhigh"})
        self.assertEqual((cross_family(canon)["model"], reader_shares_family(canon)), ("gemini-3.8-flash-high", False))
        self.assertEqual({s: r["stop_row"] for s, r in canon["strata"].items()}, {"config": None, "product": None, "local": None})
        from datetime import date
        from study_session_prompt import sweep_date
        self.assertEqual(sweep_date(canon), date(2026, 10, 21))

    def test_a_session_option_without_a_cli_is_refused(self):
        from study_topic import session_a
        with self.assertRaisesRegex(TopicError, "sessions.A needs a cli"):
            session_a({**load_topic(self.repo, "demo"), "sessions": {"A": {"model": "x"}}})


if __name__ == "__main__":
    unittest.main()
