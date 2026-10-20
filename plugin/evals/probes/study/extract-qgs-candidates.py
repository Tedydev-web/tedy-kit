import json
import re
import sys
from pathlib import Path

from study_fetch import Fetch
from study_pool import readme, term_links
from study_qgs import whole_topic
from study_topic import TopicError, load_topic, term_regex, topic_arguments

CURATED = re.compile(r"awesome|curated", re.I)


def candidates(topic, work, fetch, ranked_name):
    whole_topic(topic, "quasi-gold-standard extraction")
    pattern = topic.get("qgs_list_topic")
    if not isinstance(pattern, str) or not pattern:
        raise TopicError(f"{topic['path']}: qgs_list_topic must be a pattern naming what a curated list is about")
    ranked_file = Path(work) / ranked_name
    if not ranked_file.exists():
        raise TopicError(f"no ranking at {ranked_file}")
    on_topic = re.compile(pattern, re.I)
    term = term_regex(topic["terms"])
    data = json.loads(ranked_file.read_text())
    lists = [a for a in data["aggregators"] if CURATED.search(a["repo"] + " " + a["description"]) and on_topic.search(a["repo"] + " " + a["description"])]
    rows, failed = [], []
    for agg in lists:
        text = readme(fetch, Path(work) / "cache", agg["repo"])
        if text is None:
            failed.append(agg["repo"])
            continue
        heading = ""
        for line in text.splitlines():
            if line.startswith("#"):
                heading = line.strip("# ").strip()[:80]
                continue
            for owner, name, _ in term_links(line, term, agg["repo"]):
                rows.append({"repo": f"{owner}/{name}", "list": agg["repo"], "heading": heading, "line": line.strip()[:400]})
    seen, unique = set(), []
    for row in rows:
        if row["repo"].lower() not in seen:
            seen.add(row["repo"].lower())
            unique.append({**row, "id": len(unique) + 1})
    return lists, failed, rows, unique


def main(argv=None, fetch=None):
    args = topic_arguments("Extract quasi-gold-standard candidates from the curated lists among the aggregators, for two blind judges.",
                           (["--work"], {"required": True, "help": "study working folder"}),
                           (["--ranked"], {"default": "config-ranked.json", "help": "ranking whose aggregators are read"}),
                           (["--stratum"], {"help": "write <stratum>-qgs-candidates.jsonl, the stratum's own standard"})).parse_args(argv)
    try:
        lists, failed, rows, unique = candidates(load_topic(args.repo, args.topic), args.work, fetch or Fetch(), args.ranked)
    except TopicError as error:
        sys.exit(f"extract-qgs-candidates: {error}")
    (Path(args.work) / f"{args.stratum + '-' if args.stratum else ''}qgs-candidates.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in unique))
    print(f"curated lists {len(lists)}; readme failures {len(failed)} {failed[:5]}; candidate lines {len(rows)}; unique repos {len(unique)}")


if __name__ == "__main__":
    main()
