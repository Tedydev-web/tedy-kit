import sys
from pathlib import Path

from study_reference_labels import derive_labels
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None):
    args = topic_arguments("Turn the reference's replies into labels: check every cite against the row the reference read, score a failed cite 0 and flag it, take a "
                           "re-run's value only for the criterion and rows an interpretation note selects, derive the decision by the judges' rule and keep the labels "
                           "with their labeller.",
                           (["--work"], {"required": True, "help": "the topic's working folder holding the reference sessions and their inputs"}),
                           (["--batch"], {"default": "calibration", "help": "calibration, top-up, held-out or held-out-<n>; or a purpose: exclusion-audit-<rung>, "
                                                                            "stage1-flags or adjudication"}),
                           (["--criteria"], {"default": "docs/prior-art/quality-criteria-v4.md", "help": "the criteria file a note quotes, relative to --repo"})).parse_args(argv)
    try:
        rows, name = derive_labels(load_topic(args.repo, args.topic), args.repo, args.work, args.batch, args.criteria)
    except TopicError as error:
        sys.exit(f"derive-reference-labels: {error}")
    flagged = sum(1 for r in rows if r["flags"])
    print(f"labelled {len(rows)} rows of {args.batch} from the reference in {Path(args.work) / name}; {flagged} rows flagged")


if __name__ == "__main__":
    main()
