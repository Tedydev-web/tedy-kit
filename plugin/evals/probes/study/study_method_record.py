import hashlib
import json

from study_agreement import CHAPMAN_NOTE, KAPPA_CRITERIA, RECALL_FIX, RECALL_TARGET, effort_stop, recall_at_cut, session_kappas
from study_calibration import CALIBRATED_STRATA, SAMPLE_FILE, calibration_agreement
from study_protocol import FREEZE_FILE
from study_screening_core import JUDGED, MechanismTable, derive, read_json, read_jsonl
from study_session import model_family
from study_topic import TopicError

SESSION_FIELDS = ("model", "effort", "packet_sha256", "date")
CAPTURE_KEYS = {"A", "B", "shared", "union", "chapman", "chapman_lower_bound", "chapman_note"}


def is_method_sweep(folder):
    return (folder / FREEZE_FILE).is_file()


def method_stops(topic, folder):
    table, stops = MechanismTable(read_json(folder, "mechanism-table.json")), {}
    for stratum in topic["strata"]:
        mapping = read_json(folder, f"{stratum}-mechanism-map.json")
        sides = {s: {r["order_rank"]: r for r in read_jsonl(folder, f"{stratum}-screen-{s}.jsonl")} for s in "AB"}
        order = read_jsonl(folder, f"{stratum}-screening-order.jsonl")
        common = sorted(set(sides["A"]) & set(sides["B"]))
        firsts = {r: derive(table, stratum, mapping, "A", sides["A"][r])["mechs"] | derive(table, stratum, mapping, "B", sides["B"][r])["mechs"] for r in common}
        row, rule = effort_stop(common, firsts, {r["order_rank"] for r in order if r.get("forced")}, [r["order_rank"] for r in order])
        if row is None:
            raise TopicError(f"{stratum}: the screening data reach no stop ({rule}); screen on before writing the record")
        written = topic["strata"][stratum].get("stop_row")
        if written != row:
            raise TopicError(f"{topic['path']}: strata.{stratum}.stop_row is {written}, the screening data stop at row {row} ({rule}); "
                             f"a hand-typed stop row is refused: run compare-screening-sessions.py --stratum {stratum} --write-stop")
        stops[stratum] = f"stop: {rule} at row {row}"
    return stops


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def protocol_lines(repo, folder, strata, meta):
    freeze = read_json(folder, FREEZE_FILE)
    criteria = (repo / meta["criteria"]).read_bytes()
    lines = []
    for stratum in strata:
        frozen = freeze["strata"].get(stratum)
        if frozen is None:
            raise TopicError(f"{folder / FREEZE_FILE} does not freeze the {stratum} stratum")
        if sha256(criteria + (folder / frozen["packet"]).read_bytes())[:16] != frozen["protocol_sha256"]:
            raise TopicError(f"{stratum}: the criteria or {frozen['packet']} changed after the freeze (protocol sha256[:16] {frozen['protocol_sha256']})")
        word = "row" if freeze["pilot_rows"] == 1 else "rows"
        lines.append(f"- {stratum}: frozen after row {frozen['frozen_after_rank']} (pilot block of {freeze['pilot_rows']} unforced {word}), protocol sha256[:16] "
                     f"`{frozen['protocol_sha256']}` over the criteria and {frozen['packet']}, {frozen['date']}")
    pilot = freeze["session_b"]["pilot"]
    lines.append("- session B pilot: " + "; ".join(f"{m} agreement {p['agreement']:.3f} on {p['rows']} rows" for m, p in pilot.items())
                 + f"; chosen {freeze['session_b']['chosen']['model']}")
    return lines, freeze


def session_lines(folder, meta):
    sessions = meta.get("sessions") or {}
    keys = [p.stem.replace("-screen-", "-") for p in sorted(folder.glob("*-screen-[AB].jsonl"))] + [p.stem for p in sorted(folder.glob("*-pilot-*.jsonl"))]
    lines = []
    for key in keys:
        entry = sessions.get(key)
        if not isinstance(entry, dict):
            raise TopicError(f"meta.json sessions.{key} is missing; run-screening-session.py records every session")
        for field in SESSION_FIELDS:
            if not entry.get(field):
                raise TopicError(f"meta.json sessions.{key} lacks {field}")
        packet = folder / f"screening-packet-{key.split('-', 1)[0]}.md"
        if not packet.is_file() or sha256(packet.read_bytes()) != entry["packet_sha256"]:
            raise TopicError(f"meta.json sessions.{key}: packet sha256 does not match {packet.name}")
        served = f"; served {', '.join(entry['served_models'])}" if entry.get("served_models") else ""
        inputs = f", inputs sha256[:16] `{entry['inputs_sha256'][:16]}`" if entry.get("inputs_sha256") else ""
        lines.append(f"- {key}: {entry.get('cli', '-')} {entry['model']}, effort {entry['effort']}, packet sha256[:16] `{entry['packet_sha256'][:16]}`, {entry['date']}{inputs}{served}")
    return lines, sessions


