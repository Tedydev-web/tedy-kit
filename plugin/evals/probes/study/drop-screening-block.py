import sys

from study_drop import drop_block
from study_topic import TopicError, load_topic, require_screened, saigon_today, topic_arguments


def main(argv=None):
    args = topic_arguments("Drop one scored block of a screening session; ranks no other session block holds can then be fetched and screened again. Copies go to dropped/, "
                           "and meta.json records the drop with its reason.",
                           (["--work"], {"required": True, "help": "study working folder"}),
                           (["--stratum"], {"required": True, "help": "stratum of the session"}),
                           (["--session"], {"required": True, "help": "meta.json session key, e.g. config-A or config-pilot-A"}),
                           (["--ranks"], {"required": True, "help": "first-last ranks of the block, as it was run"}),
                           (["--reason"], {"required": True, "help": "why the block is dropped; recorded in meta.json"}),
                           (["--today"], {"default": saigon_today(), "help": "drop date, default today in Asia/Saigon"})).parse_args(argv)
    try:
        require_screened(load_topic(args.repo, args.topic), args.stratum)
        if not args.session.startswith(f"{args.stratum}-"):
            raise TopicError(f"session {args.session} is not in the {args.stratum} stratum")
        first, _, last = args.ranks.partition("-")
        if not (first.isdigit() and last.isdigit()):
            raise TopicError(f"--ranks {args.ranks!r} must read first-last")
        rows, free, name, mechanisms = drop_block(args.work, args.session, int(first), int(last), args.reason, args.today)
    except TopicError as error:
        sys.exit(f"drop-screening-block: {error}")
    print(f"{args.session}: dropped the block for ranks {args.ranks}, {rows} rows and mechanism lines {mechanisms}; copies are dropped/{name}.*; "
          f"inputs cleared for ranks {free} so fetch-screening-inputs.py fetches them again; ranks another session block still holds keep their inputs")


if __name__ == "__main__":
    main()
