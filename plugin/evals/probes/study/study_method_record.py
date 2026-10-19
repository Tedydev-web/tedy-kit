import hashlib
import json

from study_agreement import CHAPMAN_NOTE, KAPPA_CRITERIA, RECALL_FIX, RECALL_TARGET, chapman, effort_stop, kappa_text, recall_at_cut, session_kappas
from study_calibration import CALIBRATED_STRATA, SAMPLE_FILE, calibration_agreement
from study_method_sessions import session_keys, session_lines
from study_protocol import FREEZE_FILE
from study_screening_core import JUDGED, MechanismTable, derive, read_json, read_jsonl
from study_session import NO_BARE_THREAT, model_family
from study_topic import TopicError

TAG_ONLY = ("tag-only inventory, not screened by two sessions: its rows carry tags, never copied text, so it has no protocol freeze, sessions, kappa, "
            "recall at the cut or stop row")
CAPTURE_KEYS = {"A", "B", "shared", "union", "chapman", "chapman_lower_bound", "chapman_note"}


def is_method_sweep(folder):
    return (folder / FREEZE_FILE).is_file()


def method_stops(topic, folder):
    table, stops, captures = MechanismTable(read_json(folder, "mechanism-table.json")), {}, {}
    session_keys(folder, topic["strata"])
    for stratum in topic["strata"]:
        mapping = read_json(folder, f"{stratum}-mechanism-map.json")
        sides = {s: {r["order_rank"]: r for r in read_jsonl(folder, f"{stratum}-screen-{s}.jsonl")} for s in "AB"}
        order = read_jsonl(folder, f"{stratum}-screening-order.jsonl")
        common = sorted(set(sides["A"]) & set(sides["B"]))
        mechs = {r: {s: derive(table, stratum, mapping, s, sides[s][r])["mechs"] for s in "AB"} for r in common}
        row, rule = effort_stop(common, {r: m["A"] | m["B"] for r, m in mechs.items()}, {r["order_rank"] for r in order if r.get("forced")}, [r["order_rank"] for r in order])
        if row is None:
            raise TopicError(f"{stratum}: the screening data reach no stop ({rule}); screen on before writing the record")
        written = topic["strata"][stratum].get("stop_row")
        if written != row:
            raise TopicError(f"{topic['path']}: strata.{stratum}.stop_row is {written}, the screening data stop at row {row} ({rule}); "
                             f"a hand-typed stop row is refused: run compare-screening-sessions.py --stratum {stratum} --write-stop")
        stops[stratum] = f"stop: {rule} at row {row}"
        captures[stratum] = chapman(set().union(*(m["A"] for m in mechs.values())), set().union(*(m["B"] for m in mechs.values())))
    return stops, captures


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def protocol_lines(repo, folder, strata, meta):
    freeze = read_json(folder, FREEZE_FILE)
    lines = []
    for stratum in strata:
        frozen = freeze["strata"].get(stratum)
        if frozen is None:
            raise TopicError(f"{folder / FREEZE_FILE} does not freeze the {stratum} stratum")
        if (sha256((repo / meta["criteria"]).read_bytes()), sha256((folder / frozen["packet"]).read_bytes())) != (frozen["criteria_sha256"], frozen["packet_sha256"]):
            raise TopicError(f"{stratum}: the criteria or {frozen['packet']} changed after the freeze")
        word = "row" if frozen["pilot_rows"] == 1 else "rows"
        lines.append(f"- {stratum}: frozen after row {frozen['frozen_after_rank']} (pilot block of {frozen['pilot_rows']} unforced {word}), criteria sha256 "
                     f"`{frozen['criteria_sha256']}`, packet sha256 `{frozen['packet_sha256']}` ({frozen['packet']}), {frozen['date']}")
    a, b = freeze["session_a"], freeze["session_b"]
    lines.append(f"- session A: {a['cli']} {a['model']}; session B: {b['chosen']['cli']} {b['chosen']['model']}, {b['rule']}")
    lines.append("- session B pilot, information only: " + "; ".join(f"{m} agreement {p['agreement']:.3f} on {p['rows']} rows" for m, p in b["pilot"].items()))
    amendment = freeze["amendment"]
    lines.append(f"- packet amendment at the freeze: {amendment['what']}" + ("; pilot packets sha256[:16] " + ", ".join(f"`{p[:16]}`" for p in amendment["pilot_packet_sha256"]) if amendment["changed"] else ""))
    lines.append("- isolation: " + "; ".join(f"{cli} {flags}" for cli, flags in sorted(freeze["isolation"].items())))
    lines.append("- CLI versions: " + ", ".join(f"{cli} {v}" for cli, v in sorted(freeze["cli_versions"].items())))
    return lines, freeze


