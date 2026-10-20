import json
import sys
from pathlib import Path

from study_pool import read_json
from study_qgs import ADJUDICATED, qgs_standard
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None):
    args = topic_arguments("Build the topic's quasi-gold standard from the two Claude judges, the reader and the cross-family judge, with each member's problem labels.",
                           (["--work"], {"required": True, "help": "the topic's working folder holding the qgs-* files"}),
                           (["--write"], {"action": "store_true", "help": f"write final, labels, queue, drops and rule into {ADJUDICATED}"})).parse_args(argv)
    try:
        out = qgs_standard(load_topic(args.repo, args.topic), args.work)
    except TopicError as error:
        sys.exit(f"qgs-standard: {error}")
    if args.write:
        target = Path(args.work) / ADJUDICATED
        kept = {k: v for k, v in read_json(target, {}).items() if k not in out}
        target.write_text(json.dumps({**kept, **out}, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps({k: out[k] for k in ("judged_by_both", "queue")} | {"members": len(out["final"]), "dropped": len(out["dropped"])}, indent=1))


if __name__ == "__main__":
    main()
