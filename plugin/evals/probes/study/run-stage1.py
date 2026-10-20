import json
import os
import shutil
import sys
from pathlib import Path

from study_calibration_set import labelled, set_file
from study_fetch import Fetch, NetworkRefused
from study_qgs import whole_topic
from study_screening_core import read_jsonl
from study_session import run_block
from study_stage1 import (BATCH_MAX, LADDER, RUNG_FILE, SHAPES, auto_pass, calibration_name, examples_text, held_out_check, held_out_name, inputs_name, ladder_rung, option,
                          pool_name, read_freeze, sha256_text, stage1_inputs)
from study_topic import TopicError, load_topic, require_screened, saigon_today, topic_arguments


def chosen_rung(work):
    path = Path(work) / RUNG_FILE
    if not path.is_file():
        raise TopicError(f"no {RUNG_FILE} in {work}; choose the rung with choose-stage1-rung.py first")
    return ladder_rung(json.loads(path.read_text())["rung"])


def set_ranks(work, stratum, batches):
    ranks = []
    for batch in batches:
        path = Path(work) / set_file(batch)
        if path.is_file():
            ranks += [r["order_rank"] for r in json.loads(path.read_text())["rows"] if r["stratum"] == stratum]
    if not ranks:
        raise TopicError(f"no {stratum} rows in {', '.join(set_file(b) for b in batches)}; draw the batch first")
    return ranks


def plan(work, stratum, shape, model, which, run):
    if not any(r["shape"] == shape and model in r["models"] for r in LADDER):
        raise TopicError(f"no rung of the frozen ladder runs {model} on the {shape} shape")
    if which == "calibration":
        if run not in (1, 2):
            raise TopicError("a calibration run is --run 1 or --run 2: every stage-1 rung runs twice")
        return calibration_name(stratum, shape, model, run), set_ranks(work, stratum, ("calibration", "top-up"))
    rung = chosen_rung(work)
    if shape != rung["shape"] or model not in rung["models"]:
        raise TopicError(f"rung {rung['rung']} was chosen: it runs {', '.join(rung['models'])} on the {rung['shape']} shape, not {model} on {shape}")
    if which == "held-out":
        if rung["rung"] == 1:
            raise TopicError("rung 1 was chosen, so no held-out batch confirms it")
        return held_out_name(stratum, shape, model), set_ranks(work, stratum, ("held-out",))
    if rung["rung"] > 1:
        held_out_check(work, rung["rung"], labelled(work, ("held-out",)))
    return pool_name(stratum, shape, model), sorted(stage1_inputs(work, stratum, shape))


def main(argv=None, fetch=None, which=shutil.which, environ=os.environ):
    args = topic_arguments("Run one stage-1 model, isolated, in batches of at most 100 rows: twice on the calibration rows, once on the held-out batch, or on the whole pool "
                           "once the rung is chosen. Rows with no text pass unread.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--stratum"], {"required": True, "help": "stratum to screen"}),
                           (["--shape"], {"required": True, "choices": list(SHAPES), "help": "input shape of the rung"}),
                           (["--model"], {"required": True, "help": "full model id of the rung"}),
                           (["--set"], {"required": True, "choices": ["calibration", "held-out", "pool"], "help": "which rows it screens"}),
                           (["--run"], {"type": int, "help": "calibration only: run 1 or run 2"}),
                           (["--today"], {"default": saigon_today(), "help": "run date, default today in Asia/Saigon"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        whole_topic(topic, "stage 1")
        require_screened(topic, args.stratum)
        frozen = read_freeze(args.work)
        if args.stratum not in frozen["packets"]:
            raise TopicError(f"the stage-1 freeze holds no packet for {args.stratum}")
        worked = examples_text(topic)
        name, ranks = plan(args.work, args.stratum, args.shape, args.model, args.set, args.run)
        inputs = stage1_inputs(args.work, args.stratum, args.shape)
        missing = sorted(set(ranks) - set(inputs))
        if missing:
            raise TopicError(f"ranks {missing[:10]} are not in {inputs_name(args.stratum, args.shape)}")
        done = {r["order_rank"] for r in read_jsonl(Path(args.work), f"{name}.jsonl")}
        todo = [r for r in sorted(set(ranks)) if r not in done and not auto_pass(inputs[r])]
        if not which("claude"):
            raise TopicError("stage 1 runs on claude, which is not on PATH")
        session = option(args.model)
        base = {"work": args.work, "repo": args.repo, "stratum": args.stratum, "name": name, "key": name, "option": session, "kind": "stage1",
                "inputs": inputs_name(args.stratum, args.shape), "packet": f"stage1-packet-{args.stratum}.md", "examples": worked, "problems": topic.get("problems") or [],
                "shape": args.shape, "frozen": {"packet_sha256": frozen["packets"][args.stratum], "examples_sha256": frozen["examples_sha256"],
                                                "template_sha256": frozen["template_sha256"]},
                "bare": bool(environ.get("ANTHROPIC_API_KEY")), "today": args.today}
        if frozen["examples_sha256"] != sha256_text(worked):
            raise TopicError("the topic's stage1_examples differ from the freeze; no stage-1 session runs on changed examples")
        written = 0
        for start in range(0, len(todo), BATCH_MAX):
            written += run_block({**base, "ranks": todo[start:start + BATCH_MAX]}, fetch or Fetch())
    except (TopicError, NetworkRefused) as error:
        sys.exit(f"run-stage1: {error}")
    print(f"{name}: {written} rows in {-(-len(todo) // BATCH_MAX)} batches; {len(set(ranks)) - len(todo) - len(done & set(ranks))} rows with no text pass unread")


if __name__ == "__main__":
    main()
