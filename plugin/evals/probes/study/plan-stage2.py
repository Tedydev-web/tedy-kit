import json
import sys
from pathlib import Path

from study_qgs import whole_topic
from study_stage2 import plan_file, stage2_plan
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None):
    args = topic_arguments("List every stage-1 pass of every stratum for stage 2; with --limit, rank the passes of all strata together by facet and stop on the pooled "
                           "recall target over the whole deduplicated standard, recording the stop.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--limit"], {"type": int, "help": "the most rows stage 2 can screen across all strata; default every pass"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        whole_topic(topic, "stage 2")
        plans = stage2_plan(topic, args.work, args.limit)
    except TopicError as error:
        sys.exit(f"plan-stage2: {error}")
    for stratum, plan in plans.items():
        (Path(args.work) / plan_file(stratum)).write_text(json.dumps(plan, indent=1) + "\n")
        print(f"{stratum}: {len(plan['passes'])} of {plan['pool']} rows passed stage 1 ({plan['auto_passes']} with no text); stage 2 screens {len(plan['order'])}")
    stop = next(iter(plans.values()))["stop"]
    if stop:
        print(f"pooled stop at depth {stop['depth']}: {stop['found']} of {stop['members']} deduplicated standard members screened; {stop['rule']}")


if __name__ == "__main__":
    main()
