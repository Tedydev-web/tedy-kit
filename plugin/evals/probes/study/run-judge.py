import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

from study_calibration_set import calibrated, set_file
from study_fetch import Fetch, NetworkRefused
from study_judges import AUDIT_FILE, QGS_JUDGES, SCREENING_JUDGES, SHAPES, audit_option, criteria_version, judged_batches, require_qualified, roster, run_name
from study_protocol import FREEZE_FILE
from study_qgs import INPUTS, JUDGE_FILES, PACKET, candidates, cross_family, cross_name, dropped, read_cross, read_verdicts, reader_queue, whole_topic
from study_screening_input import inputs_file
from study_session import model_family, run_block
from study_session_prompt import required_sweep_date
from study_stage1_audit import read_audit, screener_name
from study_topic import TopicError, load_topic, require_screened, saigon_today, topic_arguments

JUDGES = (*SCREENING_JUDGES, *QGS_JUDGES, "audit")
SETS = ("calibration", "qgs", "audit", "stage1-audit")


def read_freeze(work):
    path = Path(work) / FREEZE_FILE
    if not path.is_file():
        raise TopicError(f"no {FREEZE_FILE} in {work}; screening judges, the stage-1 audit and the cross-family audit run under the frozen protocol, so pilot and freeze first")
    freeze = json.loads(path.read_text())
    if criteria_version(freeze.get("criteria")) < 4:
        raise TopicError(f"{path} pins {freeze.get('criteria')}; judges are validated under quality criteria v4 or later")
    return freeze


def queued(topic, work):
    problems, listed = topic.get("problems") or [], candidates(work)
    a, b = (read_verdicts(work, f"{JUDGE_FILES[j]}.jsonl", problems, listed) for j in ("qgs-A", "qgs-B"))
    option = cross_family(topic)
    cross = read_cross(work, cross_name(option), problems, listed) if option else {}
    queue = reader_queue(a, b, cross)[1]
    return sorted(queue["disputed"] + queue["cross_family_only"])


def calibration_ranks(work, stratum):
    ranks = []
    for batch in judged_batches(work):
        path = Path(work) / set_file(batch)
        if not path.is_file():
            raise TopicError(f"no {path.name} in {work}; draw the calibration set first")
        ranks += [r["order_rank"] for r in json.loads(path.read_text())["rows"] if r["stratum"] == stratum]
    return ranks


def stratum_job(topic, work, stratum, judge, which_set, run):
    require_screened(topic, stratum)
    if which_set == "audit":
        if judge != "audit":
            raise TopicError("the audit sample is screened only by the cross-family model: pass --judge audit --set audit")
        freeze, option = read_freeze(work), audit_option(topic)
        sample = Path(work) / AUDIT_FILE
        if not sample.is_file():
            raise TopicError(f"no {AUDIT_FILE} in {work}; draw it with draw-audit-sample.py once stage 2 ends")
        return {"kind": "screening", "freeze": freeze, "option": option, "ranks": json.loads(sample.read_text())[stratum], "name": f"{stratum}-audit-{option['model']}"}
    if which_set == "stage1-audit":
        if judge != "screening-A":
            raise TopicError("the stage-1 audit rows are read by the stage-2 screener: pass --judge screening-A --set stage1-audit")
        freeze = read_freeze(work)
        audit = read_audit(work, stratum)
        option = freeze["session_a"]
        return {"kind": "screening", "freeze": freeze, "option": option, "ranks": audit["near"] + audit["far"], "name": screener_name(stratum, option), "shape": "full"}
    kind = "qgs" if judge in QGS_JUDGES else "screening"
    if judge == "audit":
        raise TopicError("the audit judge screens --set audit only")
    if run not in (1, 2):
        raise TopicError("a calibration run is --run 1 or --run 2: every judge runs twice")
    freeze = read_freeze(work) if kind == "screening" else None
    option = {k: v for k, v in roster(topic, freeze)[judge].items() if k != "kind"}
    return {"kind": kind, "freeze": freeze, "option": option, "ranks": calibration_ranks(work, stratum), "name": run_name(stratum, judge, option, run), "shape": SHAPES[kind],
            **({"packet": PACKET} if kind == "qgs" else {})}


