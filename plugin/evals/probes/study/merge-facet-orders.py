import json
import sys

from study_facets import write_merged
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None):
    args = topic_arguments("Merge the facets' screening orders into one topic order per stratum: one row per repository with its rank in every facet, so each repository is fetched "
                           "and screened once. Topic numbers already given are kept; new repositories are numbered after them by their best facet rank.",
                           (["--work"], {"required": True, "help": "the topic's working folder, holding facets/<facet>/ with each facet's ranking and screening order"})).parse_args(argv)
    try:
        out = write_merged(load_topic(args.repo, args.topic), args.work)
    except TopicError as error:
        sys.exit(f"merge-facet-orders: {error}")
    print(json.dumps({s: {"rows": v["rows"], "shared": v["shared"]} for s, v in out.items()}))


if __name__ == "__main__":
    main()
