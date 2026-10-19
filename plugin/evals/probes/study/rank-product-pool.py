import json
import sys
from pathlib import Path

from study_rank import rank_product
from study_topic import TopicError, load_topic, topic_arguments

PRODUCT_CHANNELS = ("npm", "code", "reverse", "social", "repo", "arxiv", "semantic-scholar")


def main(argv=None):
    args = topic_arguments("Order the product stratum by distinct channels, contract files and a name hit; report the PRISMA counts.",
                           (["--work"], {"required": True, "help": "study working folder"})).parse_args(argv)
    work = Path(args.work)
    try:
        topic = load_topic(args.repo, args.topic)
        if not (work / "product-pool.json").exists():
            raise TopicError(f"no pool at {work / 'product-pool.json'}; run resolve-pool.py --stratum product --states product first")
    except TopicError as error:
        sys.exit(f"rank-product-pool: {error}")
    pool = json.loads((work / "product-pool.json").read_text())
    ranked = rank_product(pool["rows"], topic["terms"])
    identified = {c: sum(1 for r in pool["rows"] if c in r["evidence"]) for c in PRODUCT_CHANNELS}
    prisma = {"identified_per_channel": identified, "union": pool["prisma"]["identified"], "not_resolvable": pool["prisma"]["not_resolvable"],
              "aggregators_removed": len(ranked["aggregators"]), "screenable": len(ranked["rows"]),
              "archived": sum(r["archived"] for r in ranked["rows"]), "forks": sum(r["fork"] for r in ranked["rows"])}
    (work / "product-ranked.json").write_text(json.dumps({"terms": topic["terms"], "prisma": prisma, **ranked}, indent=1))
    print(json.dumps(prisma))


if __name__ == "__main__":
    main()