def agreement_lines(stratum, pairs, after, capture, adjudicated):
    measured = [pairs[r] for r in sorted(pairs) if r > after]
    if not measured:
        raise TopicError(f"{stratum}: no screened row is ranked after the pilot block, which ends at row {after}")
    cells, cells_dated = len(measured) * len(KAPPA_CRITERIA), len(measured) * len(JUDGED)
    same = sum(a["scores"][c] == b["scores"][c] for a, b in measured for c in KAPPA_CRITERIA)
    same_dated = sum(a["scores"][c] == b["scores"][c] for a, b in measured for c in JUDGED)
    kappa, eligibility, differ = session_kappas([{"A": a, "B": b} for a, b in measured])
    extra = "".join(f"; {k} {v}" for k, v in adjudicated.items() if k not in CAPTURE_KEYS)
    return [f"- {stratum}: post-freeze rows {len(measured)} (ranked after the pilot block, which ends at row {after}): {same}/{cells} judged cells identical without the "
            f"computed Date ({same / cells:.3f}); with Date {same_dated}/{cells_dated} ({same_dated / cells_dated:.3f}); target 0.90 without Date",
            f"- {stratum} kappa: " + ", ".join(f"{c} {kappa_text(k)}" for c, k in kappa.items()) + f"; eligibility kappa {kappa_text(eligibility)} ({differ} of {len(measured)} "
            "decisions differ); Date is computed, not judged, and left out",
            f"- {stratum} capture-recapture over every row both sessions screened: A {capture['A']}, B {capture['B']}, shared {capture['shared']}, union {capture['union']}; "
            f"Chapman {capture['chapman_lower_bound']:.1f} is {CHAPMAN_NOTE}{extra}"]


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


def threat_lines(topic, strata, sessions, freeze, threats):
    for stratum in strata:
        a, b = sessions[f"{stratum}-A"]["model"], sessions[f"{stratum}-B"]["model"]
        if model_family(a) == model_family(b):
            threats.append(f"- same model family: {stratum} sessions A ({a}) and B ({b}) are both {model_family(a)} models, so their errors correlate and their agreement "
                           "shows consistency more than correctness")
    unbare = sorted(k for k, e in sessions.items() if NO_BARE_THREAT in (e.get("threats") or []))
    if unbare:
        threats.append(f"- {NO_BARE_THREAT}: {', '.join(unbare)} ran without --bare because no API-key auth source was set; settings, MCP servers, CLAUDE.md, "
                       "tools and session persistence were still excluded, but installed plugin hooks may have run")
    chosen = freeze["session_b"]
    if "fallback" in chosen["rule"]:
        threats.append(f"- session B fallback: {chosen['rule']}; B ran on {chosen['chosen']['model']}")
    threats.append(f"- session B fixed by the topic config ({chosen['chosen']['model']}), not chosen by agreement with A; the pilot comparison is information only")
    if any(topic["strata"][s].get("channels", {}).get("academic") for s in strata):
        threats.append("- academic papers logged, not screened: the academic channel adds only the repositories the papers name; the papers themselves are not scored")
    return threats


def method_parts(repo, topic, s, meta, captures):
    folder, strata = s["folder"], s["strata"]
    protocol, freeze = protocol_lines(repo, folder, strata, meta)
    sessions_out, sessions = session_lines(folder, meta, strata, freeze)
    agreement = [line for stratum in strata
                 for line in agreement_lines(stratum, s["pairs"][stratum], freeze["strata"][stratum]["frozen_after_rank"], captures[stratum], s["capture"][stratum])]
    calibration, threats = calibration_lines(folder)
    threats = threat_lines(topic, strata, sessions, freeze, threats)
    sections = ["## Protocol", ""] + protocol + ["", "## Screening sessions", ""] + sessions_out + ["", "## Calibration", ""] + calibration
    sections += ["", "## Threats", ""] + threats + [""]
    tag_only = [t for t in topic["strata"] if t not in strata]
    if tag_only:
        sections += ["## Tag-only strata", ""] + [f"- {t}: {TAG_ONLY}" for t in tag_only] + [""]
    return {"recall": recall_lines(folder, topic, strata) + [""], "agreement": agreement + [""], "sections": sections}
