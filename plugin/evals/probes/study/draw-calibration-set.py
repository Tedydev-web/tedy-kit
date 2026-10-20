import json
import sys
from pathlib import Path

from study_calibration_set import DRAW_FILE, PAGE_FILE, SET_FILE, draw_set
from study_fetch import Fetch, NetworkRefused
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None, fetch=None):
    args = topic_arguments("Draw the calibration set: 60 rows per stratum, about half likely positives, split evenly over the facets, with their inputs fetched; write the "
                           "self-contained labelling page. The page shows the inputs and the anchors only, never an answer or how a row was drawn.",
                           (["--work"], {"required": True, "help": "the topic's working folder, holding the merged screening orders and the QGS candidates"}),
                           (["--criteria"], {"required": True, "help": "criteria file whose anchors the page shows, relative to the repository"})).parse_args(argv)
    try:
        text, provenance, page = draw_set(load_topic(args.repo, args.topic), args.repo, args.work, args.criteria, fetch or Fetch())
    except (TopicError, NetworkRefused) as error:
        sys.exit(f"draw-calibration-set: {error}")
    work = Path(args.work)
    (work / SET_FILE).write_text(text)
    (work / DRAW_FILE).write_text(json.dumps(provenance, indent=1) + "\n")
    (work / PAGE_FILE).write_text(page)
    print(f"{len(json.loads(text)['rows'])} rows in {work / SET_FILE}; open {work / PAGE_FILE} in a browser to label them, then run import-calibration-labels.py")


if __name__ == "__main__":
    main()
