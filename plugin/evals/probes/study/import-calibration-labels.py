import json
import sys
from pathlib import Path

from study_calibration_set import LABELS_FILE, import_labels
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None):
    args = topic_arguments("Import the labels the calibration page saved: check they belong to this calibration set and that every value is a rating or a decision, then keep them.",
                           (["--work"], {"required": True, "help": "the topic's working folder holding calibration-set.json"}),
                           (["--labels"], {"required": True, "help": "the JSON file the calibration page saved"})).parse_args(argv)
    try:
        load_topic(args.repo, args.topic)
        try:
            saved = json.loads(Path(args.labels).read_text())
        except (OSError, ValueError) as error:
            raise TopicError(f"cannot read {args.labels}: {error}") from error
        complete, total = import_labels(args.work, saved)
    except TopicError as error:
        sys.exit(f"import-calibration-labels: {error}")
    print(f"labelled {complete} of {total} rows in {Path(args.work) / LABELS_FILE}" + ("" if complete == total else "; label the rest before the judges are validated"))


if __name__ == "__main__":
    main()
