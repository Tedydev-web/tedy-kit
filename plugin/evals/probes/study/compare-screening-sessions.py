import json
import sys
from pathlib import Path

from study_pool import read_json
from study_sweep_record import JUDGED, MechanismTable, derive, read_jsonl
from study_topic import TopicError, load_topic, sweep_folder, topic_arguments

EFFORT_BOUND, BLOCK, HARD_CAP = 60, 10, 200


def block_yields(ranks, firsts, forced):
    seen, yields = set(), []
    unforced = [r for r in ranks if r <= HARD_CAP and r not in forced]
    for start in range(0, len(unforced), BLOCK):
        block = unforced[start:start + BLOCK]
        new = set().union(*(firsts.get(r, set()) for r in block)) - seen
        seen |= new
        yields.append((block[0], block[-1], len(new)))
    return yields


def stop_row(yields):
    for first, last, new in yields:
        if last >= EFFORT_BOUND and (new == 0 or last >= HARD_CAP):
            return last
    return None


def compare(folder, stratum, max_rank):
    mapping = read_json(Path(folder) / f"{stratum}-mechanism-map.json", None)
    if mapping is None:
        raise TopicError(f"no {stratum}-mechanism-map.json in {folder}; reconcile the two lists by definition first")
    table_json = read_json(Path(folder) / "mechanism-table.json", None)
    table = MechanismTable(table_json or {"aliases": {}, "class": {}, "default": "new"})
    sides = {s: {r["order_rank"]: r for r in read_jsonl(Path(folder), f"{stratum}-screen-{s}.jsonl")} for s in "AB"}
    common = sorted(r for r in set(sides["A"]) & set(sides["B"]) if max_rank is None or r <= max_rank)
    if not common:
        raise TopicError(f"sessions A and B share no screened {stratum} row")
    rows = {r: {s: derive(table, stratum, mapping, s, sides[s][r]) for s in "AB"} for r in common}
    cells = same = 0
    by_criterion = {}
    for r in common:
        for c in JUDGED:
            cells += 1
            if rows[r]["A"]["scores"][c] == rows[r]["B"]["scores"][c]:
                same += 1
            else:
                by_criterion[c] = by_criterion.get(c, 0) + 1
    mech = {s: set().union(*(rows[r][s]["mechs"] for r in common)) for s in "AB"}
    shared = len(mech["A"] & mech["B"])
    chapman = (len(mech["A"]) + 1) * (len(mech["B"]) + 1) / (shared + 1) - 1
    union = len(mech["A"] | mech["B"])
    firsts = {r: rows[r]["A"]["mechs"] | rows[r]["B"]["mechs"] for r in common}
    forced = {r["order_rank"] for r in read_jsonl(Path(folder), f"{stratum}-screening-order.jsonl") if r.get("forced")}
    yields = block_yields(common, firsts, forced)
    out = {"stratum": stratum, "rows": len(common), "judged_cells": cells, "identical": same, "agreement": round(same / cells, 3), "target": 0.9,
           "differing_by_criterion": by_criterion, "decision_agreement": sum(rows[r]["A"]["decision"] == rows[r]["B"]["decision"] for r in common),
           "mechanisms": {"A": len(mech["A"]), "B": len(mech["B"]), "shared": shared, "union": union, "chapman": round(chapman, 1),
                          "third_reader_needed": chapman > union + 2, "only_A": sorted(mech["A"] - mech["B"]), "only_B": sorted(mech["B"] - mech["A"])},
           "block_yields": yields, "effort_bound_stop": stop_row(yields), "mechanism_table": table_json is not None,
           "disputed": [{"rank": r, "repo": sides["A"][r]["repo"], "A": rows[r]["A"]["decision"], "B": rows[r]["B"]["decision"]}
                        for r in common if rows[r]["A"]["decision"] != rows[r]["B"]["decision"]]}
    return out


def main(argv=None):
    args = topic_arguments("Compare the two blind screening sessions of a stratum: agreement, Chapman estimate, decisions and new mechanisms per block.",
                           (["--stratum"], {"required": True, "help": "stratum to compare"}),
                           (["--folder"], {"help": "folder holding the session files, default the topic's sweep folder"}),
                           (["--max-rank"], {"type": int, "help": "compare only rows up to this rank"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        if args.stratum not in topic["strata"]:
            raise TopicError(f"topic {topic['name']} has no {args.stratum} stratum")
        out = compare(args.folder or sweep_folder(args.repo, topic), args.stratum, args.max_rank)
    except TopicError as error:
        sys.exit(f"compare-screening-sessions: {error}")
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
