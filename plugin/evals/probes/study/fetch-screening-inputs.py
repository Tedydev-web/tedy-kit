import json
import sys
from pathlib import Path

from study_agreement import HARD_CAP
from study_fetch import Fetch
from study_screening_input import fetch_inputs
from study_stage1_audit import read_audit
from study_stage2 import plan_file
from study_topic import TopicError, load_topic, require_screened, topic_arguments


def set_ranks(work, stratum, which):
    if which == "stage2":
        path = Path(work) / plan_file(stratum)
        if not path.is_file():
            raise TopicError(f"no {path.name} in {work}; plan stage 2 with plan-stage2.py")
        return set(json.loads(path.read_text())["order"])
    if which == "stage1-audit":
        audit = read_audit(work, stratum)
        return set(audit["near"] + audit["far"])
    return None


def main(argv=None, fetch=None):
    args = topic_arguments("Pin each row's commit and fetch its README, listing, asset files and the evidence the anchors score on, so every judge reads the same inputs.",
                           (["--work"], {"required": True, "help": "study working folder holding <stratum>-screening-order.jsonl and the tree cache"}),
                           (["--stratum"], {"help": "stratum to fetch; not used with --set qgs"}),
                           (["--through"], {"type": int, "default": HARD_CAP, "help": f"screening set: fetch rows up to this rank, plus forced and snowballed rows; default {HARD_CAP}"}),
                           (["--mark-permanent"], {"type": int, "action": "append", "default": [], "metavar": "RANK",
                                                   "help": "mark a rank's commit: or tree: error permanent when a check by hand finds the repository or commit gone, so a block holding it can run"}),
                           (["--set"], {"choices": ["screening", "qgs", "stage2", "stage1-audit"], "default": "screening",
                                        "help": "qgs: every QGS candidate of the topic into qgs-inputs.jsonl, numbered by candidate id; stage2: the stage-2 plan's rows; "
                                                "stage1-audit: the near and far excludes the stage-1 audit drew"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        candidates = args.set == "qgs"
        if candidates == bool(args.stratum):
            raise TopicError("--set qgs fetches the topic's candidates and takes no --stratum; every other set needs --stratum")
        if args.stratum:
            require_screened(topic, args.stratum)
        ranks = None if candidates else set_ranks(args.work, args.stratum, args.set)
        added, kept, failed = fetch_inputs(topic, args.work, args.stratum, args.through, fetch or Fetch(), args.mark_permanent, ranks=ranks, candidates=candidates)
    except TopicError as error:
        sys.exit(f"fetch-screening-inputs: {error}")
    print(f"{args.stratum or 'qgs'}: inputs fetched {added}; already held or scored {kept}; rows with a transient error {failed}, fetched again on the next run")


if __name__ == "__main__":
    main()
