import json
import re
import urllib.parse
from pathlib import Path

from study_pool import cache_name, read_json, work_file
from study_screening_core import read_jsonl
from study_screening_evidence import file_gone, repo_evidence, tree_error_kind
from study_topic import SNOWBALL_RANK_BASE, TopicError

HEX40 = re.compile(r"[0-9a-f]{40}")
README = re.compile(r"^readme(\.[a-z]+)?$", re.I)
FILES_PER_ROW, FILE_CHARS, README_CHARS, LISTING = 2, 8000, 8000, 60
FACTS = ("stars", "pushed", "created", "description", "channels", "archived", "closed_issues", "merged_prs", "license")
FIRST = re.compile(r"(^|/)(SKILL|AGENTS|CLAUDE)\.md$|(^|/)hooks/hooks\.json$")
REPO_LEVEL = ("commit:", "tree:")


def inputs_file(work, stratum):
    return Path(work) / f"{stratum}-screening-inputs.jsonl"


def tree_paths(fetch, repo, sha, recursive):
    out, status, _ = fetch.run(["gh", "api", f"repos/{repo}/git/trees/{sha}" + ("?recursive=1" if recursive else "")], timeout=120)
    if status != "ok":
        return None, False, f"tree: {status}"
    try:
        body = json.loads(out)
    except ValueError:
        return None, False, "tree: unparsable"
    if not isinstance(body, dict) or not isinstance(body.get("tree"), list):
        return None, False, "tree: unparsable"
    return [e["path"] for e in body["tree"] if isinstance(e, dict) and isinstance(e.get("path"), str)], bool(body.get("truncated")), "ok"


def repo_level(error):
    return error.startswith(REPO_LEVEL)


def unit_paths(fetch, repo, sha, units):
    found, errors = [], []
    for unit in units:
        out, status, _ = fetch.run(["gh", "api", f"repos/{repo}/contents/{urllib.parse.quote(unit.rstrip('/'))}?ref={sha}"], timeout=120)
        try:
            body = json.loads(out) if status == "ok" else None
        except ValueError:
            body = None
        if not isinstance(body, list):
            errors.append(f"unit {unit}: {status if status != 'ok' else 'unparsable listing'}")
            continue
        found += [e["path"] for e in body if isinstance(e, dict) and isinstance(e.get("path"), str)]
    return found, errors


def pinned_tree(fetch, work, repo, units=()):
    cache = Path(work) / "cache" / "trees" / cache_name(repo)
    tree = read_json(work_file(work, Path("cache") / "trees" / cache_name(repo)), {})
    sha = tree.get("oid") if HEX40.fullmatch(tree.get("oid") or "") else None
    if sha and tree.get("paths") and (not tree.get("truncated") or tree.get("partial")):
        return sha, tree["paths"], "ok", bool(tree.get("truncated"))
    if not sha:
        out, status, _ = fetch.run(["gh", "api", f"repos/{repo}/commits/HEAD", "--jq", ".sha"], timeout=60)
        sha = out.strip()
        if status != "ok" or not HEX40.fullmatch(sha):
            return None, [], f"commit: {status}" if status != "ok" else f"commit: no sha in {sha[:60]!r}", False
    paths, truncated, status = tree_paths(fetch, repo, sha, True)
    if status != "ok":
        return sha, [], status, False
    if truncated:
        root, _, status = tree_paths(fetch, repo, sha, False)
        if status != "ok":
            return sha, [], status, False
        listed, errors = unit_paths(fetch, repo, sha, units)
        if errors:
            return sha, [], "; ".join(errors), False
        paths = sorted(set(paths) | set(root) | set(listed))
    if not paths:
        return sha, [], "tree: empty", False
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({"oid": sha, "truncated": truncated, "partial": truncated, "paths": paths}))
    return sha, paths, "ok", truncated


