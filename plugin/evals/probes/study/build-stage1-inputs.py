import json
import sys
from pathlib import Path

from study_calibration_set import set_file
from study_fetch import Fetch, NetworkRefused
from study_qgs import whole_topic
from study_stage1 import SHAPES, auto_pass, build_inputs, held_out_batches, inputs_name
from study_topic import TopicError, load_topic, require_screened, topic_arguments


def drawn_ranks(work, stratum):
    paths = [Path(work) / set_file(b) for b in ("calibration", "top-up", *held_out_batches(work))]
    ranks = {r["order_rank"] for p in paths if p.is_file() for r in json.loads(p.read_text())["rows"] if r["stratum"] == stratum}
    if not ranks:
        raise TopicError(f"no {stratum} row is drawn in calibration-set.json, top-up-set.json or a held-out batch; draw the batch first")
    return ranks


def main(argv=None, fetch=None):
    args = topic_arguments("Build the stage-1 inputs of one stratum's whole pool in one shape; the calibration runs and the pool runs read the same file.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--stratum"], {"required": True, "help": "stratum to build"}),
                           (["--shape"], {"required": True, "choices": list(SHAPES), "help": "brief: name and description; paths: plus agent-asset paths for config; "
                                                                                             "readme: plus the README lead"}),
                           (["--drawn-only"], {"action": "store_true", "help": "build only the rows of the drawn calibration, top-up and held-out batches, so a rung "
                                                                                "can be measured before the whole pool is fetched; the pool run refuses the file until "
                                                                                "it is built again without this flag"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        whole_topic(topic, "stage 1")
        require_screened(topic, args.stratum)
        ranks = drawn_ranks(args.work, args.stratum) if args.drawn_only else None
        rows = build_inputs(args.work, args.stratum, args.shape, fetch or Fetch(), ranks)
    except (TopicError, NetworkRefused) as error:
        sys.exit(f"build-stage1-inputs: {error}")
    print(f"{inputs_name(args.stratum, args.shape)}: {len(rows)} rows, {sum(auto_pass(r) for r in rows)} pass stage 1 unread because they carry no text")


if __name__ == "__main__":
    main()
