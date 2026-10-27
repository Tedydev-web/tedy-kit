import contextlib
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

from study_calibration_set import calibrated, set_file
from study_fetch import Fetch, NetworkRefused
from study_judges import AUDIT_FILE, QGS_JUDGES, SCREENING_JUDGES, SHAPES, audit_option, criteria_version, judged_batches, require_qualified, roster, run_name
from study_protocol import FREEZE_FILE
from study_qgs import INPUTS, JUDGE_FILES, PACKET, candidates, cross_family, cross_name, dropped, read_cross, read_verdicts, reader_queue, whole_topic
from study_reference_cues import cue_selects, valid_cue
from study_reference_flags import agy_window, flagger_key
from study_reference_freeze import freeze_file, require_frozen
from study_screening_core import read_jsonl
from study_screening_input import inputs_file
from study_session import ReplyRefused, model_family, record_refusal, run_block, run_blocks
from study_session_prompt import required_sweep_date
from study_session_reply import REFERENCE_CRITERIA
from study_stage1 import LADDER
from study_stage1_audit import read_audit, screener_name
from study_topic import KEBAB, TopicError, flaggers, load_topic, model_slug, reference_option, require_screened, saigon_today, session_binary, topic_arguments

REFERENCE_JUDGES = ("reference", "flagger")
JUDGES = (*SCREENING_JUDGES, *QGS_JUDGES, "audit", *REFERENCE_JUDGES)
SETS = ("calibration", "qgs", "audit", "stage1-audit", "reference")
BUNDLE = "reference-bundle.md"
NOTE_KEYS = {"line", "quote", "criterion", "cue"}
NOTE_CRITERIA = (*REFERENCE_CRITERIA, "decision")


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
        return {"kind": "screening", "freeze": freeze, "option": option, "ranks": json.loads(sample.read_text())[stratum], "name": f"{stratum}-audit-{model_slug(option['model'])}"}
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
            "reference_freeze_sha256": require_frozen(topic, work, judged_batches(work)), **({"packet": PACKET} if kind == "qgs" else {})}


def qgs_job(topic, work, judge):
    whole_topic(topic, "QGS judging")
    if judge == "audit":
        option, drops = audit_option(topic), dropped(work)
        return {"kind": "qgs", "freeze": None, "option": option, "ranks": [i for i in sorted(candidates(work)) if i not in drops], "name": cross_name(option)[:-len(".jsonl")],
                "inputs": INPUTS, "packet": PACKET, "shape": "thin"}
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


def note_job(work, batch, stratum, ranks):
    path = Path(work) / f"reference-notes-{batch}.json"
    if not path.is_file():
        raise TopicError(f"no {path.name} in {work}; write the batch's interpretation notes first")
    data = path.read_bytes()
    notes = json.loads(data)
    if not isinstance(notes, list) or not notes:
        raise TopicError(f"{path.name} must hold a non-empty list of notes")
    for number, note in enumerate(notes, 1):
        if (not isinstance(note, dict) or set(note) != NOTE_KEYS or type(note["line"]) is not int or note["line"] < 1 or not isinstance(note["quote"], str)
                or not note["quote"].strip() or note["criterion"] not in NOTE_CRITERIA or not valid_cue(note["cue"])):
            raise TopicError(f"{path.name} note {number} must hold exactly line, quote, criterion and cue: a criteria line number, its verbatim text, one of "
                             f"{', '.join(NOTE_CRITERIA)}, and a frozen README cue or a fact:prefilled.<field> or fact:evidence.<field> cue")
    inputs = {r["order_rank"]: r for r in read_jsonl(Path(work), f"reference-inputs-{stratum}.jsonl")}
    selected = [r for r in ranks if r in inputs and any(cue_selects(n["cue"], inputs[r]) for n in notes)]
    if not selected:
        raise TopicError(f"no note of {path.name} selects a {stratum} row of {batch}")
    return notes, hashlib.sha256(data).hexdigest(), selected


