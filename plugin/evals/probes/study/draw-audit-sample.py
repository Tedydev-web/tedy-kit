import json
import sys
from pathlib import Path

from study_judges import AUDIT_FILE, AUDIT_ROWS, audit_option
from study_stage1_audit import cross_audit_sample
from study_topic import TopicError, load_topic, topic_arguments


def draw(topic, work):
    if (Path(work) / AUDIT_FILE).exists():
        raise TopicError(f"{Path(work) / AUDIT_FILE} already exists; the audit sample is drawn once")
    audit_option(topic)
    return cross_audit_sample(topic, work, AUDIT_ROWS)


def main(argv=None):
    args = topic_arguments("Draw the cross-family audit sample: the 20 rows per stratum with the lowest sha256 under the sweep name, from the rows both sessions screened after the pilot block, once stage 2 ended.",
                           (["--work"], {"required": True, "help": "the topic's working folder"})).parse_args(argv)
    try:
        out = draw(load_topic(args.repo, args.topic), args.work)
    except TopicError as error:
        sys.exit(f"draw-audit-sample: {error}")
    (Path(args.work) / AUDIT_FILE).write_text(json.dumps(out, indent=1) + "\n")
    print(f"audit sample: {json.dumps({s: len(r) for s, r in out.items()})}; screen it with run-judge.py --judge audit --set audit once the model is reachable")


if __name__ == "__main__":
    main()
