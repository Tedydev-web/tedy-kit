import sys

from study_drop import drop_block
from study_topic import TopicError, load_topic, saigon_today, topic_arguments


def main(argv=None):
    args = topic_arguments("Drop one block of any recorded run (a screening block, a judge run, a stage-1 run, a QGS judge, the reader or the audit) so it can be run again; "
                           "the rows go to dropped/ and meta.json records the drop with its reason. meta.json is never edited by hand.",
                           (["--work"], {"required": True, "help": "study working folder"}),
                           (["--key"], {"required": True, "help": "meta.json session key, e.g. config-A, judge-config-qgs-A-claude-opus-5-5-run1, stage1-config-brief-claude-sonnet-5-5"}),
                           (["--ranks"], {"required": True, "help": "first-last ranks of the block, as it was run"}),
                           (["--reason"], {"required": True, "help": "why the block is dropped; recorded in meta.json"}),
                           (["--today"], {"default": saigon_today(), "help": "drop date, default today in Asia/Saigon"})).parse_args(argv)
    try:
        load_topic(args.repo, args.topic)
        first, _, last = args.ranks.partition("-")
        if not (first.isdigit() and last.isdigit()):
            raise TopicError(f"--ranks {args.ranks!r} must read first-last")
        rows, free, name, mechanisms = drop_block(args.work, args.key, int(first), int(last), args.reason, args.today)
    except TopicError as error:
        sys.exit(f"drop-run: {error}")
    print(f"{args.key}: dropped the block for ranks {args.ranks}, {rows} rows and mechanism lines {mechanisms}; copies are dropped/{name}.*; inputs cleared for ranks {free}")


if __name__ == "__main__":
    main()
