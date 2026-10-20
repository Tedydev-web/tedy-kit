import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

from study_calibration_set import SET_FILE
from study_fetch import Fetch, NetworkRefused
from study_judges import AUDIT_FILE, QGS_JUDGES, SCREENING_JUDGES, audit_option, criteria_version, require_qualified, roster, run_name
from study_protocol import FREEZE_FILE
from study_qgs import cross_family, read_verdicts, reader_queue, whole_topic
from study_screening_core import read_jsonl
from study_screening_input import qgs_inputs_file
from study_session import model_family, run_block
from study_session_prompt import required_sweep_date
from study_topic import TopicError, load_topic, require_screened, saigon_today, topic_arguments

JUDGES = (*SCREENING_JUDGES, *QGS_JUDGES, "audit")


def read_freeze(work):
    path = Path(work) / FREEZE_FILE
    if not path.is_file():
        raise TopicError(f"no {FREEZE_FILE} in {work}; screening judges and the audit run under the frozen protocol, so pilot and freeze first")
    freeze = json.loads(path.read_text())
    if criteria_version(freeze.get("criteria")) < 4:
        raise TopicError(f"{path} pins {freeze.get('criteria')}; judges are validated under quality criteria v4 or later")
    return freeze


def queued(topic, work, stratum):
    problems = topic.get("problems") or []
    a, b = (read_verdicts(work, f"{stratum}-qgs-judge-{side}.jsonl", problems) for side in "AB")
    option = cross_family(topic)
    cross = read_verdicts(work, f"{stratum}-qgs-cross-{option['model']}.jsonl", problems, required=False) if option else {}
    queue = reader_queue(a, b, cross)[1]
    return sorted(queue["disputed"] + queue["cross_family_only"])


def calibration_ranks(work, stratum):
    path = Path(work) / SET_FILE
    if not path.is_file():
        raise TopicError(f"no {SET_FILE} in {work}; draw the calibration set first")
    return [r["order_rank"] for r in json.loads(path.read_text())["rows"] if r["stratum"] == stratum]


def judge_job(topic, work, stratum, judge, which_set, run):
    kind = "qgs" if judge in QGS_JUDGES else "screening"
    freeze = read_freeze(work) if kind == "screening" else None
    job = {"kind": kind, "freeze": freeze, "inputs": None, "validated": None, "packet": f"{'screening' if kind == 'screening' else 'qgs'}-packet-{stratum}.md"}
    if (judge == "audit") != (which_set == "audit"):
        raise TopicError("the audit sample is screened only by the cross-family model: pass --judge audit --set audit")
    if judge == "audit":
        option = audit_option(topic)
        sample = Path(work) / AUDIT_FILE
        if not sample.is_file():
            raise TopicError(f"no {AUDIT_FILE} in {work}; draw it with draw-audit-sample.py")
        return {**job, "option": option, "ranks": json.loads(sample.read_text())[stratum], "name": f"{stratum}-audit-{option['model']}"}
    option = {k: v for k, v in roster(topic, freeze)[judge].items() if k != "kind"}
    if which_set == "calibration":
        if run not in (1, 2):
            raise TopicError("a calibration run is --run 1 or --run 2: every judge runs twice")
        return {**job, "option": option, "ranks": calibration_ranks(work, stratum), "name": run_name(stratum, judge, option, run)}
    if kind != "qgs":
        raise TopicError(f"{judge} runs on --set calibration only; the screening sessions run through run-screening-session.py")
    found = require_qualified(topic, work, None, [judge], stratum)
    validated = {p for r in found[judge]["strata"][stratum]["runs"] for p in r["packets"]}
    listed = [r["id"] for r in read_jsonl(Path(work), f"{stratum}-qgs-candidates.jsonl")]
    ranks = queued(topic, work, stratum) if judge == "reader" else listed
    name = f"{stratum}-qgs-reader" if judge == "reader" else f"{stratum}-qgs-judge-{judge[-1]}"
    return {**job, "option": option, "ranks": ranks, "name": name, "inputs": qgs_inputs_file(work, stratum).name, "validated": validated}


def main(argv=None, fetch=None, which=shutil.which, environ=os.environ):
    args = topic_arguments("Run one judge, isolated, on the calibration set (twice, --run 1 and 2), on the QGS candidates or the reader's queue (--set qgs, once it qualified), "
                           "or the cross-family model on the audit sample (--judge audit --set audit), and record every block in meta.json.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--stratum"], {"required": True, "help": "stratum to judge"}),
                           (["--judge"], {"required": True, "choices": list(JUDGES), "help": "which judge of the roster runs"}),
                           (["--set"], {"required": True, "choices": ["calibration", "qgs", "audit"], "help": "which rows it judges"}),
                           (["--run"], {"type": int, "help": "calibration only: run 1 or run 2"}),
                           (["--rows"], {"help": "first-last positions, from 1, of the block within the set's rows (the calibration rows of the stratum, the candidates, "
                                                 "the reader's queue or the audit sample); default every row, and a prompt too long for one block is refused"}),
                           (["--today"], {"default": saigon_today(), "help": "run date, default today in Asia/Saigon"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        whole_topic(topic, "a judge")
        require_screened(topic, args.stratum)
        job = judge_job(topic, args.work, args.stratum, args.judge, args.set, args.run)
        if args.rows:
            first, _, last = args.rows.partition("-")
            if not (first.isdigit() and last.isdigit() and 1 <= int(first) <= int(last)):
                raise TopicError(f"--rows {args.rows!r} must read first-last, counted from 1")
            block = job["ranks"][int(first) - 1:int(last)]
            if not block:
                raise TopicError(f"--rows {args.rows} holds no row of the {len(job['ranks'])} that {args.judge} judges on --set {args.set}")
            job = {**job, "ranks": block}
        if job["validated"] is not None and job["validated"] != {hashlib.sha256((Path(args.work) / job["packet"]).read_bytes()).hexdigest()}:
            raise TopicError(f"{job['packet']} is not the packet {args.judge} was validated under; validate it again on the calibration set")
        option, freeze = job["option"], job["freeze"]
        if not which(option["cli"]):
            raise TopicError(f"{option['model']} runs on {option['cli']}, which is not on PATH")
        if not job["ranks"]:
            raise TopicError(f"no rows for {args.judge} on --set {args.set}")
        block = {"work": args.work, "repo": args.repo, "stratum": args.stratum, "name": job["name"], "key": job["name"], "option": option, "kind": job["kind"],
                 "ranks": job["ranks"], "inputs": job["inputs"], "packet": job["packet"], "criteria": freeze["criteria"] if freeze else None,
                 "frozen": freeze["strata"][args.stratum] if freeze else None, "bare": bool(environ.get("ANTHROPIC_API_KEY")), "today": args.today,
                 "sweep_date": required_sweep_date(topic)}
        rows = run_block(block, fetch or Fetch())
        print(f"{job['name']}: {rows} rows from {option['cli']} {option['model']} (family {model_family(option['model'])})")
    except (TopicError, NetworkRefused) as error:
        sys.exit(f"run-judge: {error}")


if __name__ == "__main__":
    main()
