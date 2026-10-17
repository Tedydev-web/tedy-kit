import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("rate_module", pathlib.Path(__file__).with_name("prose-question-rate.py"))
rate_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rate_module)


def prompt(text, at, entrypoint="cli"):
    return {"type": "user", "timestamp": at, "entrypoint": entrypoint, "message": {"content": text}}


def say(text):
    return {"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}


def ask():
    return {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "AskUserQuestion", "input": {}}]}}


class RateTest(unittest.TestCase):
    def test_counts_only_interactive_turns_at_or_after_the_mark(self):
        events = [
            prompt("cũ", "2026-10-06T10:00:00Z"), say("Anh muốn em làm tiếp không?"),
            prompt("mới 1", "2026-10-07T08:00:00Z"), say("Anh chọn cách nào?"),
            prompt("mới 2", "2026-10-07T09:00:00Z"), say("Phân tích xong."), ask(),
            prompt("headless", "2026-10-07T10:00:00Z", "sdk-cli"), say("Anh muốn gì?"),
            prompt("mới 3", "2026-10-07T11:00:00Z"), say("Đã push nhánh và CI xanh."),
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as handle:
            handle.write("\n".join(json.dumps(event, ensure_ascii=False) for event in events))
        self.assertEqual(rate_module.rate(handle.name, "2026-10-07T00:00:00Z"), (3, 1, 1))
        self.assertEqual(rate_module.rate(handle.name), (4, 1, 2))


if __name__ == "__main__":
    unittest.main()
