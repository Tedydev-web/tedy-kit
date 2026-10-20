import json
import os
import shutil
import sys
from pathlib import Path

from study_fetch import Fetch, NetworkRefused
from study_judges import SCREENING_JUDGES, criteria_version, require_qualified
from study_protocol import FREEZE_FILE
from study_session import model_family, run_block
from study_session_prompt import required_sweep_date
from study_stage2 import plan_file
from study_topic import TopicError, load_topic, require_screened, saigon_today, session_a, session_b, topic_arguments


def pilot_job(topic, stratum, side, model, which):
    if side == "A":
        option = session_a(topic)
        if model and model != option["model"]:
            raise TopicError(f"session A is {option['model']} in the topic config, not {model}")
        return option, f"{stratum}-pilot-A", None
    primary, fallback, also = session_b(topic)
    options = [o for o in (primary, fallback, *also) if o]
    if model:
        option = next((o for o in options if o["model"] == model), None)
        if option is None:
            raise TopicError(f"{model} is not session B, its fallback or a pilot_also option in the topic config")
    else:
        option = primary if which(primary["cli"]) else fallback
        if option is None:
            raise TopicError(f"session B runs on {primary['cli']}, which is not on PATH, and the topic config names no fallback")
    if option is fallback and which(primary["cli"]):
        raise TopicError(f"{primary['cli']} is on PATH, so session B is {primary['model']}; the fallback runs only without it")
    if not which(option["cli"]):
        raise TopicError(f"{option['model']} runs on {option['cli']}, which is not on PATH")
    reason = f"{primary['cli']} was not on PATH when this pilot ran" if option is fallback else None
    return option, f"{stratum}-pilot-B-{option['model']}", reason


def screen_job(topic, work, stratum, side, which):
    path = Path(work) / FREEZE_FILE
    if not path.is_file():
        raise TopicError(f"no {FREEZE_FILE} in {work}; screen the pilot block with --pilot, then freeze the protocol with freeze-protocol.py")
    freeze = json.loads(path.read_text())
    if stratum not in freeze["strata"]:
        raise TopicError(f"{path} does not freeze the {stratum} stratum")
    option = freeze["session_a"] if side == "A" else freeze["session_b"]["chosen"]
    primary = freeze["session_b"].get("primary", option)
    reason = None
    if side == "B" and option != primary:
        if which(primary["cli"]):
            raise TopicError(f"the freeze ran session B on the fallback {option['model']}, but {primary['cli']} is now on PATH; the frozen session B stays the fallback, so run its blocks with {primary['cli']} off PATH")
        reason = f"{primary['cli']} was not on PATH when this block ran"
    if not which(option["cli"]):
        raise TopicError(f"session {side} runs on {option['cli']}, which is not on PATH")
    ranks = None
    if criteria_version(freeze["criteria"]) >= 4:
        require_qualified(topic, work, freeze, SCREENING_JUDGES, [stratum])
        plan = Path(work) / plan_file(stratum)
        if not plan.is_file():
            raise TopicError(f"no {plan.name} in {work}; stage 2 screens the stage-1 passes plan-stage2.py lists")
        ranks = json.loads(plan.read_text())["order"]
    return freeze["criteria"], freeze["strata"][stratum], option, f"{stratum}-screen-{side}", reason, ranks


def main(argv=None, fetch=None, which=shutil.which, environ=os.environ):
    args = topic_arguments("Run one screening session block, isolated, on the claude or agy model the topic config or the freeze names, and record the block in meta.json.",
                           (["--work"], {"required": True, "help": "study working folder"}),
                           (["--stratum"], {"required": True, "help": "stratum to screen"}),
                           (["--side"], {"required": True, "choices": ["A", "B"], "help": "session A or B"}),
                           (["--ranks"], {"required": True, "help": "first-last order ranks of the block, e.g. 1-5"}),
                           (["--pilot"], {"action": "store_true", "help": "screen the pilot block before the freeze"}),
                           (["--model"], {"help": "pilot only: which configured option runs, one per invocation; default session B, else its fallback"}),
                           (["--criteria"], {"help": "criteria file for the pilot; after the freeze it comes from the freeze"}),
                           (["--today"], {"default": saigon_today(), "help": "session date, default today in Asia/Saigon"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        require_screened(topic, args.stratum)
        first, _, last = args.ranks.partition("-")
        if not (first.isdigit() and last.isdigit()):
            raise TopicError(f"--ranks {args.ranks!r} must read first-last")
        if args.pilot:
            if not args.criteria:
                raise TopicError("--pilot needs --criteria")
            option, name, reason = pilot_job(topic, args.stratum, args.side, args.model, which)
            criteria, frozen, key, planned = args.criteria, None, name, None
        else:
            if args.model:
                raise TopicError("--model is for the pilot; after the freeze the freeze names both sessions")
            criteria, frozen, option, name, reason, planned = screen_job(topic, args.work, args.stratum, args.side, which)
            key = f"{args.stratum}-{args.side}"
        ranks = None if planned is None else [r for r in planned if int(first) <= r <= int(last)]
        if ranks == []:
            raise TopicError(f"no stage-2 row of {args.stratum} lies between ranks {first} and {last}")
        job = {"work": args.work, "repo": args.repo, "stratum": args.stratum, "name": name, "key": key, "option": option, "criteria": criteria, "frozen": frozen,
               **({"ranks": ranks} if ranks else {}),
               "pilot": args.pilot, "fallback_reason": reason, "bare": bool(environ.get("ANTHROPIC_API_KEY")), "first": int(first), "last": int(last), "today": args.today,
               "sweep_date": required_sweep_date(topic), "problems": topic.get("problems") or []}
        rows = run_block(job, fetch or Fetch())
        print(f"{name}: {rows} rows from {option['cli']} {option['model']} (family {model_family(option['model'])})")
    except (TopicError, NetworkRefused) as error:
        sys.exit(f"run-screening-session: {error}")


if __name__ == "__main__":
    main()
