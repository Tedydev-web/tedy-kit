import json
import re
import urllib.parse
from pathlib import Path

from study_pool import cache_name, read_json
from study_screening_core import read_jsonl
from study_screening_evidence import error_kind, repo_evidence
from study_topic import SNOWBALL_RANK_BASE, TopicError

HEX40 = re.compile(r"[0-9a-f]{40}")
FILES_PER_ROW, FILE_CHARS, README_CHARS, LISTING = 2, 8000, 8000, 60
FACTS = ("stars", "pushed", "created", "description", "channels", "archived", "closed_issues", "merged_prs", "license")
FIRST = re.compile(r"(^|/)(SKILL|AGENTS|CLAUDE)\.md$|(^|/)hooks/hooks\.json$")


def inputs_file(work, stratum):
    return Path(work) / f"{stratum}-screening-inputs.jsonl"


def pinned_tree(fetch, work, repo):
    cache = Path(work) / "cache" / "trees" / cache_name(repo)
    tree = read_json(cache, {})
    if HEX40.fullmatch(tree.get("oid") or "") and tree.get("paths") and not tree.get("truncated"):
        return tree["oid"], tree["paths"], "ok"
    out, status, _ = fetch.run(["gh", "api", f"repos/{repo}/commits/HEAD", "--jq", ".sha"], timeout=60)
    sha = out.strip()
    if status != "ok" or not HEX40.fullmatch(sha):
        return None, [], f"commit: {status}" if status != "ok" else f"commit: no sha in {sha[:60]!r}"
    out, status, _ = fetch.run(["gh", "api", f"repos/{repo}/git/trees/{sha}?recursive=1"], timeout=120)
    if status != "ok":
        return sha, [], f"tree: {status}"
    try:
        body = json.loads(out)
    except ValueError:
        return sha, [], "tree: unparsable"
    if not isinstance(body, dict) or not isinstance(body.get("tree"), list):
        return sha, [], "tree: unparsable"
    if body.get("truncated"):
        return sha, [], "tree: truncated"
    paths = [e["path"] for e in body["tree"] if isinstance(e, dict) and "path" in e]
    if not paths:
        return sha, [], "tree: empty"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({"oid": sha, "truncated": False, "paths": paths}))
    return sha, paths, "ok"


def pick_files(row, paths):
    if row.get("contract_files"):
        return row["contract_files"][:FILES_PER_ROW]
    units = row.get("units") or []
    under = [p for p in paths if any(p == u or p.startswith(u.rstrip("/") + "/") for u in units)]
    return sorted(under, key=lambda p: (not FIRST.search(p), p))[:FILES_PER_ROW]


def read_file(fetch, repo, sha, path, limit):
    out, status, _ = fetch.run(["gh", "api", "-H", "Accept: application/vnd.github.raw", f"repos/{repo}/contents/{urllib.parse.quote(path)}?ref={sha}"], timeout=120)
    if status != "ok":
        return {"path": path, "text": "", "truncated": False, "error": status}
    if "\x00" in out or out.count("�") > 8:
        return {"path": path, "text": "", "truncated": False, "binary": True}
    return {"path": path, "text": out[:limit], "truncated": len(out) > limit}


def row_inputs(fetch, work, row):
    sha, paths, status = pinned_tree(fetch, work, row["repo"])
    base = {"order_rank": row["order_rank"], "repo": row["repo"], "facts": {k: row[k] for k in FACTS if k in row}}
    if status != "ok":
        return {**base, **({"sha": sha} if sha else {}), "error": status, "error_kind": error_kind(status)}
    readme_path = next((p for p in paths if p.lower() == "readme.md"), None)
    readme = read_file(fetch, row["repo"], sha, readme_path, README_CHARS) if readme_path else {"text": ""}
    files = [read_file(fetch, row["repo"], sha, p, FILE_CHARS) for p in pick_files(row, paths)]

    def read_text(path, limit):
        entry = read_file(fetch, row["repo"], sha, path, limit)
        return entry["text"], entry.get("error")

    evidence, evidence_errors = repo_evidence(fetch, row["repo"], paths, read_text)
    errors = ([f"README: {readme['error']}"] if "error" in readme else []) + [f"{f['path']}: {f['error']}" for f in files if "error" in f] + evidence_errors
    out = {**base, "sha": sha, "listing": sorted({p.split("/", 1)[0] for p in paths})[:LISTING], "readme": readme["text"], "files": files, "evidence": evidence}
    if not errors:
        return out
    kinds = {error_kind(e) for e in errors}
    return {**out, "error": "; ".join(errors), "error_kind": "transient" if "transient" in kinds else "permanent"}


def scored_ranks(work, stratum):
    meta = Path(work) / "meta.json"
    sessions = json.loads(meta.read_text()).get("sessions", {}) if meta.is_file() else {}
    return {r for key, entry in sessions.items() if key.startswith(f"{stratum}-") for block in entry.get("blocks", []) for r in block.get("ranks", [])}


def write_rows(target, held):
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_text("".join(json.dumps(held[r], ensure_ascii=False) + "\n" for r in sorted(held)))
    temporary.replace(target)


def fetch_inputs(topic, work, stratum, through, fetch, mark_permanent=()):
    order = read_jsonl(Path(work), f"{stratum}-screening-order.jsonl")
    if not order:
        raise TopicError(f"no {stratum}-screening-order.jsonl in {work}")
    target = inputs_file(work, stratum)
    held = {r["order_rank"]: r for r in read_jsonl(Path(work), target.name)}
    for rank in mark_permanent:
        if "error" not in held.get(rank, {}):
            raise TopicError(f"{stratum} rank {rank} holds no fetch error to mark permanent")
        held[rank] = {**held[rank], "error_kind": "permanent", "error": held[rank]["error"] + "; marked permanent by the operator"}
    if mark_permanent:
        write_rows(target, held)
    scored, fetched = scored_ranks(work, stratum), 0
    for row in order:
        rank = row["order_rank"]
        if rank in scored or (rank in held and held[rank].get("error_kind") != "transient"):
            continue
        if not (rank <= through or row.get("forced") or rank > SNOWBALL_RANK_BASE):
            continue
        held[rank] = row_inputs(fetch, work, row)
        write_rows(target, held)
        fetched += 1
    return fetched, len(held) - fetched, sum(r.get("error_kind") == "transient" for r in held.values())
