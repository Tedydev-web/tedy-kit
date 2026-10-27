import json
import sys
from pathlib import Path

from study_citation_check import BATCH, CHECK_FILE, import_check, write_check
from study_citation_checkers import import_votes
from study_qgs import whole_topic
from study_reference_freeze import frozen_sha
from study_topic import TopicError, load_topic, topic_arguments


def read_saved(path, what):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError) as error:
        raise TopicError(f"{path} is not a readable {what} ({error})") from error


def main(argv=None):
    args = topic_arguments("Keep the citation-check answers, the user's from the page or three checker models' votes by majority: check them against the current "
                           "calibration freeze, its set and a redraw of the 30 rows, count the unsupported rows, state the one-sided 95% Clopper-Pearson upper bound "
                           "and the two-sided interval, and write citation-check.json. 2 or more unsupported rows stop the method; three checkers whose majority "
                           "passes while 2 or more rows have an unsupporting vote straddle it, and that goes to the user too.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--answers"], {"help": "the JSON file the citation-check page downloaded"}),
                           (["--votes"], {"nargs": "+", "help": "the three citation-check-votes-<model>.json files run-citation-checker.py wrote"})).parse_args(argv)
    try:
        if (args.answers is None) == (args.votes is None):
            raise TopicError("pass --answers (the user's page) or --votes (three checker models), not both or neither")
        topic = load_topic(args.repo, args.topic)
        whole_topic(topic, "the citation check")
        freeze = frozen_sha(args.work, BATCH)
        if args.answers:
            out = import_check(topic, args.work, read_saved(args.answers, "answers file"), freeze)
        else:
            out = write_check(args.work, import_votes(topic, args.work, [read_saved(p, "votes file") for p in args.votes], freeze))
    except TopicError as error:
        sys.exit(f"import-citation-check: {error}")
    line = f"{CHECK_FILE}: {out['unsupported']} of {out['n']} unsupported, one-sided 95% upper bound {out['upper_one_sided']:.3f}"
    if "checkers" in out:
        line += f"; {out['unsupported_any']} with an unsupporting vote from {', '.join(c['model'] for c in out['checkers'])}"
    if out["stopped"]:
        sys.exit(f"import-citation-check: {line}; method stopped: next step is the user's")
    if out.get("straddle"):
        sys.exit(f"import-citation-check: {line}; the checkers straddle the stop rule: next step is the user's")
    print(line)


if __name__ == "__main__":
    main()
