import json
import sys
from pathlib import Path

from study_fetch import Fetch
from study_pool import Pool, readme, term_links
from study_topic import TopicError, load_topic, term_regex, topic_arguments


def snowball(topic, work, fetch, ranked_name):
    work = Path(work)
    ranked_file = work / ranked_name
    if not ranked_file.exists():
        raise TopicError(f"no ranking at {ranked_file}; run rank-config-pool.py first")
    data = json.loads(ranked_file.read_text())
    term = term_regex(topic["terms"])
    known = {r["repo"].lower() for r in data["rows"]} | {a["repo"].lower() for a in data["aggregators"]}
    found = {k: set(v) for k, v in data["snowball_from_paths"].items()}
    failed = []
    for agg in data["aggregators"]:
        text = readme(fetch, work / "cache", agg["repo"])
        if text is None:
            failed.append(agg["repo"])
            continue
        for owner, name, _ in term_links(text, term, agg["repo"]):
            found.setdefault(f"{owner}/{name}".lower(), set()).add(agg["repo"])
    pool = Pool(work / "snowball-state.json", topic["terms"])
    fresh = 0
    for key, sources in sorted(found.items()):
        if key in known:
            continue
        owner, name = key.split("/", 1)
        for source in sorted(sources)[:6]:
            fresh += pool.add(owner, name, "snowball", f"snowball from {source}")
    pool.record("snowball aggregators", "snowball", f"{len(data['aggregators'])} aggregators: tree paths and README lines with a topic term", "ok" if not failed else f"readme failures: {', '.join(failed[:10])}",
                0, len(found), len(found), fresh)
    return len(data["aggregators"]), len(found), fresh, failed


def main(argv=None, fetch=None):
    args = topic_arguments("Snowball the aggregators: repositories they hold or link with a topic term join the pool as the snowball state.",
                           (["--work"], {"required": True, "help": "study working folder"}),
                           (["--ranked"], {"default": "config-ranked.json", "help": "ranking whose aggregators are read"})).parse_args(argv)
    try:
        aggregators, candidates, fresh, failed = snowball(load_topic(args.repo, args.topic), args.work, fetch or Fetch(), args.ranked)
    except TopicError as error:
        sys.exit(f"snowball-aggregators: {error}")
    print(f"aggregators {aggregators}; snowball candidates {candidates}; new to pool {fresh}; readme failures {len(failed)}")


if __name__ == "__main__":
    main()