def reference_job(topic, work, stratum, judge, batch, model, note):
    require_screened(topic, stratum)
    ladder = [m for rung in LADDER for m in rung["models"]]
    reference = reference_option(topic, ladder)
    if reference is None:
        raise TopicError(f"{topic['path']} names no reference; a topic without one keeps the user's labels")
    if not batch:
        raise TopicError("--set reference needs --batch, the drawn batch whose rows the reference labels")
    if not re.fullmatch(KEBAB, batch):
        raise TopicError(f"--batch {batch!r} must be kebab-case")
    path = Path(work) / set_file(batch)
    if not path.is_file():
        raise TopicError(f"no {path.name} in {work}; --set reference labels a drawn calibration, top-up or held-out batch")
    ranks = [r["order_rank"] for r in json.loads(path.read_text())["rows"] if r["stratum"] == stratum]
    name, notes, notes_sha256 = f"reference-{batch}-{stratum}", None, None
    if judge == "flagger":
        if note is not None:
            raise TopicError("--rerun-notes re-runs the reference; flaggers label each row once")
        if not model:
            raise TopicError("--judge flagger needs --model, one of the topic config's flaggers")
        found = [o for options in flaggers(topic, ladder).values() for o in options if o["model"] == model]
        if not found:
            raise TopicError(f"{model} is in neither rubric_trigger_flaggers nor record_only_flaggers of {topic['path']}")
        option, name = {k: v for k, v in found[0].items() if k != "retest"}, flagger_key(batch, stratum, found[0])
    else:
        if model:
            raise TopicError("--model names a flagger; the reference is the topic config's reference")
        option = reference
        if note is not None:
            if note < 1:
                raise TopicError(f"--rerun-notes {note} must be a round number from 1")
            if (Path(work) / FREEZE_FILE).is_file():
                raise TopicError(f"{FREEZE_FILE} exists; no note re-runs a row after the protocol freeze, a flagged row stays contested")
            if (Path(work) / freeze_file(batch)).is_file():
                raise TopicError(f"{freeze_file(batch)} exists; nothing after the freeze changes a label, so no note re-runs its rows")
            notes, notes_sha256, ranks = note_job(work, batch, stratum, ranks)
            name = f"{name}-notes-{note}"
    return {"kind": "reference", "freeze": None, "option": option, "ranks": ranks, "name": name, "inputs": f"reference-inputs-{stratum}.jsonl", "packet": BUNDLE, "notes": notes,
            "notes_sha256": notes_sha256}


def run_reference(block, fetch, flagger):
    done = {r["order_rank"] for r in read_jsonl(Path(block["work"]), f"{block['name']}.jsonl")}
    left = [r for r in block["ranks"] if r not in done]
    if not flagger:
        return run_blocks(block, left, fetch, most=1)[0], []
    written, refused = 0, []
    for rank in left:
        for attempt in (1, 2):
            try:
                written += run_block({**block, "ranks": [rank]}, fetch)
                break
            except ReplyRefused as error:
                if attempt == 2:
                    record_refusal(block, rank, str(error))
                    refused.append(rank)
    return written, refused


