import json
import sys
from pathlib import Path

from study_qgs import whole_topic
from study_stage2 import plan_file, stage2_plan
from study_topic import TopicError, load_topic, require_screened, topic_arguments


def main(argv=None):
    args = topic_arguments("List every stage-1 pass of a stratum for stage 2; with --limit, rank the passes by facet and stop on the pooled recall target, recording the stop.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--stratum"], {"required": True, "help": "stratum to plan"}),
                           (["--limit"], {"type": int, "help": "the most rows stage 2 can screen; default every pass"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        whole_topic(topic, "stage 2")
        require_screened(topic, args.stratum)
        plan = stage2_plan(topic, args.work, args.stratum, args.limit)
    except TopicError as error:
        sys.exit(f"plan-stage2: {error}")
    (Path(args.work) / plan_file(args.stratum)).write_text(json.dumps(plan, indent=1) + "\n")
    stop = plan["stop"]
    print(f"{args.stratum}: {len(plan['passes'])} of {plan['pool']} rows passed stage 1 ({plan['auto_passes']} with no text); stage 2 screens {len(plan['order'])}"
          + (f", stopped at depth {stop['depth']} holding {stop['found']} of {stop['members']} standard members" if stop else ""))


if __name__ == "__main__":
    main()
