import sys
from pathlib import Path

from study_reference_labels import derive_labels
from study_rubric_worksheet import questions_file, write_worksheet
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None):
    args = topic_arguments("Turn the reference's replies into labels: check every cite against the row the reference read, score a failed cite 0 and flag it, take a "
                           "re-run's value only for the criterion and rows an interpretation note selects, derive the decision by the judges' rule and keep the labels "
                           "with their labeller. With --worksheet, list the rubric-trigger flags as questions instead.",
                           (["--work"], {"required": True, "help": "the topic's working folder holding the reference sessions and their inputs"}),
                           (["--batch"], {"default": "calibration", "help": "calibration, top-up, held-out or held-out-<n>; or a purpose: exclusion-audit-<rung>, "
                                                                            "stage1-flags or adjudication"}),
                           (["--criteria"], {"default": "docs/prior-art/quality-criteria-v4.md", "help": "the criteria file a note quotes, relative to --repo"}),
                           (["--worksheet"], {"action": "store_true", "help": "write rubric-questions-<batch>.md from reference-flags-<batch>.json: a disagreement the "
                                                                              "criteria settle becomes a rule note, the rest at most five A/B anchor questions with "
                                                                              "rubric-wordings-<batch>.json; once every question is chosen, applied and noted, write "
                                                                              "rubric-outcomes-<batch>.json"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        if args.worksheet:
            sheet = write_worksheet(topic, args.repo, args.work, args.batch, args.criteria)
        else:
            rows, name = derive_labels(topic, args.repo, args.work, args.batch, args.criteria)
    except TopicError as error:
        sys.exit(f"derive-reference-labels: {error}")
    if args.worksheet:
        print(f"{Path(args.work) / questions_file(args.batch)}: {len(sheet['questions'])} questions, {sum(len(r['rows']) for r in sheet['rules'])} rows applied by rule, "
              f"{len({c['id'] for c in sheet['contested']})} rows contested; " + (f"outcomes in {sheet['outcomes']}" if sheet["outcomes"] else f"{len(sheet['pending'])} items pending"))
        return
    flagged = sum(1 for r in rows if r["flags"])
    print(f"labelled {len(rows)} rows of {args.batch} from the reference in {Path(args.work) / name}; {flagged} rows flagged")


if __name__ == "__main__":
    main()
