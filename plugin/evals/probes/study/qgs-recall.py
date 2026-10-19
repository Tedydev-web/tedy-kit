import json
import sys
from pathlib import Path

from study_agreement import cohen_kappa
from study_pool import read_json
from study_topic import TopicError, load_topic, topic_arguments


def judged(folder):
    rows = {}
    for side in ("A", "B"):
        path = Path(folder) / f"qgs-judge-{side}.jsonl"
        if not path.exists():
            raise TopicError(f"no judge file at {path}")
        for line in path.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                rows.setdefault(row["id"], {"repo": row["repo"]})[side] = row["verdict"]
    return [j for j in rows.values() if "A" in j and "B" in j]


def recall(folder, work, states):
    both = judged(folder)
    if not both:
        raise TopicError("no candidate was judged by both judges")
    hits = {}
    for name in states:
        state = Path(work) / f"{name}-state.json"
        if not state.exists():
            raise TopicError(f"no discovery state at {state}")
        for key, hit in json.loads(state.read_text())["hits"].items():
            hits.setdefault(key, set()).update(hit["channels"])
    channels = sorted({c for v in hits.values() for c in v})
    observed, k = cohen_kappa((j["A"], j["B"]) for j in both)
    final = read_json(Path(folder) / "qgs-adjudicated.json", {}).get("final", [])
    standards = {"strict (yes by both)": [j["repo"] for j in both if j["A"] == j["B"] == "yes"],
                 "lenient (yes by either)": [j["repo"] for j in both if "yes" in (j["A"], j["B"])],
                 "adjudicated (source read)": final}
    out = {"judged_by_both": len(both), "agreement": round(observed, 3), "kappa": round(k, 3),
           "disagreements": [(j["repo"], j["A"], j["B"]) for j in both if j["A"] != j["B"]], "standards": {}}
    for label, members in standards.items():
        keys = [m.lower() for m in members]
        found = [m for m in keys if m in hits]
        out["standards"][label] = {"size": len(keys), "found": len(found), "quasi_sensitivity": round(len(found) / len(keys), 3) if keys else None,
                                   "per_channel": {c: sum(1 for m in keys if c in hits.get(m, ())) for c in channels}, "missed": [m for m in keys if m not in hits]}
    return out


def main(argv=None):
    args = topic_arguments("Agreement of the two blind QGS judges and the quasi-sensitivity of the discovery channels against the standard.",
                           (["--work"], {"required": True, "help": "study working folder holding the discovery states"}),
                           (["--folder"], {"help": "folder holding qgs-judge-A/B.jsonl and qgs-adjudicated.json, default the working folder"}),
                           (["--states"], {"default": "product", "help": "comma-separated discovery states whose hits count as found"})).parse_args(argv)
    try:
        load_topic(args.repo, args.topic)
        out = recall(args.folder or args.work, args.work, [s for s in args.states.split(",") if s])
    except TopicError as error:
        sys.exit(f"qgs-recall: {error}")
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
