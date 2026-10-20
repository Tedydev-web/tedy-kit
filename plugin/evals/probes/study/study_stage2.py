import json
import math
from pathlib import Path

from study_agreement import RECALL_TARGET, clopper_pearson
from study_calibration_set import facet_ranks
from study_qgs import ADJUDICATED
from study_stage1 import RUNG_FILE, auto_pass, ladder_rung, pool_name, provenance, stage1_inputs, verdicts
from study_topic import TopicError, screened_strata


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
    for m, found in answers.items():
        if found:
            provenance(folder, pool_name(stratum, rung["shape"], m), m, rung["shape"], stratum, inputs, list(found))
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


def facet_order(topic, folder, strata, plans, results):
    ranks = {(f, s): facet_ranks(folder, f, s) for f in topic["facets"] for s in strata}
    rows = [(s, r) for s in strata for r in plans[s]["passes"]]
    best = {(s, r): min([ranks[f, s][results[s][r]["repo"].lower()] for f in topic["facets"] if results[s][r]["repo"].lower() in ranks[f, s]] or [math.inf]) for s, r in rows}
    return sorted(rows, key=lambda row: (best[row], strata.index(row[0]), row[1]))


def stage2_plan(topic, folder, limit=None):
    if limit is not None and limit < 1:
        raise TopicError("--limit must be a positive number of rows")
    strata = screened_strata(topic)
    plans, results = {}, {}
    for stratum in strata:
        rung, results[stratum] = stage1_results(folder, stratum)
        passes = [r for r, v in results[stratum].items() if v["pass"]]
        plans[stratum] = {"stratum": stratum, "rung": rung["rung"], "pool": len(results[stratum]), "passes": passes,
                          "auto_passes": sum(v["auto"] for v in results[stratum].values()), "limit": limit, "order": passes, "stop": None}
    total = sum(len(p["passes"]) for p in plans.values())
    if limit is None or total <= limit:
        return plans
    standard = members(folder)
    if not standard:
        raise TopicError(f"{ADJUDICATED} holds no member, so stage 2 cannot stop on recall; plan it without --limit")
    need = math.ceil(RECALL_TARGET * len(standard))
    reachable = {results[s][r]["repo"].lower() for s in strata for r in plans[s]["passes"]} & standard
    stop = {"limit": limit, "members": len(standard), "need": need, "passed": len(reachable), "reachable": len(reachable) >= need}
    if not stop["reachable"]:
        stop.update(depth=total, found=len(reachable), reached=False, interval=clopper_pearson(len(reachable), len(standard)),
                    rule=f"the {RECALL_TARGET:.2f} pooled recall target is unreachable: {len(reachable)} of the {len(standard)} deduplicated standard members passed "
                         f"stage 1 and {need} are needed, so stage 2 screens every pass and ignores the limit of {limit} rows")
        return {s: {**p, "stop": stop} for s, p in plans.items()}
    ordered = facet_order(topic, folder, strata, plans, results)
    depth, found = len(ordered), set()
    for index, (stratum, rank) in enumerate(ordered, 1):
        found |= {results[stratum][rank]["repo"].lower()} & standard
        if len(found) >= need:
            depth = index
            break
    stop.update(depth=depth, found=len(found), reached=len(found) >= need, interval=clopper_pearson(len(found), len(standard)),
                rule=f"passes of every stratum ranked together by their best facet rank; screening stops at the first depth where pooled recall over the "
                     f"{len(standard)} deduplicated standard members reaches {RECALL_TARGET:.2f}, going past the limit of {limit} rows while the target is reachable")
    return {s: {**p, "order": sorted(r for t, r in ordered[:depth] if t == s), "stop": stop} for s, p in plans.items()}
