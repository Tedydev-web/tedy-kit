import sys

from study_agreement import HARD_CAP
from study_fetch import Fetch
from study_screening_input import fetch_inputs
from study_topic import TopicError, load_topic, require_screened, topic_arguments


def main(argv=None, fetch=None):
    args = topic_arguments("Pin each screening row's commit and fetch its README, top-level listing and up to two asset files, so both sessions score the same inputs without tools.",
                           (["--work"], {"required": True, "help": "study working folder holding <stratum>-screening-order.jsonl and the tree cache"}),
                           (["--stratum"], {"required": True, "help": "stratum to fetch"}),
                           (["--through"], {"type": int, "default": HARD_CAP, "help": f"fetch rows up to this rank, plus forced and snowballed rows; default {HARD_CAP}"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        require_screened(topic, args.stratum)
        added, kept = fetch_inputs(topic, args.work, args.stratum, args.through, fetch or Fetch())
    except TopicError as error:
        sys.exit(f"fetch-screening-inputs: {error}")
    print(f"{args.stratum}: inputs fetched {added}; already held {kept}")


if __name__ == "__main__":
    main()
