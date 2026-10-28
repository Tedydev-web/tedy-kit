import hashlib
import json
import re
from pathlib import Path

from study_agreement import KAPPA_CRITERIA, session_kappas
from study_screening_core import MechanismTable, derive, read_jsonl
from study_session_prompt import template_sha256
from study_topic import TopicError, pilot_rows, screened_strata, session_a, session_b

FREEZE_FILE = "protocol-freeze.json"
SCREEN_KEY = re.compile(r"[a-z0-9]+-[AB]")
EMPTY_TABLE = {"aliases": {}, "class": {}, "default": "new"}


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def pilot_ranks(order_rows, size):
    unforced = sorted(r["order_rank"] for r in order_rows if not r.get("forced"))
    if not unforced:
        raise TopicError("the screening order holds no unforced row to pilot")
    return unforced[:size]


def read_freeze(folder, stratum):
    path = Path(folder) / FREEZE_FILE
    if not path.is_file():
        return None
    freeze = json.loads(path.read_text())
    if stratum not in freeze.get("strata", {}):
        raise TopicError(f"{path} does not freeze the {stratum} stratum")
    return freeze["strata"][stratum]


def pilot_pairs(work, stratum, b_file, ranks, table):
    sides = {"A": {r["order_rank"]: r for r in read_jsonl(work, f"{stratum}-pilot-A.jsonl")}, "B": {r["order_rank"]: r for r in read_jsonl(work, b_file)}}
    missing = {s: sorted(set(ranks) - set(sides[s])) for s in "AB"}
    if missing["A"] or missing["B"]:
        raise TopicError(f"{stratum}: the pilot files {stratum}-pilot-A.jsonl and {b_file} must both cover pilot ranks {ranks}; missing A {missing['A']}, B {missing['B']}")
    mapping = {"A": {}, "B": {}}
    return [{s: derive(table, stratum, mapping, s, sides[s][rank]) for s in "AB"} for rank in ranks]


def pilot_comparison(rows):
    cells = len(rows) * len(KAPPA_CRITERIA)
    same = sum(r["A"]["scores"][c] == r["B"]["scores"][c] for r in rows for c in KAPPA_CRITERIA)
    kappa, eligibility_kappa, _ = session_kappas(rows)
    return {"rows": len(rows), "agreement": round(same / cells, 3), "kappa": kappa, "eligibility_kappa": eligibility_kappa}


def screen_sessions(work):
    meta = Path(work) / "meta.json"
    return {k: v for k, v in (json.loads(meta.read_text()).get("sessions", {}) if meta.is_file() else {}).items() if SCREEN_KEY.fullmatch(k) and v.get("blocks")}


def pilot_sessions(work):
    meta = Path(work) / "meta.json"
    return {k: v for k, v in (json.loads(meta.read_text()).get("sessions", {}) if meta.is_file() else {}).items() if "-pilot-" in k}


def freeze(topic, repo, work, criteria, today, amendment=None):
    repo, work = Path(repo), Path(work)
    screened = sorted(p.name for p in work.glob("*-screen-[AB].jsonl")) + sorted(k for k in screen_sessions(work))
    if screened:
        raise TopicError(f"screen sessions already ran ({', '.join(screened[:4])}); the freeze is never rewritten once screening started")
    if not (repo / criteria).is_file():
        raise TopicError(f"no criteria file at {repo / criteria}")
    strata_names = screened_strata(topic)
    if not strata_names:
        raise TopicError(f"{topic['path']}: no stratum has channels, so none is screened")
    table_file = work / "mechanism-table.json"
    table = MechanismTable(json.loads(table_file.read_text()) if table_file.is_file() else EMPTY_TABLE)
    size, strata, ranks = pilot_rows(topic), {}, {}
    for stratum in strata_names:
        order = read_jsonl(work, f"{stratum}-screening-order.jsonl")
        if not order:
            raise TopicError(f"no {stratum}-screening-order.jsonl in {work}")
        packet = work / f"screening-packet-{stratum}.md"
        if not packet.is_file():
            raise TopicError(f"no {packet.name} in {work}; the protocol hash covers the criteria and the packet")
        if not (work / f"{stratum}-pilot-A.jsonl").is_file():
            raise TopicError(f"no {stratum}-pilot-A.jsonl in {work}; session A screens the pilot block first")
        ranks[stratum] = pilot_ranks(order, size)
        strata[stratum] = {"frozen_after_rank": ranks[stratum][-1], "pilot_rows": len(ranks[stratum]), "packet": packet.name,
                           "criteria_sha256": sha256_file(repo / criteria), "packet_sha256": sha256_file(packet), "template_sha256": template_sha256(criteria), "date": today}
    primary, fallback, also = session_b(topic)
    ran = [o for o in [primary, fallback, *also] if o and all((work / f"{s}-pilot-B-{o['model']}.jsonl").is_file() for s in strata)]
    if primary in ran:
        chosen, rule = primary, "the topic config's session B"
    elif fallback in ran:
        reasons = {b.get("fallback_reason") for k, e in pilot_sessions(work).items() if k.endswith(f"-pilot-B-{fallback['model']}") for b in e.get("blocks", [])}
        if None in reasons or not reasons:
            raise TopicError(f"the fallback {fallback['model']} screened the pilot without a recorded reason; run its pilot through run-screening-session.py")
        chosen, rule = fallback, "the topic config's fallback: " + "; ".join(sorted(reasons))
    else:
        raise TopicError(f"neither the configured session B {primary['model']} nor its fallback screened the pilot block of every stratum")
    pilot = {o["model"]: pilot_comparison([row for s in strata for row in pilot_pairs(work, s, f"{s}-pilot-B-{o['model']}.jsonl", ranks[s], table)]) for o in ran}
    sessions = pilot_sessions(work)
    pilot_packets = sorted({b["packet_sha256"] for entry in sessions.values() for b in entry.get("blocks", [])})
    pilot_criteria = sorted({b["criteria_sha256"] for entry in sessions.values() for b in entry.get("blocks", [])})
    changed = any((b["packet_sha256"], b["criteria_sha256"]) != (strata[s]["packet_sha256"], strata[s]["criteria_sha256"])
                  for s in strata for k, e in sessions.items() if k.startswith(f"{s}-") for b in e["blocks"])
    if changed and not amendment:
        raise TopicError("the packet or the criteria changed after the pilot; pass --amendment with what changed")
    versions = {e["cli"]: ", ".join(sorted({b["cli_version"] for k, x in sessions.items() if x["cli"] == e["cli"] for b in x["blocks"]})) for e in sessions.values()}
    return {"pilot_rows_configured": size, "criteria": criteria, "strata": strata, "session_a": session_a(topic),
            "session_b": {"chosen": chosen, "primary": primary, "rule": rule, "pilot": pilot, "note": "the pilot comparison is information only; agreement with A never picks B"},
            "cli_versions": versions, "isolation": {e["cli"]: e["isolation"] for e in sessions.values()},
            "amendment": {"pilot_packet_sha256": pilot_packets, "pilot_criteria_sha256": pilot_criteria, "changed": changed, "what": amendment if changed else "none: the pilot ran under the frozen packet"}}
