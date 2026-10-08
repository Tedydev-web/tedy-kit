import argparse
import json
import re

QUESTION = re.compile(
    r"(\?\s*$)|(anh (muốn|chọn|có muốn|thấy sao|quyết)"
    r"|em (làm|tiếp tục|tiến hành)[^.]{0,40}(không|ko)\b|được không|nhé\?)",
    re.I,
)
SKIP = ("<local-command", "<system-reminder", "<task-notification")


def turns(path):
    current = {"texts": [], "ask": 0, "at": "", "cli": False}
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
            current = {"texts": [], "ask": 0, "at": event.get("timestamp", ""), "cli": event.get("entrypoint") == "cli"}
        elif event.get("type") == "assistant" and not event.get("isSidechain"):
            for block in message.get("content") or []:
                if block.get("type") == "text":
                    current["texts"].append(block["text"])
                elif block.get("type") == "tool_use" and block.get("name") == "AskUserQuestion":
                    current["ask"] += 1
    yield current


def rate(path, since=""):
    total = asked = prose = 0
    for turn in turns(path):
        if not turn["texts"] or not turn["cli"] or turn["at"] < since:
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
    parser = argparse.ArgumentParser(description="Share of interactive turns that end with a prose question instead of AskUserQuestion.")
    parser.add_argument("--since", default="", help="ISO UTC timestamp; count only turns the user started at or after it")
    parser.add_argument("transcripts", nargs="+")
    args = parser.parse_args()
    sums = [0, 0, 0]
    for transcript in args.transcripts:
        counts = rate(transcript, args.since)
        sums = [a + b for a, b in zip(sums, counts)]
        total, asked, prose = counts
        if total:
            print(f"{transcript}: turns={total} ask_user_question={asked} prose_question_endings={prose} ({round(100 * prose / total)}%)")
    total, asked, prose = sums
    print(f"all: turns={total} ask_user_question={asked} prose_question_endings={prose} ({round(100 * prose / total, 1) if total else 0}%)")
