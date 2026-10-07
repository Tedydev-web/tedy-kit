import json
import re
import sys

QUESTION = re.compile(
    r"(\?\s*$)|(anh (muốn|chọn|có muốn|thấy sao|quyết)"
    r"|em (làm|tiếp tục|tiến hành)[^.]{0,40}(không|ko)\b|được không|nhé\?)",
    re.I,
)
SKIP = ("<local-command", "<system-reminder", "<task-notification")


def turns(path):
    current = {"texts": [], "ask": 0}
    for line in open(path, errors="ignore"):
        try:
            event = json.loads(line)
        except ValueError:
            continue
        message = event.get("message") or {}
        if event.get("type") == "user" and isinstance(message.get("content"), str) and not event.get("isMeta"):
            if message["content"].startswith(SKIP):
                continue
            yield current
            current = {"texts": [], "ask": 0}
        elif event.get("type") == "assistant":
            for block in message.get("content") or []:
                if block.get("type") == "text":
                    current["texts"].append(block["text"])
                elif block.get("type") == "tool_use" and block.get("name") == "AskUserQuestion":
                    current["ask"] += 1
    yield current


def rate(path):
    total = asked = prose = 0
    for turn in turns(path):
        if not turn["texts"]:
            continue
        total += 1
        if turn["ask"]:
            asked += 1
            continue
        tail = re.sub(r"```.*?```", "", turn["texts"][-1], flags=re.S).strip()[-300:]
        if QUESTION.search(tail):
            prose += 1
    return total, asked, prose


if __name__ == "__main__":
    for transcript in sys.argv[1:]:
        total, asked, prose = rate(transcript)
        share = round(100 * prose / total) if total else 0
        print(f"{transcript}: turns={total} ask_user_question={asked} prose_question_endings={prose} ({share}%)")
