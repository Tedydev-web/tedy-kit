import sys

from study_citation_check import CORRECTION_DIR, open_correction
from study_qgs import whole_topic
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None):
    args = topic_arguments("Open the one correction round a calibration batch gets after its citation check stopped the method: move the freeze, the check and the "
                           f"checkers' votes into {CORRECTION_DIR}/. Then the chosen wording enters the criteria, the reference re-runs the rows a stated rule selects "
                           "as the next notes round, the batch is derived and frozen again (the freeze records correction 1), and a fresh 30-row check is drawn "
                           "with the verify-2 seed. A second stop ends the method.",
                           (["--work"], {"required": True, "help": "the topic's working folder"})).parse_args(argv)
    try:
        whole_topic(load_topic(args.repo, args.topic), "the correction round")
        moved = open_correction(args.work)
    except TopicError as error:
        sys.exit(f"open-correction-round: {error}")
    print(f"{CORRECTION_DIR}: moved {', '.join(moved)}")


if __name__ == "__main__":
    main()
