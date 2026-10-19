import json
import sys
from pathlib import Path

from study_agreement import CHAPMAN_NOTE, KAPPA_CRITERIA, block_yields, chapman, effort_stop, session_kappas, stop_row
from study_pool import read_json
from study_protocol import read_freeze
from study_screening_core import JUDGED, MechanismTable, derive, read_jsonl
from study_topic import TopicError, load_topic, require_screened, sweep_folder, topic_arguments, write_stop_row


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
    frozen = read_freeze(folder, stratum)
    measured = [r for r in common if frozen is None or r > frozen["frozen_after_rank"]]
    if not measured:
        raise TopicError(f"no {stratum} row both sessions screened lies after the freeze at row {frozen['frozen_after_rank']}")
    by_criterion = {}
    for r in measured:
        for c in JUDGED:
            if rows[r]["A"]["scores"][c] != rows[r]["B"]["scores"][c]:
                by_criterion[c] = by_criterion.get(c, 0) + 1
    cells, cells_with_date = len(measured) * len(KAPPA_CRITERIA), len(measured) * len(JUDGED)
    same = cells - sum(n for c, n in by_criterion.items() if c != "Date")
    same_with_date = cells_with_date - sum(by_criterion.values())
    kappa, eligibility_kappa, eligibility_differ = session_kappas([rows[r] for r in measured])
    mech = {s: set().union(*(rows[r][s]["mechs"] for r in common)) for s in "AB"}
    capture = chapman(mech["A"], mech["B"])
    firsts = {r: rows[r]["A"]["mechs"] | rows[r]["B"]["mechs"] for r in common}
    order = read_jsonl(Path(folder), f"{stratum}-screening-order.jsonl")
    forced = {r["order_rank"] for r in order if r.get("forced")}
    yields = block_yields(common, firsts, forced)
    stop, rule = effort_stop(common, firsts, forced, [r["order_rank"] for r in order])
    freeze = ({"after_rank": frozen["frozen_after_rank"], "criteria_sha256": frozen["criteria_sha256"], "packet_sha256": frozen["packet_sha256"],
               "pilot_rows_left_out": len(common) - len(measured)} if frozen else
              {"none": f"no protocol-freeze.json in {folder}: agreement covers every row both sessions screened, the pilot included; pass --folder <work> once frozen"})
    out = {"stratum": stratum, "rows": len(measured), "freeze": freeze, "judged_cells": cells, "identical": same, "agreement": round(same / cells, 3), "target": 0.9,
           "with_date": {"judged_cells": cells_with_date, "identical": same_with_date, "agreement": round(same_with_date / cells_with_date, 3),
                         "note": "Date is computed, not judged; the target applies to the figure without it"},
           "differing_by_criterion": by_criterion, "kappa": kappa, "eligibility_kappa": eligibility_kappa, "eligibility_differ": eligibility_differ,
           "decision_agreement": sum(rows[r]["A"]["decision"] == rows[r]["B"]["decision"] for r in measured),
           "mechanisms": {**capture, "chapman_note": CHAPMAN_NOTE, "third_reader_needed": capture["chapman_lower_bound"] > capture["union"] + 2,
                          "only_A": sorted(mech["A"] - mech["B"]), "only_B": sorted(mech["B"] - mech["A"])},
           "block_yields": yields, "effort_bound_stop": stop_row(yields), "stop": {"row": stop, "rule": rule}, "mechanism_table": table_json is not None,
           "disputed": [{"rank": r, "repo": sides["A"][r]["repo"], "A": rows[r]["A"]["decision"], "B": rows[r]["B"]["decision"]}
                        for r in common if rows[r]["A"]["decision"] != rows[r]["B"]["decision"]]}
    return out


def main(argv=None):
    args = topic_arguments("Compare the two blind screening sessions of a stratum: agreement, kappa, the Chapman lower bound, decisions and new mechanisms per block.",
                           (["--stratum"], {"required": True, "help": "stratum to compare"}),
                           (["--folder"], {"help": "folder holding the session files, default the topic's sweep folder"}),
                           (["--max-rank"], {"type": int, "help": "compare only rows up to this rank"}),
                           (["--write-stop"], {"action": "store_true", "help": "write the derived stop row into the topic config's strata.<stratum>.stop_row"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        require_screened(topic, args.stratum)
        out = compare(args.folder or sweep_folder(args.repo, topic), args.stratum, args.max_rank)
        if args.write_stop:
            if args.max_rank is not None or out["stop"]["row"] is None:
                raise TopicError(f"no stop row to write ({out['stop']['rule']}); screen on, and compare every row without --max-rank")
            write_stop_row(topic, args.stratum, out["stop"]["row"])
    except TopicError as error:
        sys.exit(f"compare-screening-sessions: {error}")
    print(json.dumps(out, indent=1))
    if args.write_stop:
        print(f"stop_row {out['stop']['row']} ({out['stop']['rule']}) written to {topic['path']}")


if __name__ == "__main__":
    main()
