import argparse
import sys

from study_fetch import Fetch, NetworkRefused
from study_qgs import whole_topic
from study_reference_packet import BUNDLE_FILE, PURPOSES, build_packets, inputs_name, set_criteria, write_bundle
from study_topic import TopicError, load_topic, require_screened, topic_arguments


def rank_list(text):
    try:
        ranks = [int(r) for r in text.split(",")]
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not a comma-separated list of ranks") from None
    if any(r < 1 for r in ranks) or len(set(ranks)) != len(ranks):
        raise argparse.ArgumentTypeError(f"{text!r} must list distinct positive ranks")
    return ranks


def main(argv=None, fetch=None):
    args = topic_arguments("Write the anchors bundle and build one stratum's reference inputs, read at each row's pinned commit and capped per row.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--stratum"], {"required": True, "help": "stratum to build"}),
                           (["--batch"], {"help": "a drawn batch: calibration, top-up or held-out-<n>"}),
                           (["--purpose"], {"choices": list(PURPOSES), "help": "rows outside the drawn batches, named by --ranks"}),
                           (["--ranks"], {"type": rank_list, "help": "comma-separated ranks for --purpose"})).parse_args(argv)
    try:
        if args.ranks and not args.purpose:
            raise TopicError("--ranks goes with --purpose; a batch builds its drawn rows")
        topic = load_topic(args.repo, args.topic)
        whole_topic(topic, "the reference packets")
        require_screened(topic, args.stratum)
        bundle = write_bundle(args.repo, topic, args.work, set_criteria(args.work))
        counts = build_packets(topic, args.repo, args.work, args.stratum, fetch or Fetch(), batch=args.batch, purpose=args.purpose, ranks=args.ranks)
    except (TopicError, NetworkRefused) as error:
        sys.exit(f"build-reference-packets: {error}")
    print(f"{BUNDLE_FILE}: sha256 {bundle}")
    print(f"{inputs_name(args.stratum)}: {counts['built']} rows built, {counts['kept']} kept, {counts['trimmed']} trimmed")


if __name__ == "__main__":
    main()
