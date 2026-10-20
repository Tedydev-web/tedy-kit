import json
import sys
from pathlib import Path

from study_facets import depth_plan, depth_ranks, facet_names, standard_labels
from study_pool import read_json
from study_screening_core import read_jsonl
from study_topic import TopicError, load_topic, require_screened, topic_arguments, write_stop_row


def screened_by_both(work, stratum):
    sides = [{r["order_rank"] for r in read_jsonl(Path(work), f"{stratum}-screen-{s}.jsonl")} for s in "AB"]
    return sides[0] & sides[1]


def plan(topic, work, stratum):
    order = read_jsonl(Path(work), f"{stratum}-screening-order.jsonl")
    if not order or "facets" not in order[0]:
        raise TopicError(f"no merged {stratum}-screening-order.jsonl in {work}; run merge-facet-orders.py first")
    labels = standard_labels(read_json(Path(work) / f"{stratum}-qgs-adjudicated.json", {}))
    screened = screened_by_both(work, stratum)
    out = depth_plan(topic, order, labels, screened)
    needed = depth_ranks(order, {f: s["row"] for f, s in out["stops"].items()})
    return out, sorted(needed - screened)


def main(argv=None):
    args = topic_arguments("Derive each facet's screening depth from the pooled quasi-gold standard: 60 rows at least, then blocks of 10 until pooled recall reaches 0.80 or the "
                           "200-row cap; list the rows still to screen, and with --write-stop write each facet's stop row once both sessions screened them.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--stratum"], {"required": True, "help": "stratum to plan"}),
                           (["--write-stop"], {"action": "store_true", "help": "write facets.<facet>.strata.<stratum>.stop_row for every facet"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        require_screened(topic, args.stratum)
        out, unscreened = plan(topic, args.work, args.stratum)
        if args.write_stop:
            if unscreened:
                raise TopicError(f"ranks {unscreened[:20]}{' ...' if len(unscreened) > 20 else ''} lie within a facet's depth but were not screened by both sessions; screen them first")
            for facet in facet_names(topic):
                write_stop_row(load_topic(args.repo, f"{topic['name']}:{facet}"), args.stratum, out["stops"][facet]["row"])
    except TopicError as error:
        sys.exit(f"facet-depth: {error}")
    print(json.dumps({**out, "interval": [round(v, 3) for v in out["interval"]], "unscreened": unscreened,
                      "facets": {f: {**v, "interval": [round(x, 3) for x in v["interval"]] if v["interval"] else None} for f, v in out["facets"].items()}}, indent=1))


if __name__ == "__main__":
    main()
