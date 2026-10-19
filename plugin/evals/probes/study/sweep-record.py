import sys

from study_sweep_record import write_record
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None):
    args = topic_arguments("Regenerate docs/prior-art/sweeps/<sweep>.md from the topic's sweep data folder.").parse_args(argv)
    try:
        print(write_record(args.repo, load_topic(args.repo, args.topic)))
    except TopicError as error:
        sys.exit(f"sweep-record: {error}")


if __name__ == "__main__":
    main()
