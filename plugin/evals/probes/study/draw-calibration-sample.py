import json
import sys
from pathlib import Path

from study_calibration import SAMPLE_FILE, draw
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None):
    args = topic_arguments("Draw the 10-row blind calibration sample, stratified over the config and product strata and by the sessions' decisions, for the user to rate.",
                           (["--work"], {"required": True, "help": "study working folder holding both sessions' screen files"})).parse_args(argv)
    try:
        sample = draw(load_topic(args.repo, args.topic), args.work)
    except TopicError as error:
        sys.exit(f"draw-calibration-sample: {error}")
    (Path(args.work) / SAMPLE_FILE).write_text(json.dumps(sample, indent=1, ensure_ascii=False) + "\n")
    print(f"{len(sample['rows'])} rows in {Path(args.work) / SAMPLE_FILE}; the user rates them blind, then export-sweep-data.py copies the file")


if __name__ == "__main__":
    main()
