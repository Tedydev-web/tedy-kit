import hashlib
import json
import math
from pathlib import Path

from study_agreement import upper_bound
from study_protocol import EMPTY_TABLE, FREEZE_FILE
from study_screening_core import MechanismTable, derive, read_jsonl
from study_stage1 import stage1_inputs
from study_stage2 import chosen_rung, plan_file, stage1_results
from study_topic import TopicError, screened_strata, term_regex

NEAR_ROWS, FAR_ROWS = 200, 100
PARTS = ("near", "far")


def audit_file(stratum):
    return f"{stratum}-stage1-audit.json"


def checks_file(stratum):
    return f"{stratum}-stage1-audit-checks.json"


def screener_name(stratum, option):
    return f"{stratum}-stage1-audit-{option['model']}"


def audit_terms(topic):
    return sorted({t for rule in (topic.get("facets") or {}).values() for t in rule["terms"]}) or topic["terms"]


def hashed_sample(pool, size, seed):
    return sorted(sorted(pool, key=lambda r: hashlib.sha256(f"{seed}:{r}".encode()).hexdigest())[:size])


def sample(topic, folder, stratum):
    folder = Path(folder)
    rung = chosen_rung(folder)
    results = stage1_results(folder, stratum)[1]
    term = term_regex(audit_terms(topic))
    inputs = stage1_inputs(folder, stratum, rung["shape"])
    excluded = [r for r, v in results.items() if not v["pass"]]
    near_pool = [r for r in excluded if term.search(inputs[r]["repo"].split("/", 1)[1].replace("_", "-") + " " + inputs[r]["description"])]
    far_pool = [r for r in excluded if r not in set(near_pool)]
    seed = f"{topic['sweep']}:stage1-audit:{stratum}"
    return {"stratum": stratum, "rung": rung["rung"], "excluded": len(excluded),
            "disagreements": [r for r, v in results.items() if len(set(v["verdicts"].values())) > 1],
            "near_pool": len(near_pool), "far_pool": len(far_pool),
            "near": hashed_sample(near_pool, NEAR_ROWS, f"{seed}:near"), "far": hashed_sample(far_pool, FAR_ROWS, f"{seed}:far")}


def cross_audit_sample(topic, folder, size):
    folder = Path(folder)
    if not (folder / FREEZE_FILE).is_file():
        raise TopicError(f"no {FREEZE_FILE} in {folder}; the audit sample is drawn from rows screened after the freeze")
    frozen = json.loads((folder / FREEZE_FILE).read_text())["strata"]
    out = {}
    for stratum in screened_strata(topic):
        plan = folder / plan_file(stratum)
        if not plan.is_file():
            raise TopicError(f"no {plan.name} in {folder}; the audit sample is drawn after stage 2 ends")
        sides = [{r["order_rank"] for r in read_jsonl(folder, f"{stratum}-screen-{s}.jsonl")} for s in "AB"]
        open_rows = sorted(set(json.loads(plan.read_text())["order"]) - (sides[0] & sides[1]))
        if open_rows:
            raise TopicError(f"{stratum}: stage 2 has not ended; ranks {open_rows[:10]} are not screened by both sessions")
        ranks = sorted(r for r in sides[0] & sides[1] if r > frozen[stratum]["frozen_after_rank"])
        if not ranks:
            raise TopicError(f"{stratum}: no row both sessions screened after the pilot block")
        out[stratum] = hashed_sample(ranks, size, f"{topic['sweep']}:audit:{stratum}")
    return out


def draw(topic, folder, stratum):
    if (Path(folder) / audit_file(stratum)).exists():
        raise TopicError(f"{Path(folder) / audit_file(stratum)} already exists; the stage-1 audit is drawn once")
    return sample(topic, folder, stratum)


def read_audit(folder, stratum):
    path = Path(folder) / audit_file(stratum)
    if not path.is_file():
        raise TopicError(f"no {path.name} in {folder}; draw the stage-1 audit with draw-stage1-audit.py --stratum {stratum}")
    return json.loads(path.read_text())


def flagged(folder, stratum, option):
    audit = read_audit(folder, stratum)
    name = screener_name(stratum, option)
    rows = {r["order_rank"]: r for r in read_jsonl(Path(folder), f"{name}.jsonl")}
    wanted = audit["near"] + audit["far"]
    missing = sorted(set(wanted) - set(rows))
    if missing:
        raise TopicError(f"{name}.jsonl has not screened stage-1 audit ranks {missing[:10]}; run run-judge.py --judge screening-A --set stage1-audit --stratum {stratum}")
    table = MechanismTable(EMPTY_TABLE)
    return audit, sorted(r for r in wanted if derive(table, stratum, {"A": {}, "B": {}}, "A", rows[r])["decision"] == "eligible")


def elusion(topic, folder, stratum, option):
    if read_audit(folder, stratum) != sample(topic, folder, stratum):
        raise TopicError(f"{audit_file(stratum)} is not the sample the stage-1 files give; the stage-1 audit is drawn once, by draw-stage1-audit.py")
    audit, flags = flagged(folder, stratum, option)
    path = Path(folder) / checks_file(stratum)
    checks = {int(k): v for k, v in json.loads(path.read_text()).items()} if path.is_file() else {}
    unchecked = [r for r in flags if r not in checks]
    if unchecked:
        raise TopicError(f"the user has not checked stage-1 audit ranks {unchecked[:10]} that the screener flagged; record them with import-audit-checks.py --stratum {stratum}")
    out = {"disagreements": len(audit["disagreements"]), "flagged": flags}
    for part in PARTS:
        misses = [r for r in audit[part] if checks.get(r) == "eligible"]
        upper = upper_bound(len(misses), len(audit[part])) if audit[part] else None
        out[part] = {"rows": len(audit[part]), "pool": audit[f"{part}_pool"], "misses": misses, "upper": upper,
                     "at_most": None if upper is None else math.ceil(upper * audit[f"{part}_pool"])}
    return out


def import_checks(folder, stratum, option, saved):
    flags = flagged(folder, stratum, option)[1]
    if not isinstance(saved, dict) or any(v not in ("eligible", "excluded") for v in saved.values()):
        raise TopicError("the checks file maps flagged ranks to eligible or excluded")
    checks = {int(k): v for k, v in saved.items()}
    outside = sorted(set(checks) - set(flags))
    if outside:
        raise TopicError(f"ranks {outside[:10]} were not flagged by the screener; the user checks only the flagged rows")
    (Path(folder) / checks_file(stratum)).write_text(json.dumps({str(k): checks[k] for k in sorted(checks)}, indent=1) + "\n")
    return len(checks), len(flags)
