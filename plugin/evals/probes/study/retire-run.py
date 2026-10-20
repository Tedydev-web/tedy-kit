import sys

from study_drop import retire_run
from study_topic import TopicError, load_topic, saigon_today, topic_arguments


def main(argv=None):
    args = topic_arguments("Retire a cross-family audit or QGS run whose blocks drop-run.py dropped and that cannot run again (its model is unreachable); meta.json records the "
                           "retirement with its reason and the record states the run pending or absent with that reason. Roster sessions are never retired.",
                           (["--work"], {"required": True, "help": "study working folder"}),
                           (["--key"], {"required": True, "help": "meta.json session key, e.g. product-audit-gemini-3.8-flash-high or qgs-cross-gemini-3.8-flash-high"}),
                           (["--reason"], {"required": True, "help": "why the run is not run again; recorded in meta.json and stated in the record"}),
                           (["--today"], {"default": saigon_today(), "help": "retirement date, default today in Asia/Saigon"})).parse_args(argv)
    try:
        load_topic(args.repo, args.topic)
        retire_run(args.work, args.key, args.reason, args.today)
    except TopicError as error:
        sys.exit(f"retire-run: {error}")
    print(f"{args.key}: retired ({args.reason.strip()})")


if __name__ == "__main__":
    main()
