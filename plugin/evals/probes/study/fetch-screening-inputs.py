import sys

from study_agreement import HARD_CAP
from study_fetch import Fetch
from study_screening_input import fetch_inputs
from study_topic import TopicError, load_topic, require_screened, topic_arguments


def main(argv=None, fetch=None):
    args = topic_arguments("Pin each screening row's commit and fetch its README, listing, asset files and the evidence the anchors score on, so both sessions score the same inputs.",
                           (["--work"], {"required": True, "help": "study working folder holding <stratum>-screening-order.jsonl and the tree cache"}),
                           (["--stratum"], {"required": True, "help": "stratum to fetch"}),
                           (["--through"], {"type": int, "default": HARD_CAP, "help": f"fetch rows up to this rank, plus forced and snowballed rows; default {HARD_CAP}"}),
                           (["--mark-permanent"], {"type": int, "action": "append", "default": [], "metavar": "RANK",
                                                   "help": "mark a rank's fetch error permanent after checking it by hand, so a block holding it can run"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        require_screened(topic, args.stratum)
        added, kept, failed = fetch_inputs(topic, args.work, args.stratum, args.through, fetch or Fetch(), args.mark_permanent)
    except TopicError as error:
        sys.exit(f"fetch-screening-inputs: {error}")
    print(f"{args.stratum}: inputs fetched {added}; already held or scored {kept}; rows with a transient error {failed}, fetched again on the next run")


if __name__ == "__main__":
    main()
