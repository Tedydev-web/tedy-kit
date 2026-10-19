import json
import re
import sys
from pathlib import Path

from study_topic import TopicError, load_topic, sweep_folder, topic_arguments

HEX40 = re.compile(r"[0-9a-f]{40}")
LONGHEX = re.compile(r"\b[0-9a-fA-F]{32,}\b")
HOME_PATH = re.compile(r"/(?:home|Users)/[^/\s]+/")
ORDER_FIELDS = ("order_rank", "repo", "order", "units", "contract_files", "stars", "pushed", "created", "channels", "archived", "forced")
SHARED_JSON = ("meta.json", "study.json", "surface-map.json", "mechanism-table.json", "qgs-adjudicated.json", "protocol-freeze.json", "calibration-sample.json")
SHARED_JSONL = ("qgs-candidates.jsonl", "qgs-judge-A.jsonl", "qgs-judge-B.jsonl")


def pin(row):
    sha = row.pop("sha", None)
    if sha and HEX40.fullmatch(sha):
        row["commit"] = f"https://github.com/{row['repo']}/commit/{sha}"
    elif sha:
        row["commit"] = sha
    return row


def clean(value):
    if isinstance(value, str):
        return LONGHEX.sub(lambda m: m.group(0)[:12], value)
    if isinstance(value, list):
        return [clean(v) for v in value]
    if isinstance(value, dict):
        return {k: (v if k == "commit" else clean(v)) for k, v in value.items()}
    return value


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
    for path in sorted(work.glob("*packet*.md")) + sorted(work.glob("*-qgs-log.md")):
        text(path.name)
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
