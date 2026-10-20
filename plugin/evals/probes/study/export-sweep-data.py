import json
import re
import sys
from pathlib import Path

from study_pool import DISCOVERY_STATES, work_file
from study_topic import TopicError, load_topic, sweep_folder, topic_arguments

HEX40 = re.compile(r"[0-9a-f]{40}")
LONGHEX = re.compile(r"\b[0-9a-fA-F]{32,}\b")
DIGEST = re.compile(r"[0-9a-f]{64}")
HOME_PATH = re.compile(r"/(?:home|Users)/[^/\s]+/")
ORDER_FIELDS = ("order_rank", "repo", "order", "units", "contract_files", "stars", "pushed", "created", "channels", "archived", "forced", "closed_issues", "merged_prs", "license")
SHARED_JSON = ("meta.json", "study.json", "surface-map.json", "mechanism-table.json", "qgs-adjudicated.json", "protocol-freeze.json", "calibration-sample.json", "snowball-cut.json")
SHARED_JSONL = ("qgs-candidates.jsonl", "qgs-judge-A.jsonl", "qgs-judge-B.jsonl", "snowball-screening-order.jsonl")


def pin(row):
    sha = row.pop("sha", None)
    if sha and HEX40.fullmatch(sha):
        row["commit"] = f"https://github.com/{row['repo']}/commit/{sha}"
    elif sha:
        row["commit"] = sha
    return row


def clean(value):
    if isinstance(value, str):
        return value if DIGEST.fullmatch(value) else LONGHEX.sub(lambda m: m.group(0)[:12], value)
    if isinstance(value, list):
        return [clean(v) for v in value]
    if isinstance(value, dict):
        return {k: (v if k == "commit" or k.endswith("_sha256") else clean(v)) for k, v in value.items()}
    return value


def paper_rows(work):
    papers, hits = {}, {}
    names = {p.name for p in Path(work).glob("*-state.json")} | {s for s in DISCOVERY_STATES if work_file(work, s).exists()}
    for name in sorted(names):
        state = json.loads(work_file(work, name).read_text())
        for key, paper in (state.get("papers") or {}).items():
            entry = papers.setdefault(key, {"key": key, "title": paper.get("title", ""), "url": paper.get("url", ""), "queries": []})
            entry["queries"] += [q for q in paper.get("queries", []) if q not in entry["queries"]]
        for hit in state.get("hits", {}).values():
            hits.setdefault(hit["repo"], set()).update(e for bucket in hit["channels"].values() for e in bucket)
    return [{**paper, "linked_repos": sorted(repo for repo, evidence in hits.items() if paper["key"] in evidence)} for paper in papers.values()]


def config_pool_channel(work):
    state = work_file(work, "product-state.json")
    hits = json.loads(state.read_text())["hits"] if state.exists() else {}
    meta = json.loads(work_file(work, "cache/meta.json").read_text()) if work_file(work, "cache/meta.json").exists() else {}
    names = {key: (meta.get(key) or {}).get("nameWithOwner") or hit["repo"] for key, hit in hits.items() if "config-pool" in hit["channels"]}
    only = [names[key] for key, hit in hits.items() if key in names and set(hit["channels"]) == {"config-pool"}]
    return {"joined": sorted(names.values(), key=str.lower), "only": sorted(only, key=str.lower)}