def agreement_lines(stratum, pairs, after, capture):
    measured = [pairs[r] for r in sorted(pairs) if r > after]
    if not measured:
        raise TopicError(f"{stratum}: no screened row lies after the freeze at row {after}")
    cells = len(measured) * len(JUDGED)
    same = sum(a["scores"][c] == b["scores"][c] for a, b in measured for c in JUDGED)
    kappa, eligibility, differ = session_kappas([{"A": a, "B": b} for a, b in measured])
    mech = {s: set().union(*(pair[i]["mechs"] for pair in pairs.values())) for i, s in enumerate("AB")}
    shared, union = len(mech["A"] & mech["B"]), len(mech["A"] | mech["B"])
    chapman = (len(mech["A"]) + 1) * (len(mech["B"]) + 1) / (shared + 1) - 1
    extra = "".join(f"; {k} {v}" for k, v in capture.items() if k not in CAPTURE_KEYS)
    return [f"- {stratum}: post-freeze rows {len(measured)} (rows up to {after} left out as the pilot): {same}/{cells} judged cells identical ({same / cells:.3f}); target 0.90",
            f"- {stratum} kappa: " + ", ".join(f"{c} {k:.3f}" for c, k in kappa.items()) + f"; eligibility kappa {eligibility:.3f} ({differ} of {len(measured)} decisions differ); "
            "Date is computed, not judged, and left out",
            f"- {stratum} capture-recapture: A {len(mech['A'])}, B {len(mech['B'])}, shared {shared}, union {union}; Chapman {chapman:.1f} is {CHAPMAN_NOTE}{extra}"]


def recall_lines(folder, topic, strata):
    lines = []
    for stratum in [s for s in CALIBRATED_STRATA if s in strata]:
        out = recall_at_cut(stratum, read_json(folder, f"{stratum}-qgs-adjudicated.json")["final"], read_jsonl(folder, f"{stratum}-screening-order.jsonl"),
                            topic["strata"][stratum]["stop_row"])
        head = f"- {stratum}: recall at the cut {out['at_cut']}/{out['size']} ({out['recall']:.3f}) of the {stratum} standard; "
        missed = ", ".join(f"{m['repo']} (rank {m['rank']})" if m["rank"] else f"{m['repo']} (not in the screening order)" for m in out["missed"])
        lines.append(head + (f"below the {RECALL_TARGET:.2f} target: {RECALL_FIX}; missed: {missed}" if out["below_target"] else f"meets the {RECALL_TARGET:.2f} target"))
    return lines


def calibration_lines(folder):
    path = folder / SAMPLE_FILE
    if not path.is_file():
        return ["- not rated: see the LLM-only screening threat"], ["- LLM-only screening: no calibration sample was drawn, so no human rating checks the sessions"]
    out = calibration_agreement(json.loads(path.read_text()), folder)
    if "scored_of" in out:
        return ["- not rated: see the LLM-only screening threat"], [f"- LLM-only screening: the calibration sample is rated on {out['rows']} of {out['scored_of']} rows"]
    cells = out["rows"] * len(KAPPA_CRITERIA)
    return ["- " + "; ".join(f"user vs session {s}: decisions {out[s]['decisions']}/{out['rows']}, judged cells {out[s]['cells']}/{cells}" for s in "AB")], []


def method_parts(repo, topic, s, meta):
    folder, strata = s["folder"], s["strata"]
    protocol, freeze = protocol_lines(repo, folder, strata, meta)
    sessions_out, sessions = session_lines(folder, meta)
    agreement = [line for stratum in strata for line in agreement_lines(stratum, s["pairs"][stratum], freeze["strata"][stratum]["frozen_after_rank"], s["capture"][stratum])]
    calibration, threats = calibration_lines(folder)
    for stratum in strata:
        a, b = sessions.get(f"{stratum}-A", {}).get("model"), sessions.get(f"{stratum}-B", {}).get("model")
        if a and b and model_family(a) == model_family(b):
            threats.append(f"- same model family: {stratum} sessions A ({a}) and B ({b}) are both {model_family(a)} models, so their errors correlate and their agreement "
                           "shows consistency more than correctness")
    sections = ["## Protocol", ""] + protocol + ["", "## Screening sessions", ""] + sessions_out + ["", "## Calibration", ""] + calibration
    sections += ["", "## Threats", ""] + (threats or ["- none beyond the gaps below"]) + [""]
    return {"recall": recall_lines(folder, topic, strata) + [""], "agreement": agreement + [""], "sections": sections}
