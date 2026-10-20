import json
import sys
from pathlib import Path

from study_qgs import DROPPED, candidates, dropped, whole_topic
from study_topic import TopicError, load_topic, saigon_today, topic_arguments


def main(argv=None):
    args = topic_arguments("Drop QGS candidates that cannot be judged by both judges, with a reason; the standard leaves them out and the record lists them.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--ids"], {"required": True, "help": "comma-separated candidate ids"}),
                           (["--reason"], {"required": True, "help": "why they are dropped"}),
                           (["--today"], {"default": saigon_today(), "help": "drop date, default today in Asia/Saigon"})).parse_args(argv)
    try:
        whole_topic(load_topic(args.repo, args.topic), "dropping QGS candidates")
        if not args.reason.strip():
            raise TopicError("a dropped candidate needs a reason")
        listed = candidates(args.work)
        ids = [int(i) for i in args.ids.split(",") if i.strip()]
        unknown = [i for i in ids if i not in listed]
        if unknown or not ids:
            raise TopicError(f"ids {unknown or args.ids!r} are not candidates")
        drops = dropped(args.work)
        drops.update({i: {"repo": listed[i], "reason": args.reason.strip(), "date": args.today} for i in ids})
        (Path(args.work) / DROPPED).write_text(json.dumps({str(i): drops[i] for i in sorted(drops)}, indent=1, ensure_ascii=False) + "\n")
    except (TopicError, ValueError) as error:
        sys.exit(f"drop-qgs-candidates: {error}")
    print(f"dropped candidates {ids} ({args.reason.strip()})")


if __name__ == "__main__":
    main()
