import hashlib
import json
from pathlib import Path

from study_agreement import KAPPA_CRITERIA, session_kappas
from study_sweep_record import MechanismTable, derive, read_jsonl
from study_topic import TopicError, pilot_rows, session_b_options

FREEZE_FILE = "protocol-freeze.json"
EMPTY_TABLE = {"aliases": {}, "class": {}, "default": "new"}


def protocol_hash(criteria_bytes, packet_bytes):
    return hashlib.sha256(criteria_bytes + packet_bytes).hexdigest()[:16]


def frozen_after(order_rows, size):
    unforced = sorted(r["order_rank"] for r in order_rows if not r.get("forced"))
    if not unforced:
        raise TopicError("the screening order holds no unforced row to pilot")
    return unforced[min(size, len(unforced)) - 1]


def read_freeze(folder, stratum):
    path = Path(folder) / FREEZE_FILE
    if not path.is_file():
        return None
    freeze = json.loads(path.read_text())
    if stratum not in freeze.get("strata", {}):
        raise TopicError(f"{path} does not freeze the {stratum} stratum")
    return freeze["strata"][stratum]


def pilot_pairs(work, stratum, b_file, after, table):
    sides = {"A": {r["order_rank"]: r for r in read_jsonl(work, f"{stratum}-pilot-A.jsonl")}, "B": {r["order_rank"]: r for r in read_jsonl(work, b_file)}}
    mapping = {"A": {}, "B": {}}
    return [{s: derive(table, stratum, mapping, s, sides[s][rank]) for s in "AB"} for rank in sorted(set(sides["A"]) & set(sides["B"])) if rank <= after]


def pilot_comparison(rows):
    cells = len(rows) * len(KAPPA_CRITERIA)
    same = sum(r["A"]["scores"][c] == r["B"]["scores"][c] for r in rows for c in KAPPA_CRITERIA)
    kappa, eligibility_kappa, _ = session_kappas(rows)
    return {"rows": len(rows), "agreement": round(same / cells, 3), "kappa": kappa, "eligibility_kappa": eligibility_kappa}


def freeze(topic, repo, work, criteria, today):
    repo, work = Path(repo), Path(work)
    criteria_file = repo / criteria
    if not criteria_file.is_file():
        raise TopicError(f"no criteria file at {criteria_file}")
    table_file = work / "mechanism-table.json"
    table = MechanismTable(json.loads(table_file.read_text()) if table_file.is_file() else EMPTY_TABLE)
    size, strata = pilot_rows(topic), {}
    for stratum in topic["strata"]:
        order = read_jsonl(work, f"{stratum}-screening-order.jsonl")
        if not order:
            raise TopicError(f"no {stratum}-screening-order.jsonl in {work}")
        packet = work / f"screening-packet-{stratum}.md"
        if not packet.is_file():
            raise TopicError(f"no {packet.name} in {work}; the protocol hash covers the criteria and the packet")
        if not (work / f"{stratum}-pilot-A.jsonl").is_file():
            raise TopicError(f"no {stratum}-pilot-A.jsonl in {work}; session A screens the pilot block first")
        strata[stratum] = {"frozen_after_rank": frozen_after(order, size), "packet": packet.name,
                           "protocol_sha256": protocol_hash(criteria_file.read_bytes(), packet.read_bytes()), "date": today}
    pilot, options = {}, session_b_options(topic)
    for option in options:
        files = {s: f"{s}-pilot-B-{option['model']}.jsonl" for s in strata}
        if all((work / f).is_file() for f in files.values()):
            rows = [row for s, f in files.items() for row in pilot_pairs(work, s, f, strata[s]["frozen_after_rank"], table)]
            if rows:
                pilot[option["model"]] = pilot_comparison(rows)
    if not pilot:
        raise TopicError(f"no session B option screened the pilot block of every stratum; expected <stratum>-pilot-B-<model>.jsonl for one of {[o['model'] for o in options]}")
    best = max(pilot, key=lambda m: (pilot[m]["agreement"], -[o["model"] for o in options].index(m)))
    chosen = next(o for o in options if o["model"] == best)
    return {"pilot_rows": size, "criteria": criteria, "strata": strata, "session_b": {"chosen": chosen, "pilot": pilot}}
