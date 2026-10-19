import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from study_fixtures import HERE, FakeFetch
from test_sessions import CRITERIA, SessionBase, agy_reply, claude_reply, reply_row


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

    def test_without_an_api_key_claude_runs_the_proven_flags_without_bare_and_records_the_threat(self):
        fetch = FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))])
        self.pilot(fetch, environ={"HOME": "/nowhere"})
        [call] = fetch.called("claude -p")
        self.assertNotIn("--bare", call)
        self.assertTrue(call.endswith("--output-format json --tools  --setting-sources  --strict-mcp-config --no-session-persistence --disable-slash-commands --max-turns 1"))
        entry = self.meta()["config-pilot-A"]
        self.assertEqual(entry.get("threats"), ["plugin hooks not excluded (no --bare)"])
        self.assertNotIn("--bare", entry["isolation"])

    def test_with_an_api_key_claude_runs_bare_and_records_no_threat(self):
        fetch = FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))])
        self.pilot(fetch, environ={"ANTHROPIC_API_KEY": "stub"})
        self.assertIn(" --bare ", fetch.called("claude -p")[0])
        self.assertEqual(self.meta()["config-pilot-A"].get("threats"), [])

    def test_agy_runs_without_effort_or_slash_commands_in_an_empty_folder(self):
        fetch = FakeFetch([("agy --model", agy_reply(reply_row(1, "o/one")))])
        self.pilot(fetch, "B")
        [call] = fetch.called("agy --model")
        self.assertTrue(call.startswith("agy --model gemini-3.8-flash-high --output-format stream-json --print-timeout 600s --disable-slash-commands --print "))
        self.assertIsNotNone(fetch.cwds[fetch.calls.index(call)])
        entry = self.meta()["config-pilot-B-gemini-3.8-flash-high"]
        self.assertEqual((entry["isolation"], entry["threats"]), ("--disable-slash-commands; empty temporary working folder; stdin closed",
                                                                  ["agy MCP servers, hooks and user settings not excluded"]))

    def test_an_agy_reply_that_ran_a_tool_is_refused_and_nothing_is_written(self):
        tool = agy_reply(reply_row(1, "o/one")).replace('"step_type": "agent_response"', '"step_type": "tool"')
        with self.assertRaises(SystemExit) as raised:
            self.pilot(FakeFetch([("agy --model", tool)]), "B")
        self.assertIn("1 tool steps", str(raised.exception))
        self.assertFalse((self.work / "config-pilot-B-gemini-3.8-flash-high.jsonl").exists())

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


if __name__ == "__main__":
    unittest.main()
