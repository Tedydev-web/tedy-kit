import json
import sys
from pathlib import Path

from study_qgs import whole_topic
from study_stage1_audit import NEAR_ROWS, FAR_ROWS, audit_file, draw
from study_topic import TopicError, load_topic, require_screened, topic_arguments


def main(argv=None):
    args = topic_arguments(f"Draw the stage-1 audit of a stratum: the model disagreements, {NEAR_ROWS} near-boundary excludes (both models said no, but the name or "
                           f"description holds a term of a facet, or a topic term when the topic has no facets) and {FAR_ROWS} far excludes, each ranked by its sha256 under the sweep name.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--stratum"], {"required": True, "help": "stratum to audit"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        whole_topic(topic, "the stage-1 audit")
        require_screened(topic, args.stratum)
        audit = draw(topic, args.work, args.stratum)
    except TopicError as error:
        sys.exit(f"draw-stage1-audit: {error}")
    (Path(args.work) / audit_file(args.stratum)).write_text(json.dumps(audit, indent=1) + "\n")
    print(f"{args.stratum}: {len(audit['disagreements'])} disagreements; near {len(audit['near'])} of {audit['near_pool']}; far {len(audit['far'])} of {audit['far_pool']}; "
          "fetch them with fetch-screening-inputs.py --set stage1-audit, then run-judge.py --judge screening-A --set stage1-audit")


if __name__ == "__main__":
    main()
