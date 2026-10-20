import json
import sys
from pathlib import Path

from study_calibration_set import calibrated
from study_qgs import whole_topic
from study_stage1 import FREEZE_FILE, freeze
from study_topic import TopicError, load_topic, saigon_today, topic_arguments


def main(argv=None):
    args = topic_arguments("Freeze the stage-1 rung ladder, the worked examples, the stage-1 packets and the prompt template before any calibration label is read.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--today"], {"default": saigon_today(), "help": "freeze date, default today in Asia/Saigon"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        whole_topic(topic, "the stage-1 freeze")
        frozen = freeze(topic, args.work, calibrated(topic), args.today)
        (Path(args.work) / FREEZE_FILE).write_text(json.dumps(frozen, indent=1, ensure_ascii=False) + "\n")
    except TopicError as error:
        sys.exit(f"freeze-stage1: {error}")
    print(f"froze the stage-1 ladder of {len(frozen['ladder'])} rungs for {', '.join(frozen['packets'])} on {args.today}")


if __name__ == "__main__":
    main()