def main(argv=None, fetch=None, which=shutil.which, environ=os.environ):
    args = topic_arguments("Run one judge, isolated, on the calibration rows (twice, --run 1 and 2, on the input shape its production runs read), on the topic's QGS "
                           "candidates or the reader's queue (--set qgs, once it qualified), the cross-family model on them (--judge audit --set qgs, any --rows block), "
                           "on the stage-1 audit rows (--judge screening-A --set stage1-audit), or the "
                           "cross-family model on the audit sample (--judge audit --set audit), or the topic's reference or one blind flagger on a drawn batch, one row "
                           "per block (--judge reference|flagger --set reference --batch), and record every block in meta.json.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--stratum"], {"help": "stratum to judge; not used with --set qgs"}),
                           (["--judge"], {"required": True, "choices": list(JUDGES), "help": "which judge of the roster runs"}),
                           (["--set"], {"required": True, "choices": list(SETS), "help": "which rows it judges"}),
                           (["--run"], {"type": int, "help": "calibration only: run 1 or run 2"}),
                           (["--rows"], {"help": "first-last positions, from 1, of the rows to judge within the set's rows; default every row. --set stage1-audit splits "
                                                 "them in rank order into blocks of at most 100 rows whose prompt fits the limit; every other set runs them as one block, "
                                                 "and a prompt too long for one block is refused"}),
                           (["--batch"], {"help": "--set reference only: the drawn batch (calibration, top-up, held-out, ...) whose rows of --stratum are labelled"}),
                           (["--model"], {"help": "--judge flagger only: the flagger model, one of the topic config's rubric_trigger_flaggers or record_only_flaggers"}),
                           (["--rerun-notes"], {"type": int, "help": "--judge reference only: round N (from 1) re-runs every row a note of "
                                                                    "reference-notes-<batch>.json selects, with every note's criteria line under Rubric notes, as "
                                                                    "reference-<batch>-<stratum>-notes-N; the derive step reads the latest round holding a row"}),
                           (["--endpoint"], {"help": "a judge or flagger on aperture only: the Aperture URL, for example http://100.127.1.240; one chat completion "
                                                     "per row, no tools offered"}),
                           (["--agy-window"], {"action": "store_true", "help": "--judge flagger on agy only, off by default: disable the context-mode MCP server "
                                                                               "and the ponytail plugin for the run and enable them again after it"}),
                           (["--today"], {"default": saigon_today(), "help": "run date, default today in Asia/Saigon"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        whole_topic(topic, "a judge")
        if (args.set == "qgs") == bool(args.stratum):
            raise TopicError("--set qgs judges the topic's candidates and takes no --stratum; every other set needs --stratum")
        if args.set == "reference" and args.judge not in REFERENCE_JUDGES:
            raise TopicError("--set reference runs --judge reference or flagger")
        if args.set != "reference" and args.judge in REFERENCE_JUDGES:
            raise TopicError(f"--judge {args.judge} runs on --set reference")
        if args.set != "reference" and (args.batch or args.model or args.rerun_notes is not None):
            raise TopicError("--batch and --model belong to --set reference, --rerun-notes to --judge reference")
        if args.set == "reference":
            job = reference_job(topic, args.work, args.stratum, args.judge, args.batch, args.model, args.rerun_notes)
        else:
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
        if args.agy_window and (args.judge != "flagger" or option["cli"] != "agy"):
            raise TopicError("--agy-window belongs to --judge flagger on agy; it switches agy extensions only")
        if (option["cli"] == "aperture") != bool(args.endpoint):
            raise TopicError("--endpoint names the Aperture URL, and only a judge or flagger on aperture takes it")
        if args.endpoint:
            option = job["option"] = {**option, "endpoint": args.endpoint.rstrip("/")}
        if not which(session_binary(option)):
            raise TopicError(f"{option['model']} runs on {option['cli']}, which is not on PATH")
        if not job["ranks"]:
            raise TopicError(f"no rows for {args.judge} on --set {args.set}")
        stratum = args.stratum or "qgs"
        block = {"work": args.work, "repo": args.repo, "stratum": stratum, "name": job["name"], "key": job["name"], "option": option, "kind": job["kind"],
                 "ranks": job["ranks"], "inputs": job.get("inputs") or inputs_file(args.work, stratum).name,
                 "packet": job.get("packet") or f"screening-packet-{stratum}.md", "shape": job.get("shape"), "problems": topic.get("problems") or [],
                 "criteria": freeze["criteria"] if freeze else None, "frozen": freeze["strata"][stratum] if freeze else None,
                 "bare": bool(environ.get("ANTHROPIC_API_KEY")), "today": args.today, "sweep_date": required_sweep_date(topic), "notes": job.get("notes"),
                 "notes_sha256": job.get("notes_sha256"), "reference_freeze_sha256": job.get("reference_freeze_sha256")}
        if args.set == "reference":
            fetch = fetch or Fetch()
            with agy_window(fetch) if args.agy_window else contextlib.nullcontext():
                rows, refused = run_reference(block, fetch, args.judge == "flagger")
            print(f"{job['name']}: {rows} rows from {option['cli']} {option['model']}" + (f"; refused twice, recorded: ranks {refused}" if refused else ""))
            return
        rows = run_blocks(block, job["ranks"], fetch or Fetch())[0] if args.set == "stage1-audit" else run_block(block, fetch or Fetch())
        print(f"{job['name']}: {rows} rows from {option['cli']} {option['model']} (family {model_family(option['model'])})")
    except (TopicError, NetworkRefused) as error:
        sys.exit(f"run-judge: {error}")


if __name__ == "__main__":
    main()
