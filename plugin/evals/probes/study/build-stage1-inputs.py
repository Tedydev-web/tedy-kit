import sys

from study_fetch import Fetch, NetworkRefused
from study_qgs import whole_topic
from study_stage1 import SHAPES, auto_pass, build_inputs, inputs_name
from study_topic import TopicError, load_topic, require_screened, topic_arguments


def main(argv=None, fetch=None):
    args = topic_arguments("Build the stage-1 inputs of one stratum's whole pool in one shape; the calibration runs and the pool runs read the same file.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--stratum"], {"required": True, "help": "stratum to build"}),
                           (["--shape"], {"required": True, "choices": list(SHAPES), "help": "brief: name and description; paths: plus agent-asset paths for config; "
                                                                                             "readme: plus the README lead"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        whole_topic(topic, "stage 1")
        require_screened(topic, args.stratum)
        rows = build_inputs(args.work, args.stratum, args.shape, fetch or Fetch())
    except (TopicError, NetworkRefused) as error:
        sys.exit(f"build-stage1-inputs: {error}")
    print(f"{inputs_name(args.stratum, args.shape)}: {len(rows)} rows, {sum(auto_pass(r) for r in rows)} pass stage 1 unread because they carry no text")


if __name__ == "__main__":
    main()
