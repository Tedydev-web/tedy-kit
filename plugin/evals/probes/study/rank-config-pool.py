import json
import sys
from pathlib import Path

from study_rank import Ranker
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None):
    args = topic_arguments("Order the config stratum pool by focus with vendored and copied assets dropped, and split off aggregators.",
                           (["--work"], {"required": True, "help": "study working folder"}),
                           (["--pool"], {"default": "config-pool.json", "help": "pool file in the working folder"}),
                           (["--out"], {"default": "config-ranked.json", "help": "ranked file written to the working folder"})).parse_args(argv)
    work = Path(args.work)
    try:
        topic = load_topic(args.repo, args.topic)
        if not (work / args.pool).exists():
            raise TopicError(f"no pool at {work / args.pool}; run resolve-pool.py first")
    except TopicError as error:
        sys.exit(f"rank-config-pool: {error}")
    rows = [r for r in json.loads((work / args.pool).read_text())["rows"] if not r["archived"] and not r["fork"]]
    ranked = Ranker(topic["terms"], work / "cache").rank(rows)
    (work / args.out).write_text(json.dumps({"terms": topic["terms"], **ranked}, indent=1))
    print(f"screenable {len(ranked['rows'])}; aggregators {len(ranked['aggregators'])}; snowball repos from paths {len(ranked['snowball_from_paths'])} (new to pool)")


if __name__ == "__main__":
    main()