def qgs_job(topic, work, judge):
    whole_topic(topic, "QGS judging")
    if judge not in QGS_JUDGES:
        raise TopicError(f"{judge} does not judge the QGS candidates; --set qgs runs qgs-A, qgs-B or the reader")
    strata = calibrated(topic)
    found = require_qualified(topic, work, None, [judge], strata)
    validated = {p for s in strata for r in found[judge]["strata"][s]["runs"] for p in r["packets"]}
    if validated != {hashlib.sha256((Path(work) / PACKET).read_bytes()).hexdigest()}:
        raise TopicError(f"{PACKET} is not the packet {judge} was validated under; validate it again on the calibration rows")
    drops = dropped(work)
    ranks = queued(topic, work) if judge == "reader" else [i for i in sorted(candidates(work)) if i not in drops]
    option = {k: v for k, v in roster(topic)[judge].items() if k != "kind"}
    return {"kind": "qgs", "freeze": None, "option": option, "ranks": ranks, "name": JUDGE_FILES[judge], "inputs": INPUTS, "packet": PACKET, "shape": "thin"}


def main(argv=None, fetch=None, which=shutil.which, environ=os.environ):
    args = topic_arguments("Run one judge, isolated, on the calibration rows (twice, --run 1 and 2, on the input shape its production runs read), on the topic's QGS "
                           "candidates or the reader's queue (--set qgs, once it qualified), on the stage-1 audit rows (--judge screening-A --set stage1-audit), or the "
                           "cross-family model on the audit sample (--judge audit --set audit), and record every block in meta.json.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--stratum"], {"help": "stratum to judge; not used with --set qgs"}),
                           (["--judge"], {"required": True, "choices": list(JUDGES), "help": "which judge of the roster runs"}),
                           (["--set"], {"required": True, "choices": list(SETS), "help": "which rows it judges"}),
                           (["--run"], {"type": int, "help": "calibration only: run 1 or run 2"}),
                           (["--rows"], {"help": "first-last positions, from 1, of the block within the set's rows; default every row, and a prompt too long for one block "
                                                 "is refused"}),
                           (["--today"], {"default": saigon_today(), "help": "run date, default today in Asia/Saigon"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        whole_topic(topic, "a judge")
        if (args.set == "qgs") == bool(args.stratum):
            raise TopicError("--set qgs judges the topic's candidates and takes no --stratum; every other set needs --stratum")
        job = qgs_job(topic, args.work, args.judge) if args.set == "qgs" else stratum_job(topic, args.work, args.stratum, args.judge, args.set, args.run)
        if args.rows:
            first, _, last = args.rows.partition("-")
            if not (first.isdigit() and last.isdigit() and 1 <= int(first) <= int(last)):
                raise TopicError(f"--rows {args.rows!r} must read first-last, counted from 1")
            block = job["ranks"][int(first) - 1:int(last)]
            if not block:
                raise TopicError(f"--rows {args.rows} holds no row of the {len(job['ranks'])} that {args.judge} judges on --set {args.set}")
            job = {**job, "ranks": block}
        option, freeze = job["option"], job["freeze"]
        if not which(option["cli"]):
            raise TopicError(f"{option['model']} runs on {option['cli']}, which is not on PATH")
        if not job["ranks"]:
            raise TopicError(f"no rows for {args.judge} on --set {args.set}")
        stratum = args.stratum or "qgs"
        block = {"work": args.work, "repo": args.repo, "stratum": stratum, "name": job["name"], "key": job["name"], "option": option, "kind": job["kind"],
                 "ranks": job["ranks"], "inputs": job.get("inputs") or inputs_file(args.work, stratum).name,
                 "packet": job.get("packet") or f"screening-packet-{stratum}.md", "shape": job.get("shape"), "problems": topic.get("problems") or [],
                 "criteria": freeze["criteria"] if freeze else None, "frozen": freeze["strata"][stratum] if freeze else None,
                 "bare": bool(environ.get("ANTHROPIC_API_KEY")), "today": args.today, "sweep_date": required_sweep_date(topic)}
        rows = run_block(block, fetch or Fetch())
        print(f"{job['name']}: {rows} rows from {option['cli']} {option['model']} (family {model_family(option['model'])})")
    except (TopicError, NetworkRefused) as error:
        sys.exit(f"run-judge: {error}")


if __name__ == "__main__":
    main()
