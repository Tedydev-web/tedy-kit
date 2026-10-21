import sys
from pathlib import Path

from study_reference_flags import write_flags
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None):
    args = topic_arguments("Compare every blind flagger of the topic config with the reference's first run on a drawn batch, row by row and field by field "
                           "(eligibility derived the same way, the problem ids, Relevance, and a criterion by a full point), count the rows a flagger refused twice "
                           "as unflagged by refusal, and list as rubric rows only the rows a rubric-trigger flagger flags, unless the protocol is frozen.",
                           (["--work"], {"required": True, "help": "the topic's working folder holding the reference and flagger sessions and their inputs"}),
                           (["--batch"], {"default": "calibration", "help": "calibration, top-up, held-out or held-out-<n>"})).parse_args(argv)
    try:
        out, name = write_flags(load_topic(args.repo, args.topic), args.work, args.batch)
    except TopicError as error:
        sys.exit(f"flag-reference-rows: {error}")
    ran = [f"{f['model']} ({f['role']}): {len(f['rows'])} of {f['answered']} answered rows flagged, {len(f['unflagged_by_refusal'])} unflagged by refusal"
           if "not_run" not in f else f"{f['model']} ({f['role']}): not run" for f in out["flaggers"]]
    routed = f"{len(out['rubric_rows'])} rubric rows" if out["routed"] else "for the record only, no rubric rows"
    print(f"{args.batch}: {routed} in {Path(args.work) / name}; " + "; ".join(ran))


if __name__ == "__main__":
    main()
