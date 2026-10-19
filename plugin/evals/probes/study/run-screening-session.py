import json
import shutil
import sys
from pathlib import Path

from study_fetch import Fetch, NetworkRefused
from study_protocol import FREEZE_FILE
from study_session import model_family, run_block
from study_topic import TopicError, load_topic, saigon_today, session_a, session_b_options, topic_arguments


def pilot_jobs(topic, stratum, side, which):
    if side == "A":
        return [(session_a(topic), f"{stratum}-pilot-A")]
    options = session_b_options(topic)
    candidates = options[:len(topic["sessions"]["B"]["candidates"])]
    reachable = [o for o in candidates if which(o["cli"])] or [o for o in options[len(candidates):] if which(o["cli"])]
    if not reachable:
        raise TopicError("no session B candidate or fallback has its CLI on PATH")
    return [(o, f"{stratum}-pilot-B-{o['model']}") for o in reachable]


def screen_job(topic, work, stratum, side, which):
    path = Path(work) / FREEZE_FILE
    if not path.is_file():
        raise TopicError(f"no {FREEZE_FILE} in {work}; screen the pilot block with --pilot, then freeze the protocol with freeze-protocol.py")
    freeze = json.loads(path.read_text())
    option = session_a(topic) if side == "A" else freeze["session_b"]["chosen"]
    if not which(option["cli"]):
        raise TopicError(f"session {side} runs on {option['cli']}, which is not on PATH")
    return freeze["criteria"], (option, f"{stratum}-screen-{side}")


def main(argv=None, fetch=None, which=shutil.which):
    args = topic_arguments("Run one screening session block on the topic's claude or agy model, from the fetched inputs, and record the session in meta.json.",
                           (["--work"], {"required": True, "help": "study working folder"}),
                           (["--stratum"], {"required": True, "help": "stratum to screen"}),
                           (["--side"], {"required": True, "choices": ["A", "B"], "help": "session A or B"}),
                           (["--ranks"], {"required": True, "help": "first-last order ranks of the block, e.g. 1-5"}),
                           (["--pilot"], {"action": "store_true", "help": "screen the pilot block; for B, every reachable candidate"}),
                           (["--criteria"], {"help": "criteria file for the pilot; after the freeze it comes from the freeze"}),
                           (["--today"], {"default": saigon_today(), "help": "session date, default today in Asia/Saigon"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        first, _, last = args.ranks.partition("-")
        if not (first.isdigit() and last.isdigit()):
            raise TopicError(f"--ranks {args.ranks!r} must read first-last")
        if args.pilot:
            if not args.criteria:
                raise TopicError("--pilot needs --criteria")
            criteria, jobs = args.criteria, pilot_jobs(topic, args.stratum, args.side, which)
        else:
            criteria, job = screen_job(topic, args.work, args.stratum, args.side, which)
            jobs = [job]
        for option, name in jobs:
            key = name if args.pilot else f"{args.stratum}-{args.side}"
            job = {"work": args.work, "repo": args.repo, "stratum": args.stratum, "name": name, "key": key, "option": option, "criteria": criteria,
                   "first": int(first), "last": int(last), "today": args.today}
            rows = run_block(job, fetch or Fetch())
            print(f"{name}: {rows} rows from {option['cli']} {option['model']} (family {model_family(option['model'])})")
    except (TopicError, NetworkRefused) as error:
        sys.exit(f"run-screening-session: {error}")


if __name__ == "__main__":
    main()
