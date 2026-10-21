import sys
from pathlib import Path

from study_citation_check import BATCH, PAGE_FILE, page
from study_fetch import Fetch, NetworkRefused
from study_qgs import whole_topic
from study_reference_freeze import frozen_sha
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None, fetch=None):
    args = topic_arguments("Draw the 30-row human citation check from the frozen calibration labels (per stratum the 10 Relevance 1 and 5 Relevance 0 rows with the lowest "
                           "sha256 of <sweep>:verify:<row id>) and write citation-check.html: one yes/no question per row beside the Relevance anchor, with no judge, "
                           "session or flagger answer.",
                           (["--work"], {"required": True, "help": "the topic's working folder"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        whole_topic(topic, "the citation check")
        if topic.get("reference") is None:
            raise TopicError(f"topic {topic['name']} names no reference; the citation check checks a reference's labels")
        text, rows = page(topic, args.repo, args.work, frozen_sha(args.work, BATCH), fetch or Fetch())
    except (TopicError, NetworkRefused) as error:
        sys.exit(f"draw-citation-check: {error}")
    (Path(args.work) / PAGE_FILE).write_text(text)
    print(f"{Path(args.work) / PAGE_FILE}: {rows} rows to check")


if __name__ == "__main__":
    main()
