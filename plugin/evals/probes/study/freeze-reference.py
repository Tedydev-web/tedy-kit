import sys

from study_qgs import whole_topic
from study_reference_freeze import freeze_batch, freeze_file
from study_topic import TopicError, load_topic, saigon_today, topic_arguments


def coverage_text(part):
    return part if isinstance(part, str) else f"answered {part['answered']}, unflagged by refusal {len(part['unflagged_by_refusal'])}"


def main(argv=None):
    args = topic_arguments("Freeze one reference-labelled batch before any judge or stage-1 calibration run reads it: the labels, set, cites and notes hashes, the anchors "
                           "bundle the first run and the latest re-run read, the reference and flagger session hashes, each flagger's coverage with rows refused twice "
                           "counted as unflagged by refusal, and the outcome of every rubric row. A freeze is never rewritten; a later batch gets its own.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--batch"], {"required": True, "help": "calibration, top-up or held-out[-<n>]"}),
                           (["--without-flaggers"], {"help": "the reason a flagger did not run, recorded as \"not run: <reason>\" once the user chose the no-flagger fallback"}),
                           (["--today"], {"default": saigon_today(), "help": "freeze date, default today in Asia/Saigon"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        whole_topic(topic, "the reference freeze")
        out = freeze_batch(topic, args.repo, args.work, args.batch, args.today, args.without_flaggers)
    except TopicError as error:
        sys.exit(f"freeze-reference: {error}")
    coverage = "; ".join(f"{m} {coverage_text(v)}" for m, v in out["flaggers"].items())
    print(f"{freeze_file(args.batch)}: labels {out['labels_sha256'][:16]}, {out['rubric']['flagged']} rubric rows ({out['rubric']['contested']} contested); {coverage}")


if __name__ == "__main__":
    main()
