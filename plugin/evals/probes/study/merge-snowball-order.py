import json
import sys
from pathlib import Path

from study_screening_core import read_jsonl
from study_topic import SNOWBALL_RANK_BASE, TopicError, topic_arguments

STRATUM = "config"


def merge(work):
    work = Path(work)
    snowball, order_file = work / "snowball-screening-order.jsonl", work / f"{STRATUM}-screening-order.jsonl"
    for path in (snowball, order_file, work / "snowball-cut.json"):
        if not path.is_file():
            raise TopicError(f"no {path.name} in {work}; run export-screening-order.py and snowball-above-cut.py first")
    order = read_jsonl(work, order_file.name)
    known = {r["repo"].lower() for r in order}
    used = {r["order_rank"] for r in order}
    rank = max([SNOWBALL_RANK_BASE] + [r["order_rank"] for r in order if r["order_rank"] > SNOWBALL_RANK_BASE and not r.get("forced")])
    added = []
    for row in read_jsonl(work, snowball.name):
        if row["repo"].lower() in known:
            continue
        rank += 1
        while rank in used:
            rank += 1
        added.append({**row, "order_rank": rank})
        known.add(row["repo"].lower())
    temporary = order_file.with_name(order_file.name + ".tmp")
    temporary.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in order + added))
    temporary.replace(order_file)
    return added


def main(argv=None):
    args = topic_arguments("Merge the snowballed rows above the cut into the config screening order as rows 1001 and on; rows merged before keep their ranks.",
                           (["--work"], {"required": True, "help": "study working folder"})).parse_args(argv)
    try:
        added = merge(args.work)
    except TopicError as error:
        sys.exit(f"merge-snowball-order: {error}")
    print(f"{STRATUM}: merged {len(added)} snowballed rows ({', '.join(str(r['order_rank']) for r in added) or 'none new'}); fetch their inputs and screen them in both sessions")


if __name__ == "__main__":
    main()
