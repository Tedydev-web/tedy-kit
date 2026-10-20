import json
import sys
from pathlib import Path

from study_fetch import Fetch
from study_pool import ASSET, cache_name, parse_json, work_file
from study_topic import TopicError, load_topic, topic_arguments


def fetch_trees(work, stratum, fetch):
    pool_file = work_file(work, f"{stratum}-pool.json")
    if not pool_file.exists():
        raise TopicError(f"no pool at {pool_file}; run resolve-pool.py first")
    trees, shas = Path(work) / "cache" / "trees", Path(work) / "cache" / "asset-shas"
    trees.mkdir(parents=True, exist_ok=True)
    shas.mkdir(parents=True, exist_ok=True)
    fetched = errors = 0
    for row in json.loads(pool_file.read_text())["rows"]:
        if row["archived"] or row["fork"]:
            continue
        name = cache_name(row["repo"])
        if work_file(work, Path("cache") / "trees" / name).exists() and work_file(work, Path("cache") / "asset-shas" / name).exists():
            continue
        ref = row.get("oid") or row.get("branch") or "HEAD"
        out, status, _ = fetch.run(["gh", "api", f"repos/{row['repo']}/git/trees/{ref}?recursive=1"], timeout=120)
        body = parse_json(out, status, None)
        if not isinstance(body, dict):
            errors += 1
            (trees / name).write_text(json.dumps({"error": status}))
            (shas / name).write_text(json.dumps({"error": status}))
            continue
        entries = body.get("tree", [])
        (trees / name).write_text(json.dumps({"oid": ref, "truncated": body.get("truncated", False), "paths": [e["path"] for e in entries]}))
        (shas / name).write_text(json.dumps({"truncated": body.get("truncated", False),
                                             "shas": {e["path"]: e["sha"] for e in entries if e.get("type") == "blob" and ASSET.search(e["path"])}}))
        fetched += 1
    return fetched, errors


def main(argv=None, fetch=None):
    args = topic_arguments("Fetch the git tree and agent-asset blob SHAs of every live repository in a stratum pool.",
                           (["--work"], {"required": True, "help": "study working folder"}),
                           (["--stratum"], {"default": "config", "help": "stratum pool to read"})).parse_args(argv)
    try:
        load_topic(args.repo, args.topic)
        fetched, errors = fetch_trees(args.work, args.stratum, fetch or Fetch())
    except TopicError as error:
        sys.exit(f"fetch-repo-trees: {error}")
    print(f"trees fetched {fetched}; errors {errors}")


if __name__ == "__main__":
    main()
