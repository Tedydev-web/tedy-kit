import hashlib
import json
import sys
from pathlib import Path

from study_calibration_set import labelled, labels_file
from study_qgs import whole_topic
from study_stage1 import FREEZE_FILE, RUNG_FILE, choose_rung
from study_topic import TopicError, load_topic, saigon_today, topic_arguments


def main(argv=None):
    args = topic_arguments("Walk the frozen stage-1 ladder on the user's labels and write the first rung whose two runs meet the pass rule, with the rungs tried.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--today"], {"default": saigon_today(), "help": "choice date, default today in Asia/Saigon"})).parse_args(argv)
    work = Path(args.work)
    try:
        whole_topic(load_topic(args.repo, args.topic), "the stage-1 rung choice")
        if (work / RUNG_FILE).exists():
            raise TopicError(f"{work / RUNG_FILE} already exists; the rung is chosen once")
        batches = ("calibration",) + (("top-up",) if (work / labels_file("top-up")).is_file() else ())
        result = choose_rung(work, labelled(work, batches))
        out = {**result, "batches": list(batches), "labels_sha256": {b: hashlib.sha256((work / labels_file(b)).read_bytes()).hexdigest() for b in batches},
               "freeze_sha256": hashlib.sha256((work / FREEZE_FILE).read_bytes()).hexdigest(), "date": args.today}
        (work / RUNG_FILE).write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    except TopicError as error:
        sys.exit(f"choose-stage1-rung: {error}")
    print(f"stage-1 rung {result['rung']} chosen; rungs tried {[t['rung'] for t in result['tried']]}" + ("; draw the held-out batch next" if result["rung"] > 1 else ""))


if __name__ == "__main__":
    main()
