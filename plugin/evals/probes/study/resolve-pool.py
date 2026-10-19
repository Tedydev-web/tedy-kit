import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

from study_fetch import Fetch
from study_pool import graphql_repositories, read_json, work_file
from study_topic import TopicError, load_topic, topic_arguments

FIELDS = ("nameWithOwner description createdAt pushedAt stargazerCount isArchived isFork licenseInfo { spdxId } "
          "defaultBranchRef { name target { oid } } issues(states: CLOSED) { totalCount } pullRequests(states: MERGED) { totalCount }")


def merged_hits(work, states):
    hits = {}
    for name in states:
        path = work_file(work, f"{name}-state.json")
        if not path.exists():
            raise TopicError(f"no discovery state at {path}")
        for key, hit in json.loads(path.read_text())["hits"].items():
            entry = hits.setdefault(key, {"repo": hit["repo"], "channels": {}})
            for channel, evidence in hit["channels"].items():
                bucket = entry["channels"].setdefault(channel, [])
                bucket.extend(e for e in evidence if e not in bucket)
    return hits


def impact(info, channels, now):
    days = (now - datetime.fromisoformat(info["pushedAt"].replace("Z", "+00:00"))).days
    maintenance = 1 if days <= 90 else 0.5 if days <= 365 else 0
    discussion = info["issues"]["totalCount"] + info["pullRequests"]["totalCount"]
    return round(math.log10(info["stargazerCount"] + 1) + maintenance + 0.5 * math.log10(discussion + 1) + 0.5 * len(channels), 2)


def resolve(work, states, fetch, now):
    hits = merged_hits(work, states)
    meta_file = Path(work) / "cache" / "meta.json"
    meta = read_json(work_file(work, Path("cache") / "meta.json"), {})
    pending = {k: hits[k]["repo"] for k in hits if k not in meta}
    found, failed = graphql_repositories(fetch, pending, FIELDS)
    meta.update(found)
    meta_file.parent.mkdir(parents=True, exist_ok=True)
    meta_file.write_text(json.dumps(meta))
    canonical, gone = {}, []
    for key, hit in hits.items():
        info = meta.get(key)
        if not info:
            gone.append(hit["repo"])
            continue
        entry = canonical.setdefault(info["nameWithOwner"].lower(), {"info": info, "channels": {}})
        for channel, evidence in hit["channels"].items():
            bucket = entry["channels"].setdefault(channel, [])
            bucket.extend(e for e in evidence if e not in bucket)
    rows = []
    for entry in canonical.values():
        info, channels = entry["info"], entry["channels"]
        branch = info.get("defaultBranchRef") or {}
        rows.append({"repo": info["nameWithOwner"], "stars": info["stargazerCount"], "pushed": info["pushedAt"][:10], "created": info["createdAt"],
                     "license": (info.get("licenseInfo") or {}).get("spdxId") or "none", "closed_issues": info["issues"]["totalCount"],
                     "merged_prs": info["pullRequests"]["totalCount"], "channels": sorted(channels), "via": [e for c in sorted(channels) for e in channels[c]],
                     "evidence": channels, "description": info.get("description") or "", "branch": branch.get("name") or "HEAD",
                     "oid": (branch.get("target") or {}).get("oid"), "archived": info["isArchived"], "fork": info["isFork"], "impact": impact(info, channels, now)})
    rows.sort(key=lambda r: r["repo"].lower())
    prisma = {"identified": len(hits), "not_resolvable": len(gone), "unresolved_batches": failed, "resolved": len(rows),
              "archived": sum(r["archived"] for r in rows), "forks": sum(r["fork"] for r in rows)}
    return rows, prisma


def main(argv=None, fetch=None, now=None):
    args = topic_arguments("Resolve discovery hits to live GitHub repositories with metadata and a pinned head commit.",
                           (["--work"], {"required": True, "help": "study working folder"}),
                           (["--stratum"], {"required": True, "help": "stratum whose pool is written"}),
                           (["--states"], {"required": True, "help": "comma-separated discovery states to merge, e.g. config,snowball"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        if args.stratum not in topic["strata"]:
            raise TopicError(f"topic {topic['name']} has no {args.stratum} stratum")
        rows, prisma = resolve(args.work, [s for s in args.states.split(",") if s], fetch or Fetch(), now or datetime.now(timezone.utc))
    except TopicError as error:
        sys.exit(f"resolve-pool: {error}")
    (Path(args.work) / f"{args.stratum}-pool.json").write_text(json.dumps({"rows": rows, "prisma": prisma}, indent=1))
    print(json.dumps(prisma))


if __name__ == "__main__":
    main()
