import json
import random
from pathlib import Path

from study_agreement import upper_bound
from study_protocol import EMPTY_TABLE
from study_screening_core import MechanismTable, derive, read_jsonl
from study_stage1 import stage1_inputs
from study_stage2 import chosen_rung, stage1_results
from study_topic import TopicError, term_regex

NEAR_ROWS, FAR_ROWS = 200, 100
PARTS = ("near", "far")


def audit_file(stratum):
    return f"{stratum}-stage1-audit.json"


def checks_file(stratum):
    return f"{stratum}-stage1-audit-checks.json"


def screener_name(stratum, option):
    return f"{stratum}-stage1-audit-{option['model']}"


def draw(topic, folder, stratum):
    folder = Path(folder)
    if (folder / audit_file(stratum)).exists():
        raise TopicError(f"{folder / audit_file(stratum)} already exists; the stage-1 audit is drawn once")
    rung = chosen_rung(folder)
    results = stage1_results(folder, stratum)[1]
    term = term_regex(topic["terms"])
    inputs = stage1_inputs(folder, stratum, rung["shape"])
    excluded = [r for r, v in results.items() if not v["pass"]]
    near_pool = [r for r in excluded if term.search(inputs[r]["repo"].split("/", 1)[1].replace("_", "-") + " " + inputs[r]["description"])]
    far_pool = [r for r in excluded if r not in set(near_pool)]
    rng = random.Random(f"{topic['sweep']}:stage1-audit:{stratum}")
    return {"stratum": stratum, "rung": rung["rung"], "excluded": len(excluded),
            "disagreements": [r for r, v in results.items() if len(set(v["verdicts"].values())) > 1],
            "near_pool": len(near_pool), "far_pool": len(far_pool),
            "near": sorted(rng.sample(near_pool, min(NEAR_ROWS, len(near_pool)))), "far": sorted(rng.sample(far_pool, min(FAR_ROWS, len(far_pool))))}


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


def elusion(folder, stratum, option):
    audit, flags = flagged(folder, stratum, option)
    path = Path(folder) / checks_file(stratum)
    checks = {int(k): v for k, v in json.loads(path.read_text()).items()} if path.is_file() else {}
    unchecked = [r for r in flags if r not in checks]
    if unchecked:
        raise TopicError(f"the user has not checked stage-1 audit ranks {unchecked[:10]} that the screener flagged; record them with import-audit-checks.py --stratum {stratum}")
    out = {"disagreements": len(audit["disagreements"]), "flagged": flags}
    for part in PARTS:
        misses = [r for r in audit[part] if checks.get(r) == "eligible"]
        out[part] = {"rows": len(audit[part]), "pool": audit[f"{part}_pool"], "misses": misses,
                     "upper": upper_bound(len(misses), len(audit[part])) if audit[part] else None}
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
