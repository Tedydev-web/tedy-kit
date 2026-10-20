import json
import sys
from pathlib import Path

from study_calibration_set import BATCHES, import_labels, labels_file
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None):
    args = topic_arguments("Import the labels a calibration page saved: check they belong to this batch, that the stage-1 ladder was frozen first, and that every value is a "
                           "rating, a problem id or a decision, then keep them.",
                           (["--work"], {"required": True, "help": "the topic's working folder holding the batch's set file"}),
                           (["--batch"], {"default": "calibration", "choices": list(BATCHES), "help": "which batch the labels belong to"}),
                           (["--labels"], {"required": True, "help": "the JSON file the calibration page saved"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        try:
            saved = json.loads(Path(args.labels).read_text())
        except (OSError, ValueError) as error:
            raise TopicError(f"cannot read {args.labels}: {error}") from error
        complete, total = import_labels(topic, args.work, saved, args.batch)
    except TopicError as error:
        sys.exit(f"import-calibration-labels: {error}")
    print(f"labelled {complete} of {total} rows in {Path(args.work) / labels_file(args.batch)}" + ("" if complete == total else "; label the rest before the judges are validated"))


if __name__ == "__main__":
    main()
