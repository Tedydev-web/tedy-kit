import json
import re
import urllib.parse
from pathlib import Path

from study_pool import cache_name, parse_json, read_json
from study_sweep_record import read_jsonl
from study_topic import SNOWBALL_RANK_BASE, TopicError

HEX40 = re.compile(r"[0-9a-f]{40}")
FILES_PER_ROW, FILE_CHARS, README_CHARS, LISTING = 2, 8000, 3000, 60
FACTS = ("stars", "pushed", "created", "description", "channels", "archived")
FIRST = re.compile(r"(^|/)(SKILL|AGENTS|CLAUDE)\.md$|(^|/)hooks/hooks\.json$")


def inputs_file(work, stratum):
    return Path(work) / f"{stratum}-screening-inputs.jsonl"


def pinned_tree(fetch, work, repo):
    tree = read_json(Path(work) / "cache" / "trees" / cache_name(repo), {})
    if HEX40.fullmatch(tree.get("oid") or "") and "paths" in tree:
        return tree["oid"], tree["paths"], "ok"
    out, status, _ = fetch.run(["gh", "api", f"repos/{repo}/commits/HEAD", "--jq", ".sha"], timeout=60)
    sha = out.strip()
    if status != "ok" or not HEX40.fullmatch(sha):
        return None, [], status if status != "ok" else f"no commit sha: {sha[:60]}"
    out, status, _ = fetch.run(["gh", "api", f"repos/{repo}/git/trees/{sha}?recursive=1"], timeout=120)
    body = parse_json(out, status, None)
    return (sha, [e["path"] for e in body.get("tree", [])], "ok") if isinstance(body, dict) else (sha, [], status)


def pick_files(row, paths):
    if row.get("contract_files"):
        return row["contract_files"][:FILES_PER_ROW]
    units = row.get("units") or []
    under = [p for p in paths if any(p == u or p.startswith(u.rstrip("/") + "/") for u in units)]
    return sorted(under, key=lambda p: (not FIRST.search(p), p))[:FILES_PER_ROW]


def read_file(fetch, repo, sha, path, limit):
    out, status, _ = fetch.run(["gh", "api", "-H", "Accept: application/vnd.github.raw", f"repos/{repo}/contents/{urllib.parse.quote(path)}?ref={sha}"], timeout=120)
    entry = {"path": path, "text": out[:limit] if status == "ok" else "", "truncated": status == "ok" and len(out) > limit}
    return entry if status == "ok" else {**entry, "error": status}


def row_inputs(fetch, work, row):
    sha, paths, status = pinned_tree(fetch, work, row["repo"])
    base = {"order_rank": row["order_rank"], "repo": row["repo"], "facts": {k: row[k] for k in FACTS if k in row}}
    if sha is None:
        return {**base, "error": status}
    readme = next((p for p in paths if p.lower() == "readme.md"), None)
    return {**base, "sha": sha, "listing": sorted({p.split("/", 1)[0] for p in paths})[:LISTING],
            "readme": read_file(fetch, row["repo"], sha, readme, README_CHARS)["text"] if readme else "",
            "files": [read_file(fetch, row["repo"], sha, p, FILE_CHARS) for p in pick_files(row, paths)]}


def fetch_inputs(topic, work, stratum, through, fetch):
    order = read_jsonl(Path(work), f"{stratum}-screening-order.jsonl")
    if not order:
        raise TopicError(f"no {stratum}-screening-order.jsonl in {work}")
    target = inputs_file(work, stratum)
    done = {r["order_rank"] for r in read_jsonl(Path(work), target.name)}
    added = 0
    with target.open("a") as out:
        for row in order:
            rank = row["order_rank"]
            if rank in done or not (rank <= through or row.get("forced") or rank > SNOWBALL_RANK_BASE):
                continue
            out.write(json.dumps(row_inputs(fetch, work, row), ensure_ascii=False) + "\n")
            out.flush()
            added += 1
    return added, len(done)
