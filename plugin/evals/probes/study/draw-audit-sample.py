import json
import random
import sys
from pathlib import Path

from study_judges import AUDIT_FILE, AUDIT_ROWS, audit_option
from study_protocol import FREEZE_FILE
from study_screening_core import read_jsonl
from study_topic import TopicError, load_topic, screened_strata, topic_arguments


def draw(topic, work):
    work = Path(work)
    if (work / AUDIT_FILE).exists():
        raise TopicError(f"{work / AUDIT_FILE} already exists; the audit sample is drawn once")
    audit_option(topic)
    freeze_file = work / FREEZE_FILE
    if not freeze_file.is_file():
        raise TopicError(f"no {FREEZE_FILE} in {work}; the audit sample is drawn from rows screened after the freeze")
    frozen = json.loads(freeze_file.read_text())["strata"]
    out = {}
    for stratum in screened_strata(topic):
        sides = [{r["order_rank"] for r in read_jsonl(work, f"{stratum}-screen-{s}.jsonl")} for s in "AB"]
        ranks = sorted(r for r in sides[0] & sides[1] if r > frozen[stratum]["frozen_after_rank"])
        if not ranks:
            raise TopicError(f"{stratum}: no row both sessions screened after the pilot block")
        out[stratum] = sorted(random.Random(f"{topic['sweep']}:audit:{stratum}").sample(ranks, min(AUDIT_ROWS, len(ranks))))
    return out


def main(argv=None):
    args = topic_arguments("Draw the cross-family audit sample: 20 random rows per stratum, seeded by the sweep name, from the rows both sessions screened after the pilot block.",
                           (["--work"], {"required": True, "help": "the topic's working folder"})).parse_args(argv)
    try:
        out = draw(load_topic(args.repo, args.topic), args.work)
    except TopicError as error:
        sys.exit(f"draw-audit-sample: {error}")
    (Path(args.work) / AUDIT_FILE).write_text(json.dumps(out, indent=1) + "\n")
    print(f"audit sample: {json.dumps({s: len(r) for s, r in out.items()})}; screen it with run-judge.py --judge audit --set audit once the model is reachable")


if __name__ == "__main__":
    main()
