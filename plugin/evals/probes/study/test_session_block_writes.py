import json
import os
import unittest

from study_fixtures import FakeFetch, script, write_json, write_jsonl
from study_topic import TopicError, load_topic
from test_sessions import SHA, SessionBase, agy_reply, claude_reply, reply_row


class BlockWriteTest(SessionBase):
    def test_a_failed_meta_replace_rolls_the_rows_back_under_the_lock(self):
        from unittest import mock
        self.pilot(FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one") + "\nmechanism: gate: g"))]))
        before = [(self.work / n).read_text() for n in ("config-pilot-A.jsonl", "config-pilot-A-mechanisms.md")]
        held = []
        real_replace = os.replace

        def replace(source, target):
            if str(target).endswith("meta.json"):
                import fcntl
                with open(self.work / "meta.json.lock") as probe:
                    try:
                        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        held.append(False)
                    except BlockingIOError:
                        held.append(True)
                raise OSError("disk full")
            return real_replace(source, target)

        with mock.patch("study_session.os.replace", side_effect=replace), self.assertRaises(OSError):
            self.pilot(FakeFetch([("claude -p", claude_reply(reply_row(2, "o/two") + "\nmechanism: hook: h"))]), "A", "2-2")
        self.assertEqual([(self.work / n).read_text() for n in ("config-pilot-A.jsonl", "config-pilot-A-mechanisms.md")], before)
        self.assertEqual((held, [b["ranks"] for b in self.meta()["config-pilot-A"]["blocks"]]), ([True], [[1]]))

    def test_update_sessions_runs_the_undo_while_it_holds_the_lock(self):
        import fcntl
        from study_session import update_sessions
        held = []

        def undo():
            with open(self.work / "meta.json.lock") as probe:
                try:
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    held.append(False)
                except BlockingIOError:
                    held.append(True)

        def change(sessions):
            raise TopicError("disk full")

        with self.assertRaisesRegex(TopicError, "disk full"):
            update_sessions(self.work, change, undo)
        self.assertEqual(held, [True])

    def test_date_is_computed_from_the_push_date_and_the_sweep_date(self):
        inputs = self.work / "config-screening-inputs.jsonl"
        rows = [json.loads(line) for line in inputs.read_text().splitlines()]
        rows[0]["facts"] = {"pushed": "2026-06-01"}
        write_jsonl(inputs, rows)
        fetch = FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))])
        self.pilot(fetch)
        self.assertIn("The sweep date is 2026-10-01", fetch.called("claude -p")[0])
        row = json.loads((self.work / "config-pilot-A.jsonl").read_text())
        self.assertEqual((row["scores"]["Date"], row["session_date"]),
                         ({"v": 0.5, "why": "computed by the toolchain: pushed 2026-06-01, 122 days before the sweep date 2026-10-01"}, 1))

    def test_a_changed_prompt_template_after_the_freeze_is_refused(self):
        self.freeze(template="0" * 64)
        fetch = FakeFetch()
        with self.assertRaises(SystemExit) as raised:
            self.run_session(fetch, "--side", "A", "--ranks", "2-2")
        self.assertIn("the criteria, screening-packet-config.md or the prompt template differ from the freeze", str(raised.exception))
        self.assertEqual(fetch.calls, [])

    def test_a_failed_meta_write_rolls_the_rows_back(self):
        import study_session
        self.pilot(FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one") + "\nmechanism: gate: g"))]))
        before = [(self.work / n).read_text() for n in ("config-pilot-A.jsonl", "config-pilot-A-mechanisms.md")]
        original = study_session.add_block

        def broken(*args, **kwargs):
            raise TopicError("disk full")

        study_session.add_block = broken
        self.addCleanup(setattr, study_session, "add_block", original)
        with self.assertRaises(SystemExit) as raised:
            self.pilot(FakeFetch([("claude -p", claude_reply(reply_row(2, "o/two") + "\nmechanism: hook: h"))]), "A", "2-2")
        self.assertIn("disk full", str(raised.exception))
        self.assertEqual([(self.work / n).read_text() for n in ("config-pilot-A.jsonl", "config-pilot-A-mechanisms.md")], before)
        self.assertEqual([b["ranks"] for b in self.meta()["config-pilot-A"]["blocks"]], [[1]])

    def drop(self, session="config-pilot-A", ranks="1-1"):
        script("drop-screening-block").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--stratum", "config", "--session", session, "--ranks", ranks])

    def test_a_scored_block_can_be_dropped_and_its_ranks_fetched_and_screened_again(self):
        (self.work / "config-pilot-A-mechanisms.md").write_text("kept: from an earlier block\n")
        self.pilot(FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one") + "\nmechanism: gate: g"))]))
        self.drop()
        self.assertEqual(self.meta()["config-pilot-A"]["blocks"], [])
        self.assertEqual([(self.work / n).read_text() for n in ("config-pilot-A.jsonl", "config-pilot-A-mechanisms.md")], ["", "kept: from an earlier block\n"])
        self.assertEqual([json.loads(line)["order_rank"] for line in (self.work / "config-screening-inputs.jsonl").read_text().splitlines()], [2])
        self.assertEqual(sorted(p.name for p in (self.work / "dropped").iterdir()),
                         ["config-pilot-A-1-1-1.block.json", "config-pilot-A-1-1-1.inputs.jsonl", "config-pilot-A-1-1-1.rows.jsonl"])
        write_json(self.work / "cache/trees/o__one.json", {"oid": SHA, "paths": ["README.md"]})
        script("fetch-screening-inputs").fetch_inputs(load_topic(self.repo, "demo"), self.work, "config", 200, FakeFetch([("contents/README.md", "fresh readme"), ("/releases", "[]"), ("/tags", "[]"), ("/repos?per_page", "[]"), ("users/", json.dumps({"public_repos": 1}))]))
        self.assertEqual(json.loads((self.work / "config-screening-inputs.jsonl").read_text().splitlines()[0])["readme"], "fresh readme")
        self.pilot(FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))]))
        self.drop()
        self.assertTrue((self.work / "dropped/config-pilot-A-1-1-2.block.json").is_file())

    def test_a_rank_another_session_still_holds_keeps_its_inputs(self):
        self.pilot(FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))]))
        self.pilot(FakeFetch([("agy --model gemini", agy_reply(reply_row(1, "o/one")))]), "B")
        self.drop()
        self.assertEqual([json.loads(line)["order_rank"] for line in (self.work / "config-screening-inputs.jsonl").read_text().splitlines()], [1, 2])

    def test_dropping_without_the_rows_file_says_so(self):
        self.pilot(FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))]))
        (self.work / "config-pilot-A.jsonl").unlink()
        with self.assertRaises(SystemExit) as raised:
            self.drop()
        self.assertIn("no config-pilot-A.jsonl in", str(raised.exception))
        self.assertEqual(len(self.meta()["config-pilot-A"]["blocks"]), 1)


if __name__ == "__main__":
    unittest.main()
