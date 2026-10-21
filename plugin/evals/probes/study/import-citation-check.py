import json
import sys
from pathlib import Path

from study_citation_check import BATCH, CHECK_FILE, import_check
from study_qgs import whole_topic
from study_reference_freeze import frozen_sha
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None):
    args = topic_arguments("Keep the user's citation-check answers: check them against the current calibration freeze, its set and a redraw of the 30 rows, count the "
                           "unsupported rows, state the one-sided 95% Clopper-Pearson upper bound and the two-sided interval, and write citation-check.json. 2 or more "
                           "unsupported rows stop the method.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--answers"], {"required": True, "help": "the JSON file the citation-check page downloaded"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        whole_topic(topic, "the citation check")
        try:
            saved = json.loads(Path(args.answers).read_text())
        except (OSError, ValueError) as error:
            raise TopicError(f"{args.answers} is not a readable answers file ({error})") from error
        out = import_check(topic, args.work, saved, frozen_sha(args.work, BATCH))
    except TopicError as error:
        sys.exit(f"import-citation-check: {error}")
    line = f"{CHECK_FILE}: {out['unsupported']} of {out['n']} unsupported, one-sided 95% upper bound {out['upper_one_sided']:.3f}"
    if out["stopped"]:
        sys.exit(f"import-citation-check: {line}; method stopped: next step is the user's")
    print(line)


if __name__ == "__main__":
    main()
