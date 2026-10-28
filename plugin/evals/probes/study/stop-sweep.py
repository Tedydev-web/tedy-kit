import json
import re
import shutil
import sys
from pathlib import Path

from study_screening_core import read_jsonl
from study_stopped_record import STOP_MARK
from study_topic import TopicError, load_topic, saigon_today, sweep_folder, topic_arguments

DIGEST_LINE = re.compile(r"sha256\[:16\] of the sorted unique list: `([0-9a-f]{16})`")


def frozen_batches(work):
    return sorted(p.name[len("reference-freeze-"):-len(".json")] for p in Path(work).glob("reference-freeze-*.json"))


def study_rows(work, batches):
    rows = []
    for batch in batches:
        for row in json.loads((Path(work) / f"{batch}-set.json").read_text())["rows"]:
            inputs = {r["order_rank"]: r for r in read_jsonl(Path(work), f"reference-inputs-{row['stratum']}.jsonl")}
            got = inputs.get(row["order_rank"])
            if got is None or got["repo"].lower() != row["repo"].lower():
                raise TopicError(f"reference-inputs-{row['stratum']}.jsonl holds no row {row['order_rank']} ({row['repo']}); the reference read every drawn row")
            rows.append({"batch": batch, "stratum": row["stratum"], "rank": row["order_rank"], "repo": row["repo"],
                         "commit": f"https://github.com/{row['repo']}/commit/{got['sha']}", "stars": (got.get("facts") or {}).get("stars") or 0})
    return rows


def stop(topic, repo, work, title, criteria, decision, supplement, threats, today):
    repo, work = Path(repo), Path(work)
    if STOP_MARK not in (repo / criteria).read_text():
        raise TopicError(f"{criteria} names no {STOP_MARK}; add the dated criteria row before the stop")
    batches = frozen_batches(work)
    if not batches:
        raise TopicError(f"no reference-freeze-<batch>.json in {work}; a sweep stops at the scale checkpoint only after its labels are frozen")
    digest = DIGEST_LINE.search((repo / "docs/prior-art/claude-code-surfaces.md").read_text())
    if not digest:
        raise TopicError("docs/prior-art/claude-code-surfaces.md states no llms.txt digest")
    for extra in supplement:
        if set(extra) != {"repo", "stratum", "commit", "problems", "reason"} or not str(extra["reason"]).strip():
            raise TopicError(f"supplement {extra.get('repo')} must hold exactly repo, stratum, commit, problems and a reason")
    folder = sweep_folder(repo, topic)
    folder.mkdir(parents=True, exist_ok=True)
    for batch in batches:
        for name in (f"{batch}-set.json", f"{batch}-labels.json", f"reference-freeze-{batch}.json"):
            shutil.copyfile(work / name, folder / name)
    write = lambda name, value: (folder / name).write_text(json.dumps(value, indent=1, ensure_ascii=False) + "\n")
    write("meta.json", {"title": title, "role": topic["name"], "date": today, "criteria": criteria, "inventory_digest": digest.group(1), "problems": topic["problems"]})
    write("stop.json", {"date": today, "decision": decision, "threats": threats})
    write("deep-study.json", {"rows": study_rows(work, batches), "supplement": supplement})
    return folder, batches


def main(argv=None):
    args = topic_arguments("Stop a topic sweep at the scale checkpoint: copy the frozen reference batches into the sweep folder and write the stop and the deep-study rows "
                           "the record renders.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--title"], {"required": True, "help": "the record's title"}),
                           (["--criteria"], {"required": True, "help": "criteria file holding the dated stop row, relative to the repository"}),
                           (["--decision"], {"required": True, "help": "the user's decision, as the Status line states it"}),
                           (["--supplement"], {"help": "JSON file: a list of {repo, stratum, commit, problems, reason} studied outside the drawn rows"}),
                           (["--threats"], {"required": True, "help": "text file, one threat per line"}),
                           (["--today"], {"default": saigon_today(), "help": "stop date, default today in Asia/Saigon"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        supplement = json.loads(Path(args.supplement).read_text()) if args.supplement else []
        threats = [line.strip() for line in Path(args.threats).read_text().splitlines() if line.strip()]
        folder, batches = stop(topic, args.repo, args.work, args.title, args.criteria, args.decision, supplement, threats, args.today)
    except TopicError as error:
        sys.exit(f"stop-sweep: {error}")
    print(f"{folder}: stopped at the scale checkpoint with batches {', '.join(batches)}; write surface-map.json, then render the record")


if __name__ == "__main__":
    main()
