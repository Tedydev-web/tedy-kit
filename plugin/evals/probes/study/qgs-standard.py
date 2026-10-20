import json
import sys
from pathlib import Path

from study_pool import read_json
from study_qgs import qgs_standard
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None):
    args = topic_arguments("Build a stratum's quasi-gold standard from the two Claude judges, the reader and the cross-family judge, with each member's problem labels.",
                           (["--work"], {"required": True, "help": "study working folder holding the <stratum>-qgs-* files"}),
                           (["--stratum"], {"required": True, "help": "stratum whose standard is built"}),
                           (["--write"], {"action": "store_true", "help": "write final, labels, queue and rule into <stratum>-qgs-adjudicated.json; run qgs-recall.py --write after it"})).parse_args(argv)
    try:
        out = qgs_standard(load_topic(args.repo, args.topic), args.work, args.stratum)
    except TopicError as error:
        sys.exit(f"qgs-standard: {error}")
    if args.write:
        target = Path(args.work) / f"{args.stratum}-qgs-adjudicated.json"
        kept = {k: v for k, v in read_json(target, {}).items() if k not in out}
        target.write_text(json.dumps({**kept, **out}, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps({k: out[k] for k in ("judged_by_both", "queue")} | {"members": len(out["final"])}, indent=1))


if __name__ == "__main__":
    main()
