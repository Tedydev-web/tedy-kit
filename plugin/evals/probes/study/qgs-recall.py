import json
import sys
from pathlib import Path

from study_agreement import cohen_kappa, recall_at_cut, rounded
from study_pool import read_json
from study_screening_core import read_jsonl
from study_topic import TopicError, load_topic, topic_arguments


def qgs_prefix(stratum):
    return f"{stratum}-" if stratum else ""


def judged(folder, stratum=None):
    rows = {}
    for side in ("A", "B"):
        path = Path(folder) / f"{qgs_prefix(stratum)}qgs-judge-{side}.jsonl"
        if not path.exists():
            raise TopicError(f"no judge file at {path}")
        for line in path.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                rows.setdefault(row["id"], {"repo": row["repo"]})[side] = row["verdict"]
    return [j for j in rows.values() if "A" in j and "B" in j]


def recall(folder, work, states, stratum=None):
    both = judged(folder, stratum)
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
    final = read_json(Path(folder) / f"{qgs_prefix(stratum)}qgs-adjudicated.json", {}).get("final", [])
    standards = {"strict (yes by both)": [j["repo"] for j in both if j["A"] == j["B"] == "yes"],
                 "lenient (yes by either)": [j["repo"] for j in both if "yes" in (j["A"], j["B"])],
                 "adjudicated (source read)": final}
    out = {"judged_by_both": len(both), "agreement": round(observed, 3), "kappa": rounded(k),
           "disagreements": [(j["repo"], j["A"], j["B"]) for j in both if j["A"] != j["B"]], "standards": {}}
    for label, members in standards.items():
        keys = [m.lower() for m in members]
        found = [m for m in keys if m in hits]
        out["standards"][label] = {"size": len(keys), "found": len(found), "quasi_sensitivity": round(len(found) / len(keys), 3) if keys else None,
                                   "per_channel": {c: sum(1 for m in keys if c in hits.get(m, ())) for c in channels}, "missed": [m for m in keys if m not in hits]}
    return out, final


def main(argv=None):
    args = topic_arguments("Agreement of the two blind QGS judges, the quasi-sensitivity of the discovery channels and, per stratum, recall at the screening cut.",
                           (["--work"], {"required": True, "help": "study working folder holding the discovery states"}),
                           (["--folder"], {"help": "folder holding the judge files and the adjudicated standard, default the working folder"}),
                           (["--states"], {"default": "product", "help": "comma-separated discovery states whose hits count as found"}),
                           (["--stratum"], {"help": "read <stratum>-qgs-* files and report recall at the cut of <stratum>-screening-order.jsonl"}),
                           (["--cut"], {"type": int, "help": "screening cut for recall at the cut, default the topic's written stop_row"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        folder = args.folder or args.work
        out, final = recall(folder, args.work, [s for s in args.states.split(",") if s], args.stratum)
        if args.stratum:
            cut = args.cut if args.cut is not None else topic["strata"].get(args.stratum, {}).get("stop_row")
            if isinstance(cut, int) and not isinstance(cut, bool):
                files = [Path(args.work) / f"{args.stratum}-screen-{s}.jsonl" for s in "AB"]
                sides = [{r["order_rank"] for r in read_jsonl(f.parent, f.name)} if f.is_file() else None for f in files]
                both = sides[0] & sides[1] if None not in sides else None
                out["at_cut"] = recall_at_cut(args.stratum, final, read_jsonl(Path(args.work), f"{args.stratum}-screening-order.jsonl"), cut, both)
                out["at_cut"]["counted"] = (f"rows both sessions screened: {len(both)}" if both is not None else
                                            "no session files yet: rows the cut would screen")
            else:
                out["at_cut"] = {"stratum": args.stratum, "cut": None, "note": "no stop row yet: recall at the cut is measured once screening wrote it, or pass --cut"}
    except TopicError as error:
        sys.exit(f"qgs-recall: {error}")
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
