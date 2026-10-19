import json
import sys
from pathlib import Path

from study_topic import TopicError, load_topic, topic_arguments

FIELDS = ("order_rank", "repo", "order", "units", "contract_files", "stars", "pushed", "created", "channels", "via", "description", "aggregator", "archived",
          "closed_issues", "merged_prs", "license")
HARD_CAP = 200


def screening_order(topic, stratum, ranked, limit):
    forced_repos = topic["strata"].get(stratum, {}).get("forced_repos")
    if not isinstance(forced_repos, list):
        raise TopicError(f"{topic['path']}: strata.{stratum}.forced_repos must be a list")
    forced = {name.lower() for name in forced_repos}
    last = max([0] + [r["order_rank"] for r in ranked["rows"]])
    aggregators = [{**a, "order_rank": last + i} for i, a in enumerate((a for a in ranked.get("aggregators", []) if a["repo"].lower() in forced), 1)]
    pool = ranked["rows"] + ranked.get("aggregators", [])
    keep = ranked["rows"][:limit] + [r for r in ranked["rows"] if r["repo"].lower() in forced and r["order_rank"] > limit] + aggregators
    missing = sorted(forced - {r["repo"].lower() for r in pool})
    return [{**{k: r[k] for k in FIELDS if k in r}, "forced": r["repo"].lower() in forced} for r in keep], missing


def main(argv=None):
    args = topic_arguments("Write the screening order of a stratum: its top rows plus the topic's forced repositories wherever they rank.",
                           (["--work"], {"required": True, "help": "study working folder"}),
                           (["--stratum"], {"required": True, "help": "stratum whose <stratum>-ranked.json is read"}),
                           (["--ranked"], {"help": "ranking file in the working folder, default <stratum>-ranked.json"}),
                           (["--limit"], {"type": int, "default": HARD_CAP, "help": f"rows taken in order, at most {HARD_CAP}"})).parse_args(argv)
    work = Path(args.work)
    ranked_file = work / (args.ranked or f"{args.stratum}-ranked.json")
    try:
        if not 0 < args.limit <= HARD_CAP:
            raise TopicError(f"--limit must be between 1 and {HARD_CAP}, the criteria's hard cap")
        if not ranked_file.exists():
            raise TopicError(f"no ranking at {ranked_file}")
        rows, missing = screening_order(load_topic(args.repo, args.topic), args.stratum, json.loads(ranked_file.read_text()), args.limit)
    except TopicError as error:
        sys.exit(f"export-screening-order: {error}")
    (work / f"{args.stratum}-screening-order.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    print(f"rows {len(rows)}; forced {sum(r['forced'] for r in rows)}; forced repositories not in the pool: {missing}")


if __name__ == "__main__":
    main()
