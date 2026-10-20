import json
import math
from pathlib import Path

from study_agreement import RECALL_TARGET, clopper_pearson
from study_calibration_set import facet_ranks
from study_qgs import ADJUDICATED
from study_stage1 import RUNG_FILE, auto_pass, ladder_rung, pool_name, stage1_inputs, verdicts
from study_topic import TopicError


def plan_file(stratum):
    return f"{stratum}-stage2.json"


def chosen_rung(folder):
    path = Path(folder) / RUNG_FILE
    if not path.is_file():
        raise TopicError(f"no {RUNG_FILE} in {folder}; choose the stage-1 rung with choose-stage1-rung.py first")
    return ladder_rung(json.loads(path.read_text())["rung"])


def stage1_results(folder, stratum):
    rung = chosen_rung(folder)
    inputs = stage1_inputs(folder, stratum, rung["shape"])
    answers = {m: verdicts(folder, pool_name(stratum, rung["shape"], m)) for m in rung["models"]}
    out, missing = {}, []
    for rank, row in sorted(inputs.items()):
        if auto_pass(row):
            out[rank] = {"repo": row["repo"], "pass": True, "auto": True, "verdicts": {}, "problems": []}
            continue
        got = {m: answers[m].get(rank) for m in rung["models"]}
        if None in got.values():
            missing.append(rank)
            continue
        wrong = [m for m, v in got.items() if v["repo"].lower() != row["repo"].lower()]
        if wrong:
            raise TopicError(f"{pool_name(stratum, rung['shape'], wrong[0])}.jsonl rank {rank} names {got[wrong[0]]['repo']}, but the stage-1 inputs hold {row['repo']}")
        kept = [v for v in got.values() if v["verdict"] != "no"]
        out[rank] = {"repo": row["repo"], "pass": bool(kept), "auto": False, "verdicts": {m: v["verdict"] for m, v in got.items()},
                     "problems": sorted({p for v in kept for p in v["problems"]})}
    if missing:
        raise TopicError(f"{stratum}: stage 1 has not screened ranks {missing[:10]} with every model of rung {rung['rung']}; run run-stage1.py --set pool")
    return rung, out


def members(folder):
    path = Path(folder) / ADJUDICATED
    if not path.is_file():
        raise TopicError(f"no {ADJUDICATED} in {folder}; build the topic's standard with qgs-standard.py --write")
    return {m.lower() for m in json.loads(path.read_text())["final"]}


def facet_order(topic, folder, stratum, passes, results):
    ranks = {f: facet_ranks(folder, f, stratum) for f in topic["facets"]}
    best = {r: min([ranks[f][results[r]["repo"].lower()] for f in ranks if results[r]["repo"].lower() in ranks[f]] or [math.inf]) for r in passes}
    return sorted(passes, key=lambda r: (best[r], r))


def stage2_plan(topic, folder, stratum, limit=None):
    if limit is not None and limit < 1:
        raise TopicError("--limit must be a positive number of rows")
    rung, results = stage1_results(folder, stratum)
    passes = [r for r, v in results.items() if v["pass"]]
    plan = {"stratum": stratum, "rung": rung["rung"], "pool": len(results), "passes": passes, "auto_passes": sum(v["auto"] for v in results.values()), "limit": limit,
            "order": passes, "stop": None}
    if limit is None or len(passes) <= limit:
        return plan
    standard = members(folder)
    ordered = facet_order(topic, folder, stratum, passes, results)
    wanted = [r for r in ordered if results[r]["repo"].lower() in standard]
    need = math.ceil(RECALL_TARGET * len(wanted))
    depth, found = limit, 0
    for index, rank in enumerate(ordered[:limit], 1):
        found += results[rank]["repo"].lower() in standard
        if wanted and found >= need:
            depth = index
            break
    found = sum(results[r]["repo"].lower() in standard for r in ordered[:depth])
    plan["order"] = sorted(ordered[:depth])
    plan["stop"] = {"depth": depth, "found": found, "members": len(wanted), "reached": bool(wanted) and found >= need,
                    "interval": clopper_pearson(found, len(wanted)) if wanted else None,
                    "rule": f"passes ranked by their best facet rank; screening stops at the first depth holding {RECALL_TARGET:.2f} of the standard members that passed stage 1, "
                            f"or at the limit of {limit} rows"}
    return plan