def pick_files(row, paths, partial):
    if row.get("contract_files"):
        return row["contract_files"][:FILES_PER_ROW] if partial else [p for p in row["contract_files"] if p in set(paths)][:FILES_PER_ROW]
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
    sha, paths, status, partial = pinned_tree(fetch, work, row["repo"], row.get("units") or [])
    base = {"order_rank": row["order_rank"], "repo": row["repo"], "facts": {k: row[k] for k in FACTS if k in row}}
    if status != "ok":
        return {**base, **({"sha": sha} if sha else {}), "error": status, "error_kind": tree_error_kind(status) if repo_level(status) else "transient"}
    problems = {"missing": [], "errors": []}

    def checked(entry, label):
        if "error" not in entry:
            return entry
        problems["missing" if file_gone(entry["error"]) else "errors"].append(f"{label}: {entry['error']}")
        return None

    def read_text(path, limit):
        entry = checked(read_file(fetch, row["repo"], sha, path, limit), path)
        return entry["text"] if entry else ""

    readme_path = next((p for p in paths if "/" not in p and README.match(p)), None)
    readme = (checked(read_file(fetch, row["repo"], sha, readme_path, README_CHARS), "README") if readme_path else None) or {"text": ""}
    if not readme_path:
        problems["missing"].append("README: no root README in the pinned tree")
    files = [f for f in (checked(read_file(fetch, row["repo"], sha, p, FILE_CHARS), p) for p in pick_files(row, paths, partial)) if f]
    problems["missing"] += [f"{p}: not in the pinned tree" for p in (row.get("contract_files") or [])[:FILES_PER_ROW] if not partial and p not in set(paths)]
    evidence = repo_evidence(fetch, row["repo"], paths, read_text, problems)
    out = {**base, "sha": sha, "listing": sorted({p.split("/", 1)[0] for p in paths})[:LISTING], "readme": readme["text"], "files": files, "evidence": evidence,
           **({"tree": "partial"} if partial else {}), **({"missing": problems["missing"]} if problems["missing"] else {})}
    return {**out, "error": "; ".join(problems["errors"]), "error_kind": "transient"} if problems["errors"] else out


def scored_ranks(work, stratum):
    meta = Path(work) / "meta.json"
    sessions = json.loads(meta.read_text()).get("sessions", {}) if meta.is_file() else {}
    return {r for key, entry in sessions.items() if key.startswith(f"{stratum}-") for block in entry.get("blocks", []) for r in block.get("ranks", [])}


def write_rows(target, held):
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_text("".join(json.dumps(held[r], ensure_ascii=False) + "\n" for r in sorted(held)))
    temporary.replace(target)


def mark_gone(held, scored, stratum, ranks):
    for rank in ranks:
        if rank in scored:
            raise TopicError(f"{stratum} rank {rank} is already scored; drop its blocks with drop-screening-block.py before changing its inputs")
        if "error" not in held.get(rank, {}):
            raise TopicError(f"{stratum} rank {rank} holds no fetch error to mark permanent")
        if held[rank].get("error_kind") == "permanent":
            raise TopicError(f"{stratum} rank {rank} is already permanent")
        if not repo_level(held[rank]["error"]):
            raise TopicError(f"{stratum} rank {rank} failed on {held[rank]['error']}, not on its commit or tree; only a commit: or tree: error can be marked permanent, "
                             "when a check by hand finds the repository or commit gone; fetch it again instead")
        held[rank] = {**held[rank], "error_kind": "permanent", "error": held[rank]["error"] + "; marked permanent by the operator: repository or commit gone"}


def fetch_inputs(topic, work, stratum, through, fetch, mark_permanent=()):
    order = read_jsonl(Path(work), f"{stratum}-screening-order.jsonl")
    if not order:
        raise TopicError(f"no {stratum}-screening-order.jsonl in {work}")
    target = inputs_file(work, stratum)
    held = {r["order_rank"]: r for r in read_jsonl(Path(work), target.name)}
    scored, fetched = scored_ranks(work, stratum), 0
    mark_gone(held, scored, stratum, mark_permanent)
    if mark_permanent:
        write_rows(target, held)
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