def export(topic, repo, work):
    repo, work = Path(repo).resolve(), Path(work).resolve()
    out = sweep_folder(repo, topic)
    out.mkdir(parents=True, exist_ok=True)
    counts = {}

    def jsonl(name, transform=lambda r: r):
        rows = [clean(transform(json.loads(line))) for line in (work / name).read_text().splitlines() if line.strip()]
        (out / name).write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
        counts[name] = len(rows)

    def text(name):
        body = (work / name).read_text().replace(str(repo) + "/", "").replace(str(work) + "/", "the sweep folder: ")
        left = HOME_PATH.search(body)
        if left:
            raise TopicError(f"{work / name} still holds a home path ({left.group(0)}...); rewrite it before export")
        (out / name).write_text(body)
        counts[name] = "copied"

    def packet(name):
        data = (work / name).read_bytes()
        body = data.decode("utf-8", errors="replace")
        left = next((p for p in (str(repo), str(work)) if p in body), None) or (HOME_PATH.search(body) and HOME_PATH.search(body).group(0))
        if left:
            raise TopicError(f"{work / name} holds a local path ({left}...); its sha256 pins the bytes the sessions read, so remove the path, then pilot and freeze again")
        (out / name).write_bytes(data)
        counts[name] = "copied byte for byte"

    for stratum in topic["strata"]:
        for side in "AB":
            if (work / f"{stratum}-screen-{side}.jsonl").exists():
                jsonl(f"{stratum}-screen-{side}.jsonl", pin)
            if (work / f"{stratum}-screen-{side}-mechanisms.md").exists():
                text(f"{stratum}-screen-{side}-mechanisms.md")
        for path in sorted(work.glob(f"{stratum}-reader-C-*.jsonl")) + sorted(work.glob(f"{stratum}-qgs-*.jsonl")):
            jsonl(path.name)
        for path in sorted(work.glob(f"{stratum}-pilot-*.jsonl")):
            jsonl(path.name, pin)
        for path in sorted(work.glob(f"{stratum}-pilot-*-mechanisms.md")):
            text(path.name)
        if (work / f"{stratum}-qgs-adjudicated.json").exists():
            (out / f"{stratum}-qgs-adjudicated.json").write_text(json.dumps(clean(json.loads((work / f"{stratum}-qgs-adjudicated.json").read_text())), indent=1, ensure_ascii=False) + "\n")
            counts[f"{stratum}-qgs-adjudicated.json"] = "copied"
        if (work / f"{stratum}-screening-order.jsonl").exists():
            jsonl(f"{stratum}-screening-order.jsonl", lambda r: {k: r[k] for k in ORDER_FIELDS if k in r})
        for name in (f"{stratum}-mechanism-map.json", f"{stratum}-adjudication.json"):
            if (work / name).exists():
                (out / name).write_text(json.dumps(clean(json.loads((work / name).read_text())), indent=1, ensure_ascii=False) + "\n")
                counts[name] = "copied"
    for name in SHARED_JSONL:
        if (work / name).exists():
            jsonl(name)
    for name in SHARED_JSON:
        if (work / name).exists():
            (out / name).write_text(json.dumps(clean(json.loads((work / name).read_text())), indent=1, ensure_ascii=False) + "\n")
            counts[name] = "copied"
    for path in sorted(work.glob("*packet*.md")):
        packet(path.name)
    for path in sorted(work.glob("*-qgs-log.md")):
        text(path.name)
    if (topic["strata"].get("product", {}).get("channels") or {}).get("config_pool") is True:
        (out / "config-pool-channel.json").write_text(json.dumps(config_pool_channel(work), indent=1, ensure_ascii=False) + "\n")
        counts["config-pool-channel.json"] = "written"
    if any(s.get("channels", {}).get("academic") for s in topic["strata"].values()):
        rows = paper_rows(work)
        (out / "papers.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
        counts["papers.jsonl"] = len(rows)
    return out, counts


def main(argv=None):
    args = topic_arguments("Export the screening data from the working folder to the topic's sweep folder: commits pinned, long hashes cut, home paths refused.",
                           (["--work"], {"required": True, "help": "study working folder holding the session files"})).parse_args(argv)
    try:
        out, counts = export(load_topic(args.repo, args.topic), args.repo, args.work)
    except TopicError as error:
        sys.exit(f"export-sweep-data: {error}")
    print(f"exported to {out}: {json.dumps(counts)}")


if __name__ == "__main__":
    main()
